import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import { mkdtemp, rm, writeFile, appendFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { build } from 'esbuild';

const require = createRequire(import.meta.url);
const directory = await mkdtemp(join(tmpdir(), 'agent-sessions-appended-test-'));
const bundle = join(directory, 'appended.cjs');
await build({ entryPoints: ['src/appended.ts'], bundle: true, platform: 'node', format: 'cjs', outfile: bundle });
const { scanAppended } = require(bundle);
after(() => rm(directory, { recursive: true, force: true }));

const fresh = () => ({ offset: 0, tail: '', lines: [] });
const scan = async (file, previous) => {
  const read = [];
  const result = await scanAppended(file, (await stat(file)).size, previous, fresh, (s, line) => {
    read.push(line);
    s.lines = [...s.lines, line];
  });
  return { result, read };
};

test('an appended file is read on from where the last scan stopped', async () => {
  const file = join(directory, 'grows.jsonl');
  await writeFile(file, '{"n":1}\n{"n":2}\n');
  const first = await scan(file, undefined);
  await appendFile(file, '{"n":3}\n');
  const second = await scan(file, first.result);
  assert.deepEqual(second.read, ['{"n":3}'], 'only the appended line is read again');
  assert.deepEqual(second.result.lines, ['{"n":1}', '{"n":2}', '{"n":3}'], 'the scan carries on from the earlier one');
  assert.deepEqual(first.result.lines, ['{"n":1}', '{"n":2}'], 'the earlier scan is left as it was');
});

test('a line still being written is read once it ends', async () => {
  const file = join(directory, 'partial.jsonl');
  await writeFile(file, '{"n":1}\n{"n":');
  const first = await scan(file, undefined);
  assert.deepEqual(first.read, ['{"n":1}'], 'a line without its newline is not read yet');
  await appendFile(file, '2}\n');
  const second = await scan(file, first.result);
  assert.deepEqual(second.read, ['{"n":2}'], 'the finished line is read whole');
});

test('a rewritten file is read from the start', async () => {
  const file = join(directory, 'rewritten.jsonl');
  await writeFile(file, '{"n":1}\n{"n":2}\n');
  const first = await scan(file, undefined);
  await writeFile(file, '{"n":9}\n{"n":2}\n{"n":3}\n');
  const second = await scan(file, first.result);
  assert.deepEqual(second.result.lines, ['{"n":9}', '{"n":2}', '{"n":3}'], 'changed earlier bytes mean a full read');
  await writeFile(file, '{"n":1}\n');
  const third = await scan(file, second.result);
  assert.deepEqual(third.result.lines, ['{"n":1}'], 'a file shorter than the last scan is read afresh');
});
