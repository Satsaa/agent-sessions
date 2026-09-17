import { execFile } from 'node:child_process';
import * as path from 'node:path';
import type { Session, Worktree } from './types.js';
import { repoRootOf, statOrUndefined, worktreeTopOf } from './util.js';

/** Build the worktree record for a session that only knows where it ran (Codex, or Claude sessions started inside a worktree). */
export function worktreeFromCwd(cwd: string | undefined, branch: string | undefined): Worktree | undefined {
  const top = worktreeTopOf(cwd);
  if (!top) return undefined;
  return { path: top, name: path.basename(top), branch, repoRoot: repoRootOf(top) };
}

/** Build the worktree record from an explicit path the tool recorded (Claude's `worktree-state`). */
export function worktreeFromPath(wtPath: string, name: string | undefined, branch: string | undefined): Worktree {
  const top = path.resolve(wtPath);
  return { path: top, name: name ?? path.basename(top), branch, repoRoot: repoRootOf(top) };
}

export interface WorktreeStats {
  /** Commits on the worktree's HEAD that its base does not have. */
  commitsAhead: number | undefined;
  /** What `commitsAhead` is measured against: the branch's upstream when it has one, else the main checkout's HEAD. */
  aheadOf: 'upstream' | 'main checkout' | undefined;
  /** Modified, added, deleted and untracked paths (`git status --porcelain` lines). */
  changedFiles: number | undefined;
  /** Branch checked out in the worktree right now. */
  branch: string | undefined;
  /** The worktree directory no longer exists. */
  gone: boolean;
  asOf: number;
}

const TTL_MS = 10_000;
const statsCache = new Map<string, WorktreeStats>();

function git(cwd: string, args: string[]): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile('git', ['-C', cwd, ...args], { timeout: 5000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
      resolve(err ? undefined : stdout);
    });
  });
}

async function computeStats(wt: Worktree): Promise<WorktreeStats> {
  const asOf = Date.now();
  if (!(await statOrUndefined(wt.path))?.isDirectory()) {
    return { commitsAhead: undefined, aheadOf: undefined, changedFiles: undefined, branch: wt.branch, gone: true, asOf };
  }
  const [status, branchOut, mainHead] = await Promise.all([
    git(wt.path, ['status', '--porcelain', '--untracked-files=normal']),
    git(wt.path, ['rev-parse', '--abbrev-ref', 'HEAD']),
    wt.repoRoot ? git(wt.repoRoot, ['rev-parse', 'HEAD']) : Promise.resolve(undefined),
  ]);
  const changedFiles = status === undefined ? undefined : status.split('\n').filter((l) => l.length > 0).length;
  const branch = branchOut?.trim() || wt.branch;
  let commitsAhead: number | undefined;
  let aheadOf: WorktreeStats['aheadOf'];
  const parse = (out: string | undefined) => {
    const n = out === undefined ? NaN : Number.parseInt(out.trim(), 10);
    return Number.isFinite(n) ? n : undefined;
  };
  // Unpushed work is the useful count; a branch with no upstream is measured against the main checkout instead.
  commitsAhead = parse(await git(wt.path, ['rev-list', '--count', '@{upstream}..HEAD']));
  if (commitsAhead !== undefined) aheadOf = 'upstream';
  else {
    const main = mainHead?.trim();
    if (main) commitsAhead = parse(await git(wt.path, ['rev-list', '--count', `${main}..HEAD`]));
    if (commitsAhead !== undefined) aheadOf = 'main checkout';
  }
  return { commitsAhead, aheadOf, changedFiles, branch: branch === 'HEAD' ? wt.branch : branch, gone: false, asOf };
}

/**
 * Refresh git stats for every distinct worktree among the given sessions.
 * Results are cached briefly, since the same worktree appears on several sessions and refreshes come every few seconds.
 */
export async function loadWorktreeStats(sessions: Session[], force = false): Promise<Map<string, WorktreeStats>> {
  const distinct = new Map<string, Worktree>();
  for (const s of sessions) if (s.worktree) distinct.set(s.worktree.path, s.worktree);
  const now = Date.now();
  await Promise.all(
    [...distinct.values()].map(async (wt) => {
      const cached = statsCache.get(wt.path);
      if (!force && cached && now - cached.asOf < TTL_MS) return;
      statsCache.set(wt.path, await computeStats(wt));
    }),
  );
  const out = new Map<string, WorktreeStats>();
  for (const p of distinct.keys()) {
    const st = statsCache.get(p);
    if (st) out.set(p, st);
  }
  return out;
}
