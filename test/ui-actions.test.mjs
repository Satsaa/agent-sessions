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
const options = (overrides = {}) => ({ groupBy: 'activity', scope: 'all', showArchived: false, showSubagents: false, subagentLayout: 'nested', activeSort: 'newest', showActiveArchived: true, showEmpty: false, historyLimit: 1, locallyArchived: new Set(), pinned: new Set(['codex:old']), backlog: new Set(), open: new Set(), search: '', rowDetails: ['questions', 'tasks', 'worktree', 'edits', 'age'], notes: new Map(), expandCurrent: false, current: undefined, ...overrides });

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

test('Active is ordered by the chosen sort, pinned sessions first in every order', () => {
  const provider = new SessionsProvider(options(), () => {});
  provider.setSessions([
    session('old'),
    session('b-working', { state: 'running', startedAt: 30, updatedAt: 40 }),
    session('a-replied', { state: 'replied', startedAt: 10, updatedAt: 60 }),
    session('c-waiting', { state: 'waiting', startedAt: 20, updatedAt: 50 }),
  ]);
  const order = (activeSort) => {
    provider.setOptions(options({ activeSort }));
    return provider.getChildren()[0].children.map(row => row.session.id);
  };
  assert.deepEqual(order('newest'), ['old', 'b-working', 'c-waiting', 'a-replied'], 'newest started first');
  assert.deepEqual(order('oldest'), ['old', 'a-replied', 'c-waiting', 'b-working'], 'oldest started first');
  assert.deepEqual(order('activity'), ['old', 'a-replied', 'c-waiting', 'b-working'], 'the session that wrote last first');
  assert.deepEqual(order('attention'), ['old', 'c-waiting', 'a-replied', 'b-working'], 'waiting, then replied, then working');
  assert.deepEqual(order('title'), ['old', 'a-replied', 'b-working', 'c-waiting'], 'alphabetically');
});

test('Backlog holds its sessions whatever their state, between Active and History and past the history cap', () => {
  const provider = new SessionsProvider(options({ pinned: new Set(), backlog: new Set(['codex:parked', 'codex:parked-live', 'codex:parked-empty']) }), () => {});
  provider.setSessions([
    session('parked', { updatedAt: 5 }),
    session('parked-live', { state: 'running', updatedAt: 9 }),
    session('parked-empty', { empty: true, updatedAt: 1 }),
    session('running', { state: 'running' }),
    session('recent', { updatedAt: 20 }),
    session('older', { updatedAt: 10 }),
  ]);
  const sections = () => provider.getChildren().map(group => [group.label, group.children.map(row => row.session.id)]);
  assert.deepEqual(sections(), [
    ['Active', ['running']],
    ['Backlog', ['parked-live', 'parked', 'parked-empty']],
    ['History', ['recent']],
  ], 'a working backlog session stays in Backlog, an empty one is kept, and none counts against the history limit');
  assert.match(provider.getChildren()[1].children[0].contextValue, /-backlog-/, 'a backlog row offers Remove from Backlog');
  provider.setOptions(options({ pinned: new Set(['codex:parked']), backlog: new Set(['codex:parked']) }));
  assert.deepEqual(sections().map(([label, ids]) => [label, ids.includes('parked')]), [['Active', true], ['History', false]], 'a pin wins over Backlog');
  provider.setOptions(options({ pinned: new Set(), backlog: new Set(['codex:parked']), groupBy: 'none', historyLimit: 10 }));
  assert.deepEqual(provider.getChildren().map(row => row.session.id), ['parked-live', 'running', 'parked', 'recent', 'older'], 'ungrouped, backlog rows follow the active ones');
  provider.setOptions(options({ pinned: new Set(), backlog: new Set(['codex:parked', 'codex:recent']), search: 'r' }));
  assert.deepEqual(sections(), [['Active', ['parked-live', 'running']], ['Backlog', ['recent', 'parked']], ['History', ['older']]], 'a search has a Backlog section too');
});

