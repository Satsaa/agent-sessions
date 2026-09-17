import * as path from 'node:path';
import * as vscode from 'vscode';
import { isLive, STATE_ORDER, toolLabel, type Session, type SessionState } from './types.js';
import { relativeTime, repoRootOf } from './util.js';
import { statsInline, type WorktreeStats } from './worktree.js';
import { stateIcon, toolIcon } from './icons.js';

export type GroupBy = 'activity' | 'repository' | 'tool' | 'none';

export interface ViewOptions {
  groupBy: GroupBy;
  scope: 'all' | 'workspace';
  showArchived: boolean;
  showSubagents: boolean;
  showEmpty: boolean;
  historyLimit: number;
  /** Sessions archived from this view (kept in this extension's own state). */
  locallyArchived: ReadonlySet<string>;
}

export class SessionItem extends vscode.TreeItem {
  constructor(
    public readonly session: Session,
    public readonly archivedHere: boolean,
    showTool: boolean,
    stats: WorktreeStats | undefined,
    idPrefix = '',
  ) {
    super(session.title, vscode.TreeItemCollapsibleState.None);
    const archived = session.archived || archivedHere;
    this.id = `${idPrefix}${session.tool}:${session.id}`;
    this.iconPath = stateIcon(session.tool, session.state, archived);
    this.description = describe(session, showTool, stats);
    this.tooltip = tooltipFor(session, archived, stats);
    this.contextValue = ['session', session.tool, archived ? 'archived' : '', isLive(session.state) ? 'live' : 'stopped']
      .filter(Boolean)
      .join('-');
    this.command = { command: 'agentSessions.open', title: 'Open Session', arguments: [this] };
  }
}

export class GroupItem extends vscode.TreeItem {
  constructor(
    public readonly key: string,
    label: string,
    public readonly children: SessionItem[],
    icon: vscode.ThemeIcon | { light: vscode.Uri; dark: vscode.Uri } | undefined,
    expanded: boolean,
  ) {
    super(label, expanded ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed);
    this.id = `group:${key}`;
    this.description = String(children.length);
    if (icon) this.iconPath = icon;
    this.contextValue = 'group';
  }
}

type Node = SessionItem | GroupItem;

const STATE_LABEL: Record<SessionState, string> = {
  running: 'Working',
  waiting: 'Needs your input',
  replied: 'Replied, waiting for you',
  stopped: 'Stopped',
};

function describe(session: Session, showTool: boolean, stats: WorktreeStats | undefined): string {
  const parts: string[] = [];
  if (showTool) parts.push(toolLabel(session.tool));
  const wt = session.worktree;
  if (wt) {
    let text = `⎇ ${wt.name}`;
    if (stats?.gone) text += ' (gone)';
    else if (stats) {
      const inline = statsInline(stats);
      if (inline) text += ` ${inline}`;
    }
    parts.push(text);
  }
  // A session in the main checkout names neither: the repository is where you
  // are anyway, and its branch is the tooltip's business.
  parts.push(relativeTime(session.updatedAt));
  return parts.join(' · ');
}

