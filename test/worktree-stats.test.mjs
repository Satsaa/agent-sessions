import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { build } from 'esbuild';

const require = createRequire(import.meta.url);
const directory = await mkdtemp(join(tmpdir(), 'agent-sessions-stats-test-'));
const bundle = join(directory, 'worktree.cjs');
await build({ entryPoints: ['src/worktree.ts'], bundle: true, platform: 'node', format: 'cjs', outfile: bundle });
const { loadWorktreeStats } = require(bundle);
after(() => rm(directory, { recursive: true, force: true }));

const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args]);

test('an idle worktree’s stats are recomputed when git’s metadata moves, a live one’s on every expiry', async (t) => {
  const repo = join(directory, 'repo');
  git(directory, 'init', '-q', repo);
  await writeFile(join(repo, 'a.txt'), 'one\n');
  git(repo, 'add', 'a.txt');
  git(repo, 'commit', '-qm', 'first');
  const wt = { path: repo, name: 'repo', branch: undefined, repoRoot: repo };
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  const unstaged = async (live) => (await loadWorktreeStats([wt], new Set([repo]), live ? new Set([repo]) : new Set())).get(repo).unstaged;

  assert.equal(await unstaged(false), 0);
  await writeFile(join(repo, 'a.txt'), 'two\n');
  now += 11_000;
  assert.equal(await unstaged(false), 0, 'an edit git has not seen does not cost a recompute of an idle worktree');
  assert.equal(await unstaged(true), 1, 'a worktree a live session works in is recomputed once its stats expire');

  git(repo, 'add', 'a.txt');
  now += 11_000;
  const staged = (await loadWorktreeStats([wt], new Set([repo]))).get(repo).staged;
  assert.equal(staged, 1, 'staging rewrites the index, so an idle worktree is recomputed');

  await writeFile(join(repo, 'b.txt'), 'new\n');
  now += 5 * 60_000;
  assert.equal((await loadWorktreeStats([wt], new Set([repo]))).get(repo).untracked, 1, 'every worktree is recomputed at least every five minutes');
});
