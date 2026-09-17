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
  /** Commits on HEAD that the base does not have. */
  commitsAhead: number | undefined;
  /** Commits on the base that HEAD does not have. */
  commitsBehind: number | undefined;
  /** What ahead/behind are measured against. */
  base: string | undefined;
  /** Modified, added, deleted and untracked paths (`git status --porcelain` lines). */
  changedFiles: number | undefined;
  staged: number | undefined;
  unstaged: number | undefined;
  untracked: number | undefined;
  /** Branch checked out right now. */
  branch: string | undefined;
  /** The directory no longer exists. */
  gone: boolean;
  asOf: number;
}

const TTL_MS = 10_000;
const statsCache = new Map<string, WorktreeStats>();

function git(cwd: string, args: string[]): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile('git', ['-C', cwd, ...args], { timeout: 5000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
      resolve(err ? undefined : stdout);
    });
  });
}

function parseCount(out: string | undefined): number | undefined {
  const n = out === undefined ? NaN : Number.parseInt(out.trim(), 10);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * The ref to measure a worktree against: its upstream when it has one, else the remote's default
 * branch, else (for a linked worktree) the main checkout's HEAD.
 */
async function baseRef(wt: Worktree, isMain: boolean): Promise<string | undefined> {
  if ((await git(wt.path, ['rev-parse', '--verify', '--quiet', '@{upstream}'])) !== undefined) {
    return (await git(wt.path, ['rev-parse', '--abbrev-ref', '@{upstream}']))?.trim() || '@{upstream}';
  }
  const originHead = (await git(wt.path, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD']))?.trim();
  if (originHead) return originHead;
  if (!isMain && wt.repoRoot) {
    const main = (await git(wt.repoRoot, ['rev-parse', 'HEAD']))?.trim();
    if (main) return main;
  }
  return undefined;
}

async function computeStats(wt: Worktree, isMain: boolean): Promise<WorktreeStats> {
  const asOf = Date.now();
  const empty: WorktreeStats = {
    commitsAhead: undefined,
    commitsBehind: undefined,
    base: undefined,
    changedFiles: undefined,
    staged: undefined,
    unstaged: undefined,
    untracked: undefined,
    branch: wt.branch,
    gone: false,
    asOf,
  };
  if (!(await statOrUndefined(wt.path))?.isDirectory()) return { ...empty, gone: true };

  const [status, branchOut, base] = await Promise.all([
    git(wt.path, ['status', '--porcelain=v1', '--untracked-files=normal']),
    git(wt.path, ['rev-parse', '--abbrev-ref', 'HEAD']),
    baseRef(wt, isMain),
  ]);
  const out = { ...empty };
  if (status !== undefined) {
    let staged = 0;
    let unstaged = 0;
    let untracked = 0;
    for (const line of status.split('\n')) {
      if (line.length < 2) continue;
      const x = line[0];
      const y = line[1];
      if (x === '?' && y === '?') untracked++;
      else {
        if (x !== ' ' && x !== '!') staged++;
        if (y !== ' ' && y !== '!') unstaged++;
      }
    }
    out.staged = staged;
    out.unstaged = unstaged;
    out.untracked = untracked;
    out.changedFiles = status.split('\n').filter((l) => l.length > 0).length;
  }
  const branch = branchOut?.trim();
  out.branch = branch && branch !== 'HEAD' ? branch : wt.branch;
  if (base) {
    out.base = base.length === 40 && /^[0-9a-f]+$/.test(base) ? `main checkout (${base.slice(0, 7)})` : base;
    const lr = await git(wt.path, ['rev-list', '--left-right', '--count', `HEAD...${base}`]);
    const m = lr ? /^(\d+)\s+(\d+)/.exec(lr.trim()) : null;
    if (m) {
      out.commitsAhead = parseCount(m[1]);
      out.commitsBehind = parseCount(m[2]);
    }
  }
  return out;
}

/**
 * Refresh git stats for the given worktrees (deduplicated by path). Results are cached briefly, since the
 * same worktree appears on several sessions and refreshes come every few seconds.
 */
export async function loadWorktreeStats(worktrees: Iterable<Worktree>, mainCheckouts: ReadonlySet<string> = new Set(), force = false): Promise<Map<string, WorktreeStats>> {
  const distinct = new Map<string, Worktree>();
  for (const wt of worktrees) distinct.set(wt.path, wt);
  const now = Date.now();
  await Promise.all(
    [...distinct.values()].map(async (wt) => {
      const cached = statsCache.get(wt.path);
      if (!force && cached && now - cached.asOf < TTL_MS) return;
      statsCache.set(wt.path, await computeStats(wt, mainCheckouts.has(wt.path)));
    }),
  );
  const out = new Map<string, WorktreeStats>();
  for (const p of distinct.keys()) {
    const st = statsCache.get(p);
    if (st) out.set(p, st);
  }
  return out;
}

export function sessionWorktrees(sessions: Session[]): Worktree[] {
  return sessions.flatMap((s) => (s.worktree ? [s.worktree] : []));
}

// ---------------------------------------------------------------- every worktree of a repository

export interface RepoWorktree extends Worktree {
  repoRoot: string;
  /** The main checkout itself, listed so sessions working there have a row too. */
  isMain: boolean;
  head: string | undefined;
  detached: boolean;
  locked: string | undefined;
  prunable: string | undefined;
}

/** `git worktree list --porcelain` for one repository, main checkout first. */
export async function listRepoWorktrees(repoRoot: string): Promise<RepoWorktree[]> {
  const out = await git(repoRoot, ['worktree', 'list', '--porcelain']);
  if (out === undefined) return [];
  const result: RepoWorktree[] = [];
  let cur: RepoWorktree | undefined;
  const flush = () => {
    if (cur) result.push(cur);
    cur = undefined;
  };
  for (const raw of out.split('\n')) {
    const line = raw.trimEnd();
    if (!line) {
      flush();
      continue;
    }
    const sp = line.indexOf(' ');
    const key = sp < 0 ? line : line.slice(0, sp);
    const value = sp < 0 ? '' : line.slice(sp + 1);
    if (key === 'worktree') {
      flush();
      const p = path.resolve(value);
      cur = { path: p, name: path.basename(p), branch: undefined, repoRoot, isMain: result.length === 0, head: undefined, detached: false, locked: undefined, prunable: undefined };
    } else if (!cur) continue;
    else if (key === 'HEAD') cur.head = value;
    else if (key === 'branch') cur.branch = value.replace(/^refs\/heads\//, '');
    else if (key === 'detached') cur.detached = true;
    else if (key === 'locked') cur.locked = value || 'locked';
    else if (key === 'prunable') cur.prunable = value || 'prunable';
  }
  flush();
  // The first entry is the main checkout; make sure its root matches the repo root we asked about.
  for (const wt of result) wt.isMain = path.resolve(wt.path) === path.resolve(repoRoot);
  return result;
}