function tooltipFor(session: Session, archived: boolean, stats: WorktreeStats | undefined): vscode.MarkdownString {
  const md = new vscode.MarkdownString(undefined, true);
  md.isTrusted = true;
  md.appendMarkdown(`**${escapeMd(session.title)}**\n\n`);
  md.appendMarkdown(`${toolLabel(session.tool)} · ${STATE_LABEL[session.state]}${archived ? ' · archived' : ''}${session.subagent ? ' · subagent' : ''}\n\n`);
  const wt = session.worktree;
  if (wt) {
    md.appendMarkdown(`$(root-folder) worktree **${escapeMd(wt.name)}** \`${wt.path}\`\n\n`);
    const branch = stats?.branch ?? wt.branch;
    if (branch) md.appendMarkdown(`$(git-branch) \`${branch}\`\n\n`);
    if (stats?.gone) md.appendMarkdown(`$(warning) the worktree directory no longer exists\n\n`);
    else if (stats) {
      const bits: string[] = [];
      if (stats.commitsAhead !== undefined) bits.push(`${stats.commitsAhead} ahead${stats.commitsBehind !== undefined ? `, ${stats.commitsBehind} behind` : ''} ${stats.base ?? 'base'}`);
      if (stats.changedFiles !== undefined) bits.push(stats.changedFiles ? `+${stats.insertions ?? '?'} −${stats.deletions ?? '?'} lines in ${stats.changedFiles} file${stats.changedFiles === 1 ? '' : 's'}` : 'clean');
      if (bits.length) md.appendMarkdown(`$(git-commit) ${bits.join(', ')}\n\n`);
    }
    if (session.cwd) md.appendMarkdown(`$(folder) started in \`${session.cwd}\`\n\n`);
  } else {
    if (session.cwd) md.appendMarkdown(`$(folder) \`${session.cwd}\`\n\n`);
    if (session.branch) md.appendMarkdown(`$(git-branch) \`${session.branch}\`\n\n`);
  }
  md.appendMarkdown(`$(clock) ${new Date(session.updatedAt).toLocaleString()}\n\n`);
  if (session.pid) md.appendMarkdown(`$(server-process) pid ${session.pid}\n\n`);
  md.appendMarkdown(`\`${session.id}\``);
  return md;
}