test('an archived session in use stays listed while archived sessions are hidden', () => {
  const provider = new SessionsProvider(options({ pinned: new Set(), historyLimit: 10 }), () => {});
  const sessions = [
    session('live', { archived: true, state: 'running' }),
    session('opened', { archived: true }),
    session('parent', { archived: true }),
    session('child', { subagent: true, parentId: 'parent', state: 'running' }),
    session('put-away', { archived: true }),
    session('idle', { archived: true, state: 'replied' }),
    session('idle-opened', { archived: true, state: 'replied' }),
  ];
  provider.setSessions(sessions);
  const listed = () => provider.visible().map(s => s.id).sort();
  provider.setOptions(options({ pinned: new Set(), historyLimit: 10, open: new Set(['codex:opened', 'codex:idle-opened']) }));
  assert.deepEqual(listed(), ['idle-opened', 'live', 'opened', 'parent'], 'working, open in a tab, or holding a working spawned session; an idle one whose process outlived its tab is out of use');
  assert.deepEqual(provider.getChildren()[0].children.find(row => row.session.id === 'parent').children.map(row => row.session.id), ['child'], 'the working spawned session is under its archived parent');
  provider.setOptions(options({ pinned: new Set(), historyLimit: 10, open: new Set(['codex:opened']), showActiveArchived: false }));
  assert.deepEqual(listed(), [], 'switched off, archived sessions are hidden in use or not');
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
  // Live sessions are archived here, so the in-use exemption (tested on its own) is switched off.
  provider.setOptions(options({ pinned: new Set(), locallyArchived: new Set(['codex:parent']), showActiveArchived: false }));
  assert.deepEqual(provider.getChildren(), [], 'an archived session takes its subagents, however deep, out of the list with it');
  provider.setOptions(options({ pinned: new Set(), locallyArchived: new Set(['codex:parent']), showActiveArchived: false, showArchived: true }));
  const [row] = provider.getChildren()[0].children;
  assert.deepEqual([row.session.id, row.children.map(c => c.session.id), row.children[0].children.map(c => c.session.id)], ['parent', ['child'], ['grandchild']], 'showing archived brings the parent back with its subagents nested again');
});

test('a search lists what matches in Active, History and Archived, past the archive filter and the history cap', () => {
  const provider = new SessionsProvider(options(), () => {});
  provider.setSessions([
    session('old', { title: 'Deploy fix' }),
    session('running', { title: 'deploy run', state: 'running', startedAt: 9 }),
    session('h1', { title: 'deploy history one', updatedAt: 20 }),
    session('h2', { title: 'deploy history two', updatedAt: 30 }),
    session('codex-archived', { title: 'deploy put away', archived: true }),
    session('here-archived', { title: 'deploy put away here', updatedAt: 40 }),
    session('other', { title: 'unrelated', updatedAt: 50 }),
  ]);
  provider.setOptions(options({ search: 'DEPLOY', locallyArchived: new Set(['codex:here-archived']) }));
  const sections = provider.getChildren().map(group => [group.label, group.children.map(row => row.session.id)]);
  assert.deepEqual(sections, [
    ['Active', ['old', 'running']],
    ['History', ['h2', 'h1']],
    ['Archived', ['here-archived', 'codex-archived']],
  ], 'matches are split into live or pinned, stopped and archived sessions, with every match shown');
  assert.equal(provider.searchResults(), 6, 'the view is told how many sessions matched');
  provider.setOptions(options({ search: 'history  TWO' }));
  assert.deepEqual(provider.getChildren().map(group => group.children.map(row => row.session.id)), [['h2']], 'every word must match, in any case');
  provider.setOptions(options({ search: 'nothing like this' }));
  assert.deepEqual([provider.getChildren(), provider.searchResults()], [[], 0], 'a search with no match shows no rows and says so');
  provider.setOptions(options());
  assert.deepEqual([provider.getChildren().map(group => group.label), provider.searchResults()], [['Active', 'History'], undefined], 'clearing the search brings back the usual list');
});

