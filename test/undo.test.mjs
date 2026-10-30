import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { build } from 'esbuild';

const directory = await mkdtemp(join(tmpdir(), 'agent-sessions-undo-test-'));
const bundle = join(directory, 'undo.cjs');
await build({ entryPoints: ['src/undo.ts'], bundle: true, platform: 'node', format: 'cjs', outfile: bundle });
const { History } = createRequire(import.meta.url)(bundle);
after(() => rm(directory, { recursive: true, force: true }));

/** A step that archives `key` in `state`: the set of archived keys. */
const archiveStep = (state, key) => {
  state.add(key);
  return { label: `Archive ${key}`, undo: async () => void state.delete(key), redo: async () => void state.add(key) };
};

test('undo takes back the newest step first, and redo makes it again', async () => {
  const archived = new Set();
  const history = new History();
  history.record(archiveStep(archived, 'a'));
  history.record(archiveStep(archived, 'b'));
  // Pressed twice without waiting: the steps still go back newest first.
  const [first, second] = await Promise.all([history.undo(), history.undo()]);
  assert.deepEqual([first.label, second.label], ['Archive b', 'Archive a'], 'undo goes back newest first, one at a time');
  assert.equal(archived.size, 0, 'both archived sessions are back');
  assert.equal(await history.undo(), undefined, 'with nothing left to undo, undo does nothing');
  assert.equal((await history.redo()).label, 'Archive a', 'redo makes again the step undone last');
  assert.deepEqual([...archived], ['a']);
});

test('a new step clears what was undone, as in an editor', async () => {
  const archived = new Set();
  const history = new History();
  history.record(archiveStep(archived, 'a'));
  await history.undo();
  assert.equal(history.canRedo, true);
  history.record(archiveStep(archived, 'b'));
  assert.equal(history.canRedo, false, 'a new step after an undo leaves nothing to redo');
  assert.equal(await history.redo(), undefined);
});

test('a step whose undo fails stays to be tried again', async () => {
  const history = new History();
  let fail = true;
  history.record({ label: 'Rename', undo: async () => { if (fail) throw new Error('database locked'); }, redo: async () => {} });
  await assert.rejects(history.undo(), /database locked/);
  assert.equal(history.canUndo, true, 'a failed undo keeps its step on the undo stack');
  fail = false;
  assert.equal((await history.undo()).label, 'Rename', 'the kept step undoes once it can');
});

test('the history keeps only its newest steps', async () => {
  const archived = new Set();
  const history = new History(undefined, 2);
  for (const key of ['a', 'b', 'c']) history.record(archiveStep(archived, key));
  await history.undo();
  await history.undo();
  assert.equal(await history.undo(), undefined, 'the step past the limit was dropped');
  assert.deepEqual([...archived], ['a'], 'a dropped step stays done');
});

test('every change to what can be undone or redone is announced', async () => {
  const seen = [];
  const history = new History(() => seen.push([history.canUndo, history.canRedo]));
  history.record(archiveStep(new Set(), 'a'));
  await history.undo();
  await history.redo();
  assert.deepEqual(seen, [[true, false], [false, true], [true, false]], 'the Undo and Redo menu items follow the stacks');
});
