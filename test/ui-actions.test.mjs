import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { build } from 'esbuild';

class Uri {
  constructor(fsPath) { this.fsPath = fsPath; }
  static file(path) { return new Uri(path); }
  static joinPath(root, ...parts) { return new Uri(join(root.fsPath, ...parts)); }
  static from(components) { return Object.assign(new Uri(components.path ?? ''), components); }
  toString() { return this.fsPath; }
}
class MarkdownString {
  value = '';
  appendMarkdown(value) { this.value += value; return this; }
}
const vscode = globalThis.__agentSessionsVSCode = {
  Uri, MarkdownString,
  ThemeColor: class { constructor(id) { this.id = id; } },
  ThemeIcon: class { constructor(id, color) { this.id = id; this.color = color; } },
  TreeItem: class { constructor(label, collapsibleState) { this.label = label; this.collapsibleState = collapsibleState; } },
  EventEmitter: class { event = () => {}; fire() {} },
  TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
  workspace: { workspaceFolders: [] },
  commands: { executeCommand: async () => {}, getCommands: async () => ['git.repositories.deleteWorktree'] },
  extensions: { getExtension: () => undefined },
};
const directory = await mkdtemp(join(tmpdir(), 'agent-sessions-ui-test-'));
const bundle = join(directory, 'ui.cjs');
await build({
  stdin: { contents: `export * from './src/usage-view.ts'; export * from './src/tree.ts'; export * from './src/worktrees-tree.ts'; export * from './src/delete-worktree.ts';`, resolveDir: process.cwd() },
  bundle: true, platform: 'node', format: 'cjs', outfile: bundle,
  plugins: [{ name: 'vscode-stub', setup(build) {
    build.onResolve({ filter: /^vscode$/ }, () => ({ path: 'vscode', namespace: 'stub' }));
    build.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: 'module.exports = globalThis.__agentSessionsVSCode;' }));
  } }],
});
const { UsageProvider, usageStatusText, usageStatusColor, usageStatusTooltip, isUsageStale, SessionsProvider, WorktreesProvider, deleteWorktree } = createRequire(import.meta.url)(bundle);
after(() => rm(directory, { recursive: true, force: true }));
const usage = (overrides = {}) => ({ tool: 'claude', plan: 'Max 20x', windows: [{ label: 'Session', percent: 95 }], asOf: Date.now(), source: 'test', error: undefined, ...overrides });

test('429 preserves status-bar counts, severity, tooltip counts and sidebar plan/rows', () => {
  const good = usage();
  const limited = { ...good, error: 'Usage endpoint answered 429; retry later' };
  assert.equal(usageStatusText([limited]), usageStatusText([good]));
  assert.equal(usageStatusColor([limited]).id, usageStatusColor([good]).id);
  assert.match(usageStatusTooltip([limited]).value, /5% left/);
  const provider = new UsageProvider(Uri.file('/extension'));
  const view = { description: '', webview: { cspSource: 'test', postMessage: async () => {}, asWebviewUri: uri => uri, onDidReceiveMessage() {} }, onDidDispose() {}, onDidChangeVisibility() {} };
  provider.set([limited]);
  provider.resolveWebviewView(view);
  assert.match(view.webview.html, /aria-valuenow="5"/);
  assert.match(view.webview.html, /<span class="plan">Max 20x<\/span>/);
  assert.doesNotMatch(view.webview.html, /<li class="message">/);
});

test('age warning begins after ten minutes and clears on a successful fresh reading', t => {
  const now = Date.now();
  t.mock.method(Date, 'now', () => now);
  const old = usage({ asOf: now - 600_001 });
  assert.equal(isUsageStale(usage({ asOf: now - 600_000 })), false);
  assert.equal(isUsageStale(old), true);
  assert.match(usageStatusText([old]), /\$\(warning\).*5%/);
  assert.doesNotMatch(usageStatusText([usage()]), /warning/);
  assert.equal(isUsageStale(usage({ asOf: 0, windows: [] })), false);
});

const session = (id, overrides = {}) => ({ tool: 'codex', id, title: id, state: 'stopped', startedAt: 1, updatedAt: 1, archived: false, subagent: false, empty: false, ...overrides });
const options = (overrides = {}) => ({ groupBy: 'activity', scope: 'all', showArchived: false, showSubagents: false, showEmpty: false, historyLimit: 1, locallyArchived: new Set(), pinned: new Set(['codex:old']), ...overrides });

test('pinned stopped sessions stay in Active outside the history cap without becoming live', () => {
  const provider = new SessionsProvider(options());
  provider.setSessions([session('old'), session('running', { state: 'running', startedAt: 9 }), session('recent', { updatedAt: 20 })]);
  const [active, history] = provider.getChildren();
  assert.equal(active.label, 'Active');
  assert.deepEqual(active.children.map(row => row.session.id), ['old', 'running']);
  assert.equal(active.children[0].session.state, 'stopped');
  assert.deepEqual(history.children.map(row => row.session.id), ['recent']);
  provider.setOptions(options({ pinned: new Set() }));
  assert.deepEqual(provider.getChildren()[0].children.map(row => row.session.id), ['running']);
});

test('pinning remains tool-specific and respects repository and archive filtering', () => {
  const provider = new SessionsProvider(options());
  provider.setSessions([session('old'), session('old', { tool: 'claude' }), session('hidden', { archived: true })]);
  assert.equal(provider.getChildren()[0].children.length, 1);
  provider.setOptions(options({ scope: 'workspace' }));
  assert.deepEqual(provider.getChildren(), []);
});

const worktree = { path: '/repo-wt/topic', repoRoot: '/repo', name: 'topic', isMain: false };
test('worktree rows retain pinned stopped sessions beyond the recent-session limit', () => {
  const provider = new WorktreesProvider();
  const sessions = ['old', 'a', 'b', 'c', 'd'].map((id, i) => session(id, { cwd: worktree.path, updatedAt: i }));
  provider.set([worktree], new Map(), sessions, new Set(), new Set(['codex:old']));
  const rows = provider.getChildren()[0].children;
  assert.deepEqual(rows.map(row => row.session.id), ['old', 'd', 'c', 'b']);
  assert.match(rows[0].contextValue, /-pinned-/);
});

test('worktree delete delegates the selected path to the exact native repositories command', async t => {
  const calls = [];
  t.mock.method(vscode.extensions, 'getExtension', () => ({ activate: async () => ({ getAPI: () => ({ getRepository: () => ({ rootUri: Uri.file('/repo') }) }) }) }));
  t.mock.method(vscode.commands, 'executeCommand', async (...args) => { calls.push(args); });
  await deleteWorktree(worktree);
  assert.deepEqual(calls.map(call => call[0]), ['git.openRepository', 'git.repositories.deleteWorktree']);
  assert.equal(calls[1][1].fsPath, '/repo');
  assert.deepEqual(calls[1][2], { id: worktree.path });
});

test('worktree delete refuses main checkouts and unresolved repository roots', async t => {
  const calls = [];
  t.mock.method(vscode.commands, 'executeCommand', async (...args) => { calls.push(args); });
  await deleteWorktree({ ...worktree, isMain: true });
  assert.equal(calls.length, 0);
  t.mock.method(vscode.extensions, 'getExtension', () => ({ activate: async () => ({ getAPI: () => ({ getRepository: () => null }) }) }));
  await assert.rejects(deleteWorktree(worktree), /Open the main repository/);
  assert.deepEqual(calls.map(call => call[0]), ['git.openRepository']);
});