test('a search finds a session by what it spawned, and shows it with its subagents', () => {
  const provider = new SessionsProvider(options({ pinned: new Set(), search: 'needle' }), () => {});
  provider.setSessions([session('parent', { state: 'running' }), session('child', { title: 'find the needle', state: 'running', subagent: true, parentId: 'parent' })]);
  const [active] = provider.getChildren();
  assert.deepEqual([active.label, active.children.map(row => [row.session.id, row.children.map(c => c.session.id)])], ['Active', [['parent', ['child']]]], 'a matching subagent brings its parent row, nested as usual');
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
  const notes = new Map([['claude:main', { seq: 1, tasks: [{ id: 't1', text: 'Hand the engine over', state: 'open', at: 1 }], answers: [], questions: [] }]]);
  const withNotes = new SessionsProvider(options({ pinned: new Set(), notes }), () => {});
  withNotes.setSessions([main, handed, spawned]);
  assert.equal(withNotes.getChildren()[0].children[0].collapsibleState, 1, 'a thread holding spawned sessions beside its notes still opens collapsed');
});

test('a session that stops working stays in Active for five seconds before it moves to History', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const provider = new SessionsProvider(options({ pinned: new Set(), historyLimit: 10 }), () => {});
  const sections = () => provider.getChildren().map(group => [group.label, group.children.map(row => row.session.id)]);
  provider.setSessions([session('opened', { state: 'replied' }), session('old')]);
  provider.setSessions([session('opened'), session('old')]);
  assert.deepEqual(sections(), [['Active', ['opened']], ['History', ['old']]], 'a moment stopped, as opening a session does to it, is not a move to History');
  provider.setSessions([session('opened', { state: 'replied' }), session('old')]);
  provider.setSessions([session('opened'), session('old')]);
  t.mock.timers.tick(4999);
  assert.deepEqual(sections(), [['Active', ['opened']], ['History', ['old']]], 'working again restarts the five seconds');
  t.mock.timers.tick(1);
  assert.deepEqual(sections(), [['History', ['opened', 'old']]], 'stopped for five seconds, it moves to History by itself');
});

test('a hovered Sessions view holds a background update for three seconds, and a person’s own change for none', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  let fired = 0;
  const provider = new SessionsProvider(options({ pinned: new Set(), historyLimit: 10 }), () => {});
  provider.changed.fire = () => { fired++; };
  provider.setSessions([session('a')]);
  assert.equal(fired, 1, 'nothing is hovered, so the rows show at once');
  const [history] = provider.getChildren();
  const row = history.children[0];
  assert.equal(row.tooltip, undefined, 'the tooltip is left for the hover to ask for: that request is the hover signal');
  assert.match(provider.resolveTreeItem(row, row).tooltip.value, /Stopped/);

  provider.setSessions([session('a'), session('b')]);
  t.mock.timers.tick(2999);
  assert.equal(fired, 1, 'a session appearing must not move rows under the pointer');
  provider.resolveTreeItem(history, history);
  provider.setSessions([session('a'), session('b'), session('c')]);
  t.mock.timers.tick(2999);
  assert.equal(fired, 1, 'reaching another row starts the three seconds again');
  t.mock.timers.tick(1);
  assert.equal(fired, 2, 'the held changes arrive as one update');
  assert.equal(provider.getChildren()[0].children.length, 3);

  provider.resolveTreeItem(history, history);
  provider.setSessions([session('a')]);
  provider.setOptions(options({ pinned: new Set(), historyLimit: 10, search: 'a' }));
  assert.equal(fired, 3, 'what a person changes shows at once, hovered or not');
  t.mock.timers.tick(3000);
  assert.equal(fired, 3, 'and takes the held update with it');
});

