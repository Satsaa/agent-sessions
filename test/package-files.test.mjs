import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';

test('every program esbuild writes is shipped in the package', async () => {
  // .vscodeignore excludes everything and lists what ships; a new entry point missing there builds, passes the tests
  // and is absent from the .vsix, as dist/runner.mjs was.
  const config = await readFile(new URL('../esbuild.mjs', import.meta.url), 'utf8');
  const shipped = (await readFile(new URL('../.vscodeignore', import.meta.url), 'utf8')).split('\n').filter((l) => l.startsWith('!')).map((l) => l.slice(1));
  const outputs = [...config.matchAll(/outfile: '([^']+)'/g)].map((m) => m[1]);
  const named = /entryPoints: \{([^}]*)\}/.exec(config)?.[1] ?? '';
  outputs.push(...[...named.matchAll(/'?([\w-]+)'?: '/g)].map((m) => `dist/${m[1]}.mjs`));
  assert.ok(outputs.length >= 5, `found the build's outputs: ${outputs.join(', ')}`);
  assert.deepEqual(outputs.filter((o) => !shipped.includes(o)), [], 'every built program is listed in .vscodeignore');
});