function escapeMd(s: string): string {
  return s.replace(/([\\`*_{}[\]()#+\-.!|>])/g, '\\$1');
}

function byRecency(a: Session, b: Session): number {
  return b.updatedAt - a.updatedAt;
}

function byStateThenRecency(a: Session, b: Session): number {
  return STATE_ORDER[a.state] - STATE_ORDER[b.state] || byRecency(a, b);
}

export class SessionsProvider implements vscode.TreeDataProvider<Node> {
  private readonly changed = new vscode.EventEmitter<Node | undefined>();
  readonly onDidChangeTreeData = this.changed.event;

  private sessions: Session[] = [];
  private stats = new Map<string, WorktreeStats>();
  private options: ViewOptions;
  private roots: Node[] = [];
  /** What the view last rendered; a rebuild that changes nothing visible fires no event. */
  private rendered = '';

  constructor(options: ViewOptions) {
    this.options = options;
  }

  setSessions(sessions: Session[]): void {
    this.sessions = sessions;
    this.rebuild();
  }

  setWorktreeStats(stats: Map<string, WorktreeStats>): void {
    this.stats = stats;
    this.rebuild();
  }

  setOptions(options: ViewOptions): void {
    this.options = options;
    this.rebuild();
  }

  /** Sessions after filtering, for badges and the status bar. */
  visible(): Session[] {
    return this.filtered();
  }

  getTreeItem(element: Node): vscode.TreeItem {
    return element;
  }

  getChildren(element?: Node): Node[] {
    if (!element) return this.roots;
    return element instanceof GroupItem ? element.children : [];
  }

  getParent(): undefined {
    return undefined;
  }

  private workspaceRepoRoots(): Set<string> {
    const out = new Set<string>();
    for (const f of vscode.workspace.workspaceFolders ?? []) {
      const root = repoRootOf(f.uri.fsPath) ?? f.uri.fsPath;
      out.add(path.resolve(root));
    }
    return out;
  }

  private filtered(): Session[] {
    const o = this.options;
    const repoRoots = o.scope === 'workspace' ? this.workspaceRepoRoots() : undefined;
    return this.sessions.filter((s) => {
      const archived = s.archived || o.locallyArchived.has(`${s.tool}:${s.id}`);
      if (archived && !o.showArchived) return false;
      if (s.subagent && !o.showSubagents) return false;
      if (s.empty && !o.showEmpty && !isLive(s.state)) return false;
      if (repoRoots) {
        const root = s.worktree?.repoRoot ?? repoRootOf(s.cwd) ?? s.cwd;
        if (!root || !repoRoots.has(path.resolve(root))) return false;
      }
      return true;
    });
  }

  private rebuild(): void {
    const o = this.options;
    const all = this.filtered();
    const live = all.filter((s) => isLive(s.state)).sort(byStateThenRecency);
    const history = all.filter((s) => !isLive(s.state)).sort(byRecency).slice(0, o.historyLimit);
    const shown = [...live, ...history];
    const item = (s: Session, showTool = true) =>
      new SessionItem(s, o.locallyArchived.has(`${s.tool}:${s.id}`), showTool, s.worktree ? this.stats.get(s.worktree.path) : undefined);

    switch (o.groupBy) {
      case 'none':
        this.roots = shown.sort(byStateThenRecency).map((s) => item(s));
        break;
      case 'activity': {
        const groups: Node[] = [];
        if (live.length) groups.push(new GroupItem('live', 'Live', live.map((s) => item(s)), new vscode.ThemeIcon('pulse'), true));
        if (history.length) groups.push(new GroupItem('history', 'History', history.map((s) => item(s)), new vscode.ThemeIcon('history'), true));
        this.roots = groups;
        break;
      }
      case 'tool': {
        const groups: Node[] = [];
        for (const tool of ['claude', 'codex'] as const) {
          const mine = shown.filter((s) => s.tool === tool).sort(byStateThenRecency);
          if (mine.length) groups.push(new GroupItem(tool, toolLabel(tool), mine.map((s) => item(s, false)), toolIcon(tool), true));
        }
        this.roots = groups;
        break;
      }
      case 'repository': {
        const buckets = new Map<string, Session[]>();
        for (const s of shown) {
          const root = s.worktree?.repoRoot ?? repoRootOf(s.cwd) ?? s.cwd ?? '(unknown)';
          const list = buckets.get(root) ?? [];
          list.push(s);
          buckets.set(root, list);
        }
        const workspaceRoots = this.workspaceRepoRoots();
        this.roots = [...buckets.entries()]
          .sort((a, b) => {
            const aw = workspaceRoots.has(path.resolve(a[0])) ? 0 : 1;
            const bw = workspaceRoots.has(path.resolve(b[0])) ? 0 : 1;
            return aw - bw || Math.max(...b[1].map((s) => s.updatedAt)) - Math.max(...a[1].map((s) => s.updatedAt));
          })
          .map(([root, list]) => {
            const label = path.basename(root) || root;
            const expanded = workspaceRoots.has(path.resolve(root)) || list.some((s) => isLive(s.state));
            return new GroupItem(root, label, list.sort(byStateThenRecency).map((s) => item(s)), new vscode.ThemeIcon('repo'), expanded);
          });
        break;
      }
    }
    // VS Code shows the view's progress bar on every data-change event. Refreshes
    // arrive every few hundred milliseconds while an agent writes its transcript,
    // so firing unconditionally kept that bar flickering at the top of the view.
    // Fire only when something the rows display has actually changed.
    const rendered = JSON.stringify(this.roots.map(renderKey));
    if (rendered === this.rendered) return;
    this.rendered = rendered;
    this.changed.fire(undefined);
  }
}

/** Everything a row shows, so equal keys mean an equal picture. */
function renderKey(node: Node): unknown {
  const icon = node.iconPath;
  const iconKey =
    icon instanceof vscode.ThemeIcon ? `${icon.id}:${icon.color?.id ?? ''}`
    : typeof icon === 'object' && icon !== null && 'dark' in icon ? String(icon.dark)
    : String(icon);
  const base = [node.id, node.label, node.description, node.contextValue, node.collapsibleState, iconKey];
  return node instanceof GroupItem ? [...base, node.children.map(renderKey)] : base;
}