test('a session lists its questions and answers in one row and its tasks in another under it, and counts them on its row, in the chosen details', () => {
  const notes = new Map([['codex:a', {
    seq: 6,
    tasks: [{ id: 't0', text: 'Keep Twilio Media', state: 'dropped', resolution: 'Replaced.', at: 0 }, { id: 't1', text: 'Create v2 phone engine', state: 'done', resolution: 'Behind the phoneV2 switch.', closedAt: 6, at: 1 }, { id: 't4', text: 'Port the guard', state: 'open', at: 4 }],
    answers: [
      { id: 'q2', text: 'Is the old engine kept?', state: 'stale', at: 2 },
      { id: 'q3', text: 'Does it\nhandle barge-in?', state: 'answered', answer: 'Yes.', at: 3, answeredAt: 7 },
    ],
    questions: [{ id: 'q5', text: 'Remove the old engine?', state: 'open', at: 5 }],
  }]]);
  const wt = { path: '/wt/phone', name: 'phone', branch: 'phone', repoRoot: '/repo' };
  const provider = new SessionsProvider(options({ pinned: new Set(), historyLimit: 10, notes }), () => {});
  provider.setSessions([session('a', { worktree: wt, updatedAt: Date.now() }), session('b', { updatedAt: Date.now() })]);
  const [a, b] = provider.getChildren()[0].children;
  assert.match(a.description, /^\? 1 · ✉ 1 · ☑ 1\/2 · ⎇ phone · /, 'a question waiting for you, an unread answer and the tasks done lead the row; the tool is the icon’s to say');
  assert.doesNotMatch(b.description, /[✉?☑]|Codex/, 'a session with nothing recorded shows no counts');
  assert.equal(b.collapsibleState, 0);
  assert.equal(a.collapsibleState, 2, 'a session whose notes rows are all it holds opens by itself');

  const [notesRow, tasksRow] = provider.getChildren(a);
  assert.deepEqual(provider.getChildren(a).map((row) => [row.label, row.description, row.collapsibleState]), [
    ['Questions and Answers', '1 question for you · 1 new answer', 2],
    ['Tasks', '1/2 tasks done', 2],
  ], 'tasks are a subsection of their own, apart from the questions and answers');
  assert.deepEqual(notesRow.children.map((n) => [n.label, n.contextValue]), [
    ['Does it handle barge-in?', 'note-answer-answered-unread'],
    ['Remove the old engine?', 'note-question-open'],
    ['Is the old engine kept?', 'note-answer-stale'],
  ], 'newest first, by when each last changed: an answer by when it was answered, whatever its state');
  assert.deepEqual(tasksRow.children.map((n) => [n.label, n.contextValue]), [
    ['Create v2 phone engine', 'note-task-done'],
    ['Port the guard', 'note-task-open'],
    ['Keep Twilio Media', 'note-task-dropped'],
  ], 'newest first, by when each last changed: a task by when it was closed, else when it was given');
  assert.ok([...notesRow.children, ...tasksRow.children].every((n) => !/answer|done|dropped|stale/.test(n.description)), 'a note row says only its age: the icon says its state');
  const [answered] = notesRow.children;
  const [done] = tasksRow.children;
  assert.match(provider.resolveTreeItem(done, done).tooltip.value, /Behind the phoneV2 switch\./, 'a closed task says what came of it');
  assert.match(provider.resolveTreeItem(answered, answered).tooltip.value, /Yes\./, 'the answer is in the hover');

  provider.setOptions(options({ pinned: new Set(), historyLimit: 10, notes, rowDetails: ['age'] }));
  assert.doesNotMatch(provider.getChildren()[0].children[0].description, /[✉☑⎇]/, 'only the chosen details are shown');
  let fired = 0;
  provider.changed.fire = () => { fired++; };
  notes.get('codex:a').answers[1].read = true;
  provider.setOptions(options({ pinned: new Set(), historyLimit: 10, notes }));
  assert.equal(fired, 1, 'reading an answer redraws: the count leaves the row');
  assert.match(provider.getChildren()[0].children[0].description, /^\? 1 · ☑ 1\/2/);
  notes.get('codex:a').questions = [];
  notes.get('codex:a').answers = [];
  provider.setOptions(options({ pinned: new Set(), historyLimit: 10, notes }));
  assert.equal(provider.getChildren(provider.getChildren()[0].children[0])[0].label, 'Tasks', 'with nothing asked, only the tasks row is left');
});

