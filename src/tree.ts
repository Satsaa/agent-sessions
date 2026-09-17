import * as path from 'node:path';
import * as vscode from 'vscode';
import { isLive, STATE_ORDER, toolLabel, type Session, type SessionState } from './types.js';
import { relativeTime, repoRootOf, worktreeName } from './util.js';

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
  ) {
    super(session.title, vscode.TreeItemCollapsibleState.None);
    const archived = session.archived || archivedHere;
    this.id = `${session.tool}:${session.id}`;
    this.iconPath = iconFor(session.state, archived);
    this.description = describe(session, showTool);
    this.tooltip = tooltipFor(session, archived);
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
    icon: vscode.ThemeIcon | undefined,
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

function iconFor(state: SessionState, archived: boolean): vscode.ThemeIcon {
  if (archived) return new vscode.ThemeIcon('archive', new vscode.ThemeColor('disabledForeground'));
  switch (state) {
    case 'running':
      return new vscode.ThemeIcon('sync~spin', new vscode.ThemeColor('charts.green'));
    case 'waiting':
      return new vscode.ThemeIcon('bell-dot', new vscode.ThemeColor('charts.orange'));
    case 'replied':
      return new vscode.ThemeIcon('comment-discussion', new vscode.ThemeColor('charts.blue'));
    case 'stopped':
      return new vscode.ThemeIcon('circle-outline', new vscode.ThemeColor('disabledForeground'));
  }
}

const STATE_LABEL: Record<SessionState, string> = {
  running: 'Working',
  waiting: 'Needs your input',
  replied: 'Replied, waiting for you',
  stopped: 'Stopped',
};

function describe(session: Session, showTool: boolean): string {
  const parts: string[] = [];
  if (showTool) parts.push(toolLabel(session.tool));
  const wt = worktreeName(session.cwd);
  if (wt) parts.push(`⎇ ${wt}`);
  else if (session.branch) parts.push(session.branch);
  parts.push(relativeTime(session.updatedAt));
  return parts.join(' · ');
}

function tooltipFor(session: Session, archived: boolean): vscode.MarkdownString {
  const md = new vscode.MarkdownString(undefined, true);
  md.isTrusted = true;
  md.appendMarkdown(`**${escapeMd(session.title)}**\n\n`);
  md.appendMarkdown(`${toolLabel(session.tool)} · ${STATE_LABEL[session.state]}${archived ? ' · archived' : ''}${session.subagent ? ' · subagent' : ''}\n\n`);
  if (session.cwd) md.appendMarkdown(`$(folder) \`${session.cwd}\`\n\n`);
  if (session.branch) md.appendMarkdown(`$(git-branch) \`${session.branch}\`\n\n`);
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
  private options: ViewOptions;
  private roots: Node[] = [];

  constructor(options: ViewOptions) {
    this.options = options;
  }

  setSessions(sessions: Session[]): void {
    this.sessions = sessions;
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
        const root = repoRootOf(s.cwd) ?? s.cwd;
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
    const item = (s: Session, showTool = true) => new SessionItem(s, o.locallyArchived.has(`${s.tool}:${s.id}`), showTool);

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
          if (mine.length) groups.push(new GroupItem(tool, toolLabel(tool), mine.map((s) => item(s, false)), undefined, true));
        }
        this.roots = groups;
        break;
      }
      case 'repository': {
        const buckets = new Map<string, Session[]>();
        for (const s of shown) {
          const root = repoRootOf(s.cwd) ?? s.cwd ?? '(unknown)';
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
    this.changed.fire(undefined);
  }
}
