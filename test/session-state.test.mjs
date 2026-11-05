import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { build } from 'esbuild';

const require = createRequire(import.meta.url);
const directory = await mkdtemp(join(tmpdir(), 'agent-sessions-state-test-'));
process.env.HOME = directory;
const bundle = join(directory, 'claude.cjs');
await build({ stdin: { contents: `export * from './src/claude.ts';`, resolveDir: process.cwd() }, bundle: true, platform: 'node', format: 'cjs', outfile: bundle, external: ['vscode', 'node:sqlite'] });
const { listClaudeSessions } = require(bundle);
after(() => rm(directory, { recursive: true, force: true }));

const user = (text, at) => JSON.stringify({ type: 'user', uuid: `u-${at}`, timestamp: at, cwd: '/tmp/work', message: { role: 'user', content: [{ type: 'text', text }] } });

/** An idle live process (this test's own pid, so it counts as alive) on a transcript ending in `lines`. */
async function idleSession(id, lines) {
  const home = join(directory, id);
  await mkdir(join(home, 'projects', '-tmp-work'), { recursive: true });
  await mkdir(join(home, 'sessions'), { recursive: true });
  await writeFile(join(home, 'projects', '-tmp-work', `${id}.jsonl`), lines.join('\n') + '\n');
  await writeFile(join(home, 'sessions', `${process.pid}.json`), JSON.stringify({ pid: process.pid, sessionId: id, cwd: '/tmp/work', status: 'idle' }));
  return (await listClaudeSessions(home)).find((s) => s.id === id);
}

test('an idle session whose turn was interrupted has replied, not still running', async () => {
  const session = await idleSession('11111111-2222-4333-8444-000000000001', [
    user('do the thing', '2026-09-01T10:00:00Z'),
    user('[Request interrupted by user]', '2026-09-01T10:00:05Z'),
  ]);
  assert.equal(session?.state, 'replied', 'an interruption ends the turn even though it is a user-role record');
});

test('an idle session whose last record is a prompt is still running', async () => {
  const session = await idleSession('11111111-2222-4333-8444-000000000002', [user('do the thing', '2026-09-01T10:00:00Z')]);
  assert.equal(session?.state, 'running', 'a prompt the process has not picked up yet is not a reply');
});

/** A live session whose process file carries `live` beyond the basics, as a `claude --bg` job's does. */
async function liveSession(id, live) {
  const home = join(directory, id);
  await mkdir(join(home, 'projects', '-tmp-work'), { recursive: true });
  await mkdir(join(home, 'sessions'), { recursive: true });
  await writeFile(join(home, 'projects', '-tmp-work', `${id}.jsonl`), user('do the thing', '2026-09-01T10:00:00Z') + '\n');
  await writeFile(join(home, 'sessions', `${process.pid}.json`), JSON.stringify({ pid: process.pid, sessionId: id, cwd: '/tmp/work', status: 'busy', ...live }));
  return (await listClaudeSessions(home)).find((s) => s.id === id);
}

test('a session a background job holds carries the job id that attach and stop take', async () => {
  const bg = await liveSession('11111111-2222-4333-8444-000000000003', { kind: 'bg', jobId: '800be93a' });
  assert.equal(bg?.backgroundJob, '800be93a', 'Claude refuses --resume for a running background job, so opening it needs the job');
  const interactive = await liveSession('11111111-2222-4333-8444-000000000004', { kind: 'interactive', jobId: 'ffffffff' });
  assert.equal(interactive?.backgroundJob, undefined, 'only a background job is held away from --resume');
});
