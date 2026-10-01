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
const options = (overrides = {}) => ({ groupBy: 'activity', scope: 'all', showArchived: false, showSubagents: false, subagentLayout: 'nested', showEmpty: false, historyLimit: 1, locallyArchived: new Set(), pinned: new Set(['codex:old']), ...overrides });

test('pinned stopped sessions stay in Active outside the history cap without becoming live', () => {
  const provider = new SessionsProvider(options(), () => {});
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
  const provider = new SessionsProvider(options(), () => {});
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

test('inactive worktrees are grouped last, ignoring archived sessions but counts stopped ones', () => {
  const wt = (name) => ({ path: `/repo-wt/${name}`, repoRoot: '/repo', name, isMain: false });
  const main = { path: '/repo', repoRoot: '/repo', name: 'repo', isMain: true };
  const trees = [main, wt('stopped'), wt('archived'), wt('local'), wt('none')];
  const sessions = [
    session('s', { cwd: '/repo-wt/stopped' }),
    session('a', { cwd: '/repo-wt/archived', archived: true }),
    session('l', { cwd: '/repo-wt/local' }),
  ];
  const provider = new WorktreesProvider();
  provider.set(trees, new Map(), sessions, new Set(['codex:l']), new Set(), false);
  const roots = provider.getChildren();
  assert.deepEqual(roots.map(r => r.worktree?.name ?? r.label), ['repo', 'stopped', 'Inactive'], 'a stopped session keeps its worktree in use, the main checkout is never grouped, and the group comes last');
  assert.deepEqual(roots[2].children.map(r => r.worktree.name), ['archived', 'local', 'none'], 'natively and locally archived sessions do not count as a use');
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

test('archiving a session hides its subagents instead of promoting them to rows', () => {
  const parent = session('parent', { state: 'running' });
  const child = session('child', { state: 'running', subagent: true, parentId: 'parent' });
  const grandchild = session('grandchild', { state: 'running', subagent: true, parentId: 'child' });
  const provider = new SessionsProvider(options({ pinned: new Set() }), () => {});
  provider.setSessions([parent, child]);
  assert.deepEqual(provider.getChildren()[0].children.map(row => row.session.id), ['parent'], 'live subagents nest under their parent');
  provider.setSessions([parent, child, grandchild]);
  provider.setOptions(options({ pinned: new Set(), locallyArchived: new Set(['codex:parent']) }));
  assert.deepEqual(provider.getChildren(), [], 'an archived session takes its subagents, however deep, out of the list with it');
  provider.setOptions(options({ pinned: new Set(), locallyArchived: new Set(['codex:parent']), showArchived: true }));
  const [row] = provider.getChildren()[0].children;
  assert.deepEqual([row.session.id, row.children.map(c => c.session.id), row.children[0].children.map(c => c.session.id)], ['parent', ['child'], ['grandchild']], 'showing archived brings the parent back with its subagents nested again');
});

test('the Worktrees view redraws only when a row it shows changes', () => {
  let fired = 0;
  const provider = new WorktreesProvider();
  provider.changed.fire = () => { fired++; };
  const trees = [{ path: '/repo', repoRoot: '/repo', name: 'repo', isMain: true }, { path: '/repo-wt/a', repoRoot: '/repo', name: 'a', isMain: false }];
  const sessions = [session('s', { cwd: '/repo-wt/a' })];
  provider.set(trees, new Map(), sessions, new Set(), new Set(), false);
  provider.set(trees, new Map(), sessions.map((s) => ({ ...s })), new Set(), new Set(), false);
  assert.equal(fired, 1, 'VS Code shows a progress bar on every change event, so an identical rebuild must not fire one');
  provider.set(trees, new Map(), [], new Set(), new Set(), false);
  assert.equal(fired, 2, 'a worktree losing its session is a visible change');
});

test('a subagent of another agent’s session nests under that session, in the chosen layout', () => {
  const now = Date.now();
  const main = session('main', { tool: 'claude', state: 'running', updatedAt: now });
  // A Codex session the Claude thread started, finished long ago, whose own spawned agent is still working.
  const handed = session('handed', { subagent: true, parentId: 'main', parentTool: 'claude', updatedAt: now - 3_600_000, startedAt: 2 });
  const spawned = session('spawned', { subagent: true, parentId: 'handed', state: 'running', updatedAt: now, startedAt: 3 });
  const shown = (layout) => {
    const provider = new SessionsProvider(options({ pinned: new Set(), subagentLayout: layout }), () => {});
    provider.setSessions([main, handed, spawned]);
    const tree = (row) => row.children.length ? { [row.session.id]: row.children.map(tree) } : row.session.id;
    return provider.getChildren()[0].children.map(tree);
  };
  assert.deepEqual(shown('nested'), [{ main: [{ handed: ['spawned'] }] }], 'nested keeps the chain whole: an old session stays while its subagent works');
  assert.deepEqual(shown('flat'), [{ main: ['spawned'] }], 'flat lists the working descendant directly under the top thread, without the stopped one between');
  assert.deepEqual(shown('root'), ['spawned', 'main'], 'root makes every kept subagent a row of its own');
  const provider = new SessionsProvider(options({ pinned: new Set() }), () => {});
  provider.setSessions([main, handed, spawned]);
  const [row] = provider.getChildren()[0].children;
  assert.deepEqual([row.collapsibleState, row.children[0].collapsibleState], [1, 2], 'the thread opens collapsed, and everything inside it is expanded');
});
