import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { build } from 'esbuild';

const directory = await mkdtemp(join(tmpdir(), 'agent-sessions-marks-test-'));
const bundle = join(directory, 'marks.cjs');
await build({ entryPoints: ['src/marks.ts'], bundle: true, platform: 'node', format: 'cjs', outfile: bundle });
const { setMark, mergeMarks, readMarks, watchMarks } = createRequire(import.meta.url)(bundle);
after(() => rm(directory, { recursive: true, force: true }));

test('a change keeps what another window wrote since this one last read', async () => {
  const file = join(directory, 'a', 'state.json');
  await setMark(file, 'archived', 'claude:1', true);
  // Another window (another process) archives and pins behind this one's back.
  await writeFile(file, JSON.stringify({ archived: ['claude:1', 'codex:2'], pinned: ['codex:3'] }));
  const m = await setMark(file, 'archived', 'claude:1', false);
  assert.deepEqual(m, { archived: ['codex:2'], pinned: ['codex:3'] }, 'unarchiving one session must not drop the other window\'s marks');
});

test('rapid changes from one window all land', async () => {
  const file = join(directory, 'b', 'state.json');
  await Promise.all(['x', 'y', 'z'].map((id) => setMark(file, 'pinned', `codex:${id}`, true)));
  assert.deepEqual((await readMarks(file)).pinned, ['codex:x', 'codex:y', 'codex:z'], 'concurrent pins in one window are applied in turn, not raced');
});

test('migrating globalState unions into the file', async () => {
  const file = join(directory, 'c', 'state.json');
  await setMark(file, 'archived', 'claude:phone', true);
  const m = await mergeMarks(file, { archived: ['claude:desk', 'claude:phone'], pinned: ['codex:p'] });
  assert.deepEqual(m, { archived: ['claude:desk', 'claude:phone'], pinned: ['codex:p'] }, 'the desktop\'s old marks join the phone\'s without duplicates');
});

test('a watcher sees another window\'s rewrite', async () => {
  const file = join(directory, 'd', 'state.json');
  await setMark(file, 'archived', 'claude:1', true);
  const seen = new Promise((resolve) => {
    const w = watchMarks(file, (m) => {
      if (m.archived.includes('codex:9')) {
        w.dispose();
        resolve(m);
      }
    });
  });
  await setMark(file, 'archived', 'codex:9', true);
  const m = await Promise.race([seen, new Promise((r) => setTimeout(() => r(undefined), 3000))]);
  assert.ok(m, 'the rename-over write reaches a watch on the directory');
  assert.equal(JSON.parse(await readFile(file, 'utf8')).archived.length, 2);
});
