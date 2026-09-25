import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { build } from 'esbuild';

class Uri {
  constructor(parts) { Object.assign(this, { scheme: 'file', authority: '', path: '', query: '' }, parts); }
  static file(path) { return new Uri({ path }); }
  with(change) { return new Uri({ ...this, ...change }); }
}
class TabInputCustom { constructor(uri, viewType) { this.uri = uri; this.viewType = viewType; } }
class TabInputWebview { constructor(viewType) { this.viewType = viewType; } }
const codexUri = (path) => new Uri({ scheme: 'openai-codex', authority: 'route', path });
const codexTab = (path, label, isActive = false) => ({ input: new TabInputCustom(codexUri(path), 'chatgpt.conversationEditor'), label, isActive });

const groups = [];
const vscode = globalThis.__agentSessionsVSCode = {
  Uri, TabInputCustom, TabInputWebview,
  ViewColumn: { Active: -1 },
  window: {
    tabGroups: {
      get all() { return groups; },
      get activeTabGroup() { return groups[0]; },
      close: async (tab) => { for (const g of groups) { const i = g.tabs.indexOf(tab); if (i >= 0) g.tabs.splice(i, 1); } },
    },
  },
  commands: {
    // openWith appends the tab to its group, as VS Code does; moveActiveEditor puts the last one opened in its slot.
    executeCommand: async (command, ...args) => {
      if (command === 'vscode.openWith') {
        const [uri, viewType, options] = args;
        const group = groups.find((g) => g.viewColumn === options.viewColumn);
        group.tabs.push({ input: new TabInputCustom(uri, viewType), label: 'Codex', isActive: !options.preserveFocus });
        group.lastOpened = group.tabs.at(-1);
      }
      if (command === 'moveActiveEditor') {
        const group = groups.find((g) => g.lastOpened);
        const tab = group.lastOpened;
        group.tabs.splice(group.tabs.indexOf(tab), 1);
        group.tabs.splice(args[0].value - 1, 0, tab);
        delete group.lastOpened;
      }
    },
  },
  extensions: { getExtension: () => undefined },
};
const directory = await mkdtemp(join(tmpdir(), 'agent-sessions-fresh-tabs-test-'));
const bundle = join(directory, 'open.cjs');
await build({
  entryPoints: ['src/open.ts'], bundle: true, platform: 'node', format: 'cjs', outfile: bundle, external: ['node:sqlite'],
  plugins: [{ name: 'vscode-stub', setup(b) {
    b.onResolve({ filter: /^vscode$/ }, () => ({ path: 'vscode', namespace: 'stub' }));
    b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: 'module.exports = globalThis.__agentSessionsVSCode;' }));
  } }],
});
const { freshCodexTabs, restoreFreshCodexTabs } = createRequire(import.meta.url)(bundle);
after(() => rm(directory, { recursive: true, force: true }));

const session = (id, title) => ({ tool: 'codex', id, title });

test('a Codex tab started fresh comes back from a reload on its thread, in its slot', async () => {
  groups.splice(0, groups.length, {
    viewColumn: 1,
    tabs: [
      codexTab('/local/aaa', 'Opened by id'),
      codexTab('/extension/panel/new', 'Fix the build', true),
      codexTab('/extension/panel/new', 'New thread'),
    ],
  });
  const sessions = [session('aaa', 'Opened by id'), session('bbb', 'Fix the build')];
  const saved = freshCodexTabs(sessions);
  assert.deepEqual(saved, [{ column: 1, index: 1, threadId: 'bbb' }], 'only a fresh tab whose thread is known is remembered');

  // A reload: Codex rebuilds each tab from its URI, so the fresh one comes back blank.
  groups[0].tabs[1] = codexTab('/extension/panel/new', 'New thread', true);
  await restoreFreshCodexTabs(saved);
  assert.deepEqual(groups[0].tabs.map((t) => t.input.uri.path), ['/local/aaa', '/local/bbb', '/extension/panel/new'], 'the slot now shows its thread; a blank tab with no thread is left alone');
  assert.equal(groups[0].tabs[1].isActive, true, 'the active tab stays active');
});

test('a remembered slot that no longer holds a fresh tab is not replaced', async () => {
  groups.splice(0, groups.length, { viewColumn: 1, tabs: [codexTab('/local/ccc', 'Other')] });
  await restoreFreshCodexTabs([{ column: 1, index: 0, threadId: 'bbb' }, { column: 2, index: 0, threadId: 'ddd' }]);
  assert.deepEqual(groups[0].tabs.map((t) => t.input.uri.path), ['/local/ccc'], 'a tab opened by id, or a missing slot, is never swapped');
});
