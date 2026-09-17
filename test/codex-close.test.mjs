import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { build } from 'esbuild';

const require = createRequire(import.meta.url);
const fs = require('node:fs/promises');
const directory = await mkdtemp(join(tmpdir(), 'agent-sessions-close-test-'));
const bundle = join(directory, 'close.cjs');
await build({ stdin: { contents: `export * from './src/codex-close.ts'; export * from './src/codex.ts';`, resolveDir: process.cwd() }, bundle: true, platform: 'node', format: 'cjs', outfile: bundle });
const { codexOwner, stopCodexOwner, listCodexSessions } = require(bundle);
after(() => rm(directory, { recursive: true, force: true }));
const home = '/fixture';

function fixture(t) {
  const state = { pid: 12345, start: '100', exe: '/usr/bin/codex', locks: ['one', 'two'], locked: true, signals: [] };
  t.mock.method(fs, 'readdir', async file => {
    if (file === '/proc') return [String(state.pid)];
    if (file === `/proc/${state.pid}/fd`) return state.locks.map((_, i) => String(i));
    throw new Error(`Unexpected readdir: ${file}`);
  });
  t.mock.method(fs, 'readlink', async file => {
    if (file.endsWith('/exe')) return state.exe;
    const fd = Number(file.split('/').at(-1));
    return `${home}/thread-writer-locks/${state.locks[fd]}.lock`;
  });
  t.mock.method(fs, 'readFile', async file => {
    if (file.endsWith('/stat')) return `${state.pid} (codex worker) ${[...Array(19).fill('0'), state.start].join(' ')}`;
    if (file.includes('/fdinfo/')) return state.locked ? `lock:\t1: FLOCK  ADVISORY  WRITE ${state.pid} 09:02:123 0 EOF\n` : 'pos: 0\n';
    throw new Error(`Unexpected readFile: ${file}`);
  });
  t.mock.method(process, 'kill', (pid, signal) => { state.signals.push([pid, signal]); state.locks = []; return true; });
  return state;
}

test('close rechecks ownership and signals only the approved Codex writer', { skip: process.platform !== 'linux' }, async t => {
  const state = fixture(t);
  const owner = await codexOwner(home, 'one');
  assert.deepEqual(owner.threadIds, ['one', 'two']);
  await stopCodexOwner(home, 'one', owner);
  assert.deepEqual(state.signals, [[state.pid, 'SIGTERM']]);
});

test('an open lock file without a kernel writer lock is not ownership', { skip: process.platform !== 'linux' }, async t => {
  const state = fixture(t);
  state.locked = false;
  assert.equal(await codexOwner(home, 'one'), undefined);
  assert.equal(state.signals.length, 0);
});

test('a non-Codex process cannot be stopped even if it holds a file in the lock directory', { skip: process.platform !== 'linux' }, async t => {
  const state = fixture(t);
  state.exe = '/usr/bin/bash';
  assert.equal(await codexOwner(home, 'one'), undefined);
});

for (const change of ['pid', 'start', 'siblings']) {
  test(`close refuses changed ${change} after confirmation`, { skip: process.platform !== 'linux' }, async t => {
    const state = fixture(t);
    const approved = await codexOwner(home, 'one');
    if (change === 'pid') state.pid++;
    if (change === 'start') state.start = '200';
    if (change === 'siblings') state.locks.push('three');
    await assert.rejects(stopCodexOwner(home, 'one', approved), /changed/);
    assert.equal(state.signals.length, 0);
  });
}

test('an already released session does not signal the old owner', { skip: process.platform !== 'linux' }, async t => {
  const state = fixture(t);
  const approved = await codexOwner(home, 'one');
  state.locks = [];
  await stopCodexOwner(home, 'one', approved);
  assert.equal(state.signals.length, 0);
});

test('leftover unlocked files do not leave sessions in Active after their process exits', { skip: process.platform !== 'linux' }, async () => {
  const home = join(directory, 'home');
  await mkdir(join(home, 'thread-writer-locks'), { recursive: true });
  await mkdir(join(home, 'sessions'));
  await writeFile(join(home, 'thread-writer-locks', 'stale.lock'), '');
  await writeFile(join(home, 'sessions', 'rollout-test.jsonl'), JSON.stringify({ type: 'session_meta', payload: { id: 'stale' } }) + '\n');
  const sessions = await listCodexSessions(home);
  assert.equal(sessions[0].state, 'stopped');
});
