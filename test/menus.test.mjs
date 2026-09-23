import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';

const { contributes } = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));

test('no menu when-clause compares a regex match with == or !=', () => {
  // VS Code reads `a && viewItem =~ /x/ == false` as `(a && viewItem =~ /x/) == false`, which negates the whole
  // clause: group and worktree rows then got the session actions. Negate a match as `!(viewItem =~ /x/)`.
  const offenders = Object.values(contributes.menus)
    .flat()
    .filter((e) => /=~\s*\/(?:[^/\\]|\\.)*\/\s*[!=]=/.test(e.when ?? ''))
    .map((e) => `${e.command}: ${e.when}`);
  assert.deepEqual(offenders, [], 'a regex match is negated with !( … ), never compared with == false');
});
