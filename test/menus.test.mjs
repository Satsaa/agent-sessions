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

test('the row action picker covers every context-menu action', async () => {
  const { build } = await import('esbuild');
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { createRequire } = await import('node:module');
  const dir = await mkdtemp(join(tmpdir(), 'agent-sessions-menus-test-'));
  try {
    const out = join(dir, 'row-actions.cjs');
    await build({ entryPoints: ['src/row-actions.ts'], bundle: true, platform: 'node', format: 'cjs', outfile: out });
    const { ROW_ACTIONS, rowActionsFor } = createRequire(import.meta.url)(out);
    const listed = new Set(ROW_ACTIONS.map((a) => a.command));
    const contextMenu = new Set(contributes.menus['view/item/context'].filter((e) => !e.group?.startsWith('inline')).map((e) => e.command));
    assert.deepEqual([...contextMenu].filter((c) => !listed.has(c)), [], 'every context-menu action is in the picker');
    assert.deepEqual([...listed].filter((c) => !contextMenu.has(c)), [], 'the picker offers nothing the context menu does not');
    assert.deepEqual(rowActionsFor('group', false), [], 'a group row has no actions');
    assert.ok(rowActionsFor('session-claude-pinned-live', true).includes('agentSessions.unpin') && !rowActionsFor('session-claude-pinned-live', true).includes('agentSessions.pin'), 'a pinned session offers Unpin, not Pin');
    assert.ok(rowActionsFor('session-claude-live', false).includes('agentSessions.openInTerminal') && !rowActionsFor('session-claude-live', true).includes('agentSessions.openInTerminal'), 'desktop-only actions are offered on the desktop and left out on the phone');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
