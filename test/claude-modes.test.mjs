import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import { mkdtemp, rm, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { build } from 'esbuild';

const require = createRequire(import.meta.url);
const directory = await mkdtemp(join(tmpdir(), 'agent-sessions-modes-test-'));
process.env.HOME = directory;
const bundle = join(directory, 'modes.cjs');
await build({
  stdin: { contents: `export * from './src/claude-modes.ts'; export { listClaudeSessions } from './src/claude.ts';`, resolveDir: process.cwd() },
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outfile: bundle,
  external: ['vscode', 'node:sqlite'],
});
const { claudeModeStore, seedSessionMode, listClaudeSessions } = require(bundle);
after(() => rm(directory, { recursive: true, force: true }));

const ID = '11111111-2222-4333-8444-000000000001';
const readStored = async (store) => JSON.parse(await readFile(join(store, `${ID}.json`), 'utf8'));

test("the store is Claude Code's, beside this extension's global storage", () => {
  assert.equal(
    claudeModeStore('/data/User/globalStorage/satsaa.agent-sessions'),
    '/data/User/globalStorage/anthropic.claude-code/session-permission-modes',
    'Claude Code re-reads this directory when it lists sessions; any other path is never read',
  );
});

test('a window with no recorded mode takes the one the last prompt ran in', async () => {
  const store = join(directory, 'empty');
  assert.equal(await seedSessionMode(store, ID, { mode: 'bypassPermissions', at: 1000 }, 5000), true);
  assert.deepEqual(await readStored(store), { mode: 'bypassPermissions', updatedAt: 5000 }, 'stamped now so the panel neither ages it out nor ranks it behind its own older writes');
});

test("a choice this window made after the last prompt is kept", async () => {
  const store = join(directory, 'chosen');
  await mkdir(store, { recursive: true });
  await writeFile(join(store, `${ID}.json`), JSON.stringify({ mode: 'plan', updatedAt: 2000 }));
  assert.equal(await seedSessionMode(store, ID, { mode: 'bypassPermissions', at: 1000 }, 5000), false);
  assert.equal((await readStored(store)).mode, 'plan', 'a mode picked in this window since the last prompt outranks the transcript');
});

test('a mode this window recorded before a later prompt elsewhere is replaced', async () => {
  const store = join(directory, 'stale');
  await mkdir(store, { recursive: true });
  await writeFile(join(store, `${ID}.json`), JSON.stringify({ mode: 'default', updatedAt: 1000 }));
  await seedSessionMode(store, ID, { mode: 'auto', at: 2000 }, 5000);
  assert.equal((await readStored(store)).mode, 'auto', 'the session ran on elsewhere in another mode after this window last saw it');
});

test('an id Claude Code would not name a file after is left alone', async () => {
  assert.equal(await seedSessionMode(join(directory, 'bad'), '../escape', { mode: 'auto', at: 1 }), false, 'a session id never becomes a path outside the store');
});

test("a session's mode is the one its last prompt recorded", async () => {
  const home = join(directory, 'claude');
  await mkdir(join(home, 'projects', '-tmp-work'), { recursive: true });
  const user = (text, at, permissionMode) =>
    JSON.stringify({ type: 'user', uuid: `u-${at}`, timestamp: at, cwd: '/tmp/work', permissionMode, message: { role: 'user', content: [{ type: 'text', text }] } });
  await writeFile(
    join(home, 'projects', '-tmp-work', `${ID}.jsonl`),
    [user('first', '2026-09-01T10:00:00Z', 'default'), user('second', '2026-09-01T11:00:00Z', 'bypassPermissions'), user('tool result', '2026-09-01T11:01:00Z')].join('\n') + '\n',
  );
  const session = (await listClaudeSessions(home)).find((s) => s.id === ID);
  assert.deepEqual(session?.permissionMode, { mode: 'bypassPermissions', at: Date.parse('2026-09-01T11:00:00Z') }, 'a record without a mode does not erase the last one');
});