test('a replied session whose every task is done shows its glyph green, the tool’s mark unchanged', () => {
  const task = (state) => ({ id: `t-${state}`, text: state, state, at: 1 });
  const notes = new Map([
    ['codex:done', { seq: 1, tasks: [task('done'), task('dropped')], answers: [], questions: [] }],
    ['codex:open', { seq: 1, tasks: [task('done'), task('open')], answers: [], questions: [] }],
    ['codex:dropped', { seq: 1, tasks: [task('dropped')], answers: [], questions: [] }],
  ]);
  const provider = new SessionsProvider(options({ pinned: new Set(), historyLimit: 10, notes }), () => {});
  provider.setSessions(['done', 'open', 'dropped', 'none'].map((id) => session(id, { state: 'replied' })));
  const icons = Object.fromEntries(provider.getChildren()[0].children.map((row) => [row.session.id, row.iconPath.dark.fsPath.split('/').at(-1)]));
  assert.deepEqual(icons, {
    done: 'codex-replied-done-dark.svg',
    open: 'codex-replied-dark.svg',
    dropped: 'codex-replied-dark.svg',
    none: 'codex-replied-dark.svg',
  }, 'green only when a task was done and none is open; a dropped task neither counts nor blocks');
});

test('a session marked done says so on its row and in its context value, with no row of its own for the record', () => {
  const done = { at: 1, features: 'Shipped', tickets: 'None', cleanup: 'None' };
  const notes = new Map([['codex:a', { seq: 1, tasks: [], answers: [], questions: [], done }], ['codex:b', { seq: 1, tasks: [{ id: 't1', text: 'Ship', state: 'done', at: 1 }], answers: [], questions: [], done }]]);
  const provider = new SessionsProvider(options({ pinned: new Set(), historyLimit: 10, notes }), () => {});
  provider.setSessions([session('a'), session('b')]);
  const [a, b] = provider.getChildren()[0].children;
  assert.match(a.description, /✓ done/);
  assert.match(a.contextValue, /-done(-|$)/, 'the context menu offers View Completion Record by this');
  assert.equal(a.collapsibleState, 0, 'the record is no row: a session with nothing else under it has nothing to open');
  assert.deepEqual(provider.getChildren(b).map((row) => row.label), ['Tasks'], 'only the notes are listed under a done session');
});

test('the current session’s row opens, every other one stays closed, and the previous one closes when the current one changes', () => {
  const notes = new Map(['a', 'b'].map((id) => [`codex:${id}`, { seq: 1, tasks: [{ id: 't1', text: 'Ship it', state: 'open', at: 1 }], answers: [], questions: [] }]));
  const provider = new SessionsProvider(options({ pinned: new Set(), historyLimit: 10, notes, expandCurrent: true }), () => {});
  provider.setSessions([session('a', { state: 'running' }), session('b', { state: 'running' })]);
  const rows = () => Object.fromEntries(provider.getChildren()[0].children.map((row) => [row.session.id, [row.id, row.collapsibleState]]));
  const before = rows();
  assert.deepEqual([before.a[1], before.b[1]], [1, 1], 'with no current session, even a session holding only notes stays closed');
  provider.setOptions(options({ pinned: new Set(), historyLimit: 10, notes, expandCurrent: true, current: 'codex:a' }));
  const first = rows();
  assert.equal(first.a[1], 2, 'the current session opens');
  assert.notEqual(first.a[0], before.a[0], 'under a fresh id, since the view keeps the expansion it knew for an id');
  provider.setOptions(options({ pinned: new Set(), historyLimit: 10, notes, expandCurrent: true, current: 'codex:b' }));
  const second = rows();
  assert.deepEqual([second.a[1], second.b[1]], [1, 2], 'the previous session closes and the new one opens');
  assert.ok(second.a[0] !== before.a[0] && second.a[0] !== first.a[0], 'the previous row closes under an id the view has not seen open');
  provider.setOptions(options({ pinned: new Set(), historyLimit: 10, notes, expandCurrent: false, current: 'codex:b' }));
  assert.deepEqual(Object.values(rows()).map(([, state]) => state), [2, 2], 'switched off, rows keep their own default');
});
