import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { build } from 'esbuild';

const require = createRequire(import.meta.url);
const directory = await mkdtemp(join(tmpdir(), 'agent-sessions-runner-test-'));
// Laid out as in dist/: the client finds runner.mjs next to its own bundle.
await build({ entryPoints: ['src/runner.ts'], bundle: true, platform: 'node', format: 'cjs', outfile: join(directory, 'client.cjs') });
await build({ entryPoints: { runner: 'src/host/runner.ts' }, bundle: true, platform: 'node', format: 'esm', outdir: directory, outExtension: { '.js': '.mjs' } });
const { run, stopRunner } = require(join(directory, 'client.cjs'));
after(async () => {
  stopRunner();
  await rm(directory, { recursive: true, force: true });
});

test('commands are started by the runner, never forked from the calling process', async () => {
  const parent = await run('sh', ['-c', 'echo $PPID']);
  assert.ok(parent, 'the command ran');
  assert.notEqual(Number(parent), process.pid, 'the extension host does not fork for a command');
  const again = await run('sh', ['-c', 'echo $PPID']);
  assert.equal(again, parent, 'one runner serves every command');
  assert.equal(await run('sh', ['-c', 'pwd'], { cwd: directory }), `${directory}\n`, 'the command runs in the directory asked for');
});

test('a failing command, and one cut off by the runner ending, resolve to no output', async () => {
  assert.equal(await run('sh', ['-c', 'exit 3']), undefined);
  const first = Number(await run('sh', ['-c', 'echo $PPID']));
  const cut = run('sleep', ['5']);
  stopRunner();
  assert.equal(await cut, undefined, 'a command in flight when the runner goes is answered, not left hanging');
  const second = Number(await run('sh', ['-c', 'echo $PPID']));
  assert.ok(second && second !== first, 'the next command starts a new runner');
});
