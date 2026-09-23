import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { build } from 'esbuild';

const require = createRequire(import.meta.url);
const directory = await mkdtemp(join(tmpdir(), 'agent-sessions-worktree-test-'));
const bundle = join(directory, 'claude.cjs');
await build({ stdin: { contents: `export * from './src/claude.ts';`, resolveDir: process.cwd() }, bundle: true, platform: 'node', format: 'cjs', outfile: bundle, external: ['vscode', 'node:sqlite'] });
const { listClaudeSessions } = require(bundle);
after(() => rm(directory, { recursive: true, force: true }));

const main = join(directory, 'repo');
const linked = join(directory, 'repo-feature');
const scratch = join(directory, 'scratch');
const git = (...args) => execFileSync('git', ['-C', main, ...args], { stdio: 'ignore' });
await mkdir(main, { recursive: true });
await mkdir(scratch, { recursive: true });
git('init', '-q');
git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'init');
git('worktree', 'add', '-q', '-b', 'feature', linked);

let n = 0;
const at = () => `2026-09-01T10:${String(n++).padStart(2, '0')}:00Z`;
const prompt = () => JSON.stringify({ type: 'user', timestamp: at(), cwd: main, gitBranch: 'main', message: { role: 'user', content: 'work' } });
const call = (name, input) => JSON.stringify({ type: 'assistant', timestamp: at(), cwd: main, gitBranch: 'main', message: { role: 'assistant', content: [{ type: 'tool_use', id: `t${n}`, name, input }] } });

async function sessionOf(id, lines) {
  const project = join(directory, 'claude', 'projects', '-repo');
  await mkdir(project, { recursive: true });
  await writeFile(join(project, `${id}.jsonl`), [prompt(), ...lines].join('\n') + '\n');
  return (await listClaudeSessions(join(directory, 'claude'))).find((s) => s.id === id);
}

test('a session working in a worktree by absolute path from the main checkout is bound to that worktree', async () => {
  const s = await sessionOf('a0000000-0000-4000-8000-000000000001', [call('Edit', { file_path: join(linked, 'src', 'x.ts') }), call('Bash', { command: `cd ${scratch} && ls` })]);
  assert.equal(s.worktree?.path, linked, 'an edited file places the session in its worktree, and a later cd outside any repository does not move it');
  assert.equal(s.worktree?.branch, undefined, 'the recorded branch is the main checkout’s, so it does not name the worktree');
});

test('the last repository a session addresses wins, including going back to the main checkout', async () => {
  const s = await sessionOf('a0000000-0000-4000-8000-000000000002', [call('Bash', { command: `git -C ${linked} status` }), call('Bash', { command: `cd ${main} && git log` })]);
  assert.equal(s.worktree, undefined, 'a session that returned to the main checkout has no linked worktree');
});

test('reading a worktree’s files does not move a session into it', async () => {
  const s = await sessionOf('a0000000-0000-4000-8000-000000000003', [call('Read', { file_path: join(linked, 'README.md') })]);
  assert.equal(s.worktree, undefined, 'only edits and shell directories count as working somewhere');
});
