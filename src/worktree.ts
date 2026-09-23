import { execFile } from 'node:child_process';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import type { Session, Worktree } from './types.js';
import { expandHome, repoRootOf, statOrUndefined, worktreeTopOf } from './util.js';

/** Build the worktree record for a session that only knows where it ran (Codex, or Claude sessions started inside a worktree). */
export function worktreeFromCwd(cwd: string | undefined, branch: string | undefined): Worktree | undefined {
  const top = worktreeTopOf(cwd);
  if (!top) return undefined;
  return { path: top, name: path.basename(top), branch, repoRoot: repoRootOf(top) };
}

const DIR_REF = /"workdir"\s*:\s*"([^"]+)"|\bcd\s+["']?(~?\/[^\s;&|"'`)\\]+)|\bgit\s+-C\s+["']?(~?\/[^\s;&|"'`)\\]+)/g;

/**
 * The directories a command addresses, in order: a Codex exec call's `workdir`, `cd <dir>` and `git -C <dir>`.
 * Agents keep their shell in the directory they started in and reach a worktree through these, so they say
 * where the work is going on better than the cwd a transcript records.
 */
export function commandDirs(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(DIR_REF)) {
    const dir = m[1] ?? m[2] ?? m[3];
    if (dir) out.push(path.resolve(expandHome(dir)));
  }
  return out;
}

/** A directory counts as a place the agent works only inside a git repository; scratch and temp folders say nothing. */
export function inRepository(dir: string): boolean {
  return repoRootOf(dir) !== undefined;
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
  /** Lines added / removed across staged, unstaged and untracked changes (`git diff HEAD --numstat` plus untracked file lengths). */
  insertions: number | undefined;
  deletions: number | undefined;
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

async function untrackedLines(root: string, paths: string[]): Promise<number> {
  let total = 0;
  await Promise.all(
    paths.slice(0, 200).map(async (rel) => {
      const full = path.join(root, rel);
      const st = await statOrUndefined(full);
      if (!st?.isFile() || st.size > 4 * 1024 * 1024) return;
      try {
        const buf = await fsp.readFile(full);
        if (buf.includes(0)) return; // binary
        let n = 0;
        for (const b of buf) if (b === 10) n++;
        if (buf.length && buf[buf.length - 1] !== 10) n++;
        total += n;
      } catch {
        // unreadable: skip
      }
    }),
  );
  return total;
}

/** 900 → `900`, 1000 → `1k`, 1500 → `1.5k`, 21746 → `21.7k`, 2_000_000 → `2m`. */
export function compactCount(n: number): string {
  const unit = (v: number, suffix: string) => {
    const rounded = Math.round(v * 10) / 10;
    return `${rounded >= 100 ? Math.round(rounded) : rounded}${suffix}`;
  };
  if (n >= 1_000_000) return unit(n / 1_000_000, 'm');
  if (n >= 1000) return unit(n / 1000, 'k');
  return String(n);
}

/** `↑a ↓b +i −d`, each omitted when zero; empty for a clean, level worktree. */
export function statsInline(stats: WorktreeStats): string {
  const bits: string[] = [];
  if (stats.commitsAhead) bits.push(`↑${stats.commitsAhead}`);
  if (stats.commitsBehind) bits.push(`↓${stats.commitsBehind}`);
  if (stats.insertions) bits.push(`+${compactCount(stats.insertions)}`);
  if (stats.deletions) bits.push(`−${compactCount(stats.deletions)}`);
  return bits.join(' ');
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
    insertions: undefined,
    deletions: undefined,
    branch: wt.branch,
    gone: false,
    asOf,
  };
  if (!(await statOrUndefined(wt.path))?.isDirectory()) return { ...empty, gone: true };

  const [status, numstat, branchOut, base] = await Promise.all([
    git(wt.path, ['status', '--porcelain=v1', '--untracked-files=normal']),
    git(wt.path, ['diff', 'HEAD', '--numstat', '--no-renames']),
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
    if (numstat !== undefined) {
      let ins = 0;
      let del = 0;
      for (const line of numstat.split('\n')) {
        const m = /^(\d+|-)\t(\d+|-)\t/.exec(line);
        if (!m) continue;
        if (m[1] !== '-') ins += Number(m[1]);
        if (m[2] !== '-') del += Number(m[2]);
      }
      // An untracked file is all insertions; count its lines the way `git add -N` would show them.
      const untrackedPaths = status
        .split('\n')
        .filter((l) => l.startsWith('?? '))
        .map((l) => l.slice(3).replace(/^"(.*)"$/, '$1'));
      ins += await untrackedLines(wt.path, untrackedPaths);
      out.insertions = ins;
      out.deletions = del;
    }
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
