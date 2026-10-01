import * as path from 'node:path';
import * as vscode from 'vscode';
import { isLive, toolLabel, type Session, type SessionState } from './types.js';
import { relativeTime, repoRootOf } from './util.js';
import { statsInline, type WorktreeStats } from './worktree.js';
import { stateIcon, toolIcon } from './icons.js';

export type GroupBy = 'activity' | 'repository' | 'tool' | 'none';

/** How long a finished subagent stays under its parent before it is folded away (unless all are shown). */
export const SUBAGENT_LINGER_MS = 5 * 60_000;

/** A spawned session worth a row by default: still working, or finished within the linger window. */
function recentSubagent(s: Session, now = Date.now()): boolean {
  return isLive(s.state) || now - s.updatedAt < SUBAGENT_LINGER_MS;
}

/** Where a spawned session is shown: under its own parent, under its top session's thread directly, or as a row. */
export type SubagentLayout = 'nested' | 'flat' | 'root';

const sessionKey = (s: Session): string => `${s.tool}:${s.id}`;
const parentKeyOf = (s: Session): string | undefined => (s.subagent && s.parentId ? `${s.parentTool ?? s.tool}:${s.parentId}` : undefined);

/**
 * Rows, and per session key the spawned sessions shown under it. A spawned session is kept while it is recent (or
 * always, with `showAll`); in the nested layout so is an older one whose own descendants are kept, so the chain to
 * them stays whole. A spawned session whose parent is not among `sessions` is a row of its own.
 */
export function arrangeSubagents(sessions: Session[], layout: SubagentLayout, showAll: boolean, now = Date.now()): { rows: Session[]; childrenOf: Map<string, Session[]> } {
  const byKey = new Map(sessions.map((s) => [sessionKey(s), s]));
  const parentOf = (s: Session): Session | undefined => {
    const key = parentKeyOf(s);
    const parent = key ? byKey.get(key) : undefined;
    return parent === s ? undefined : parent;
  };
  const spawned = new Map<string, Session[]>();
  for (const s of sessions) {
    const parent = parentOf(s);
    if (!parent) continue;
    const list = spawned.get(sessionKey(parent)) ?? [];
    list.push(s);
    spawned.set(sessionKey(parent), list);
  }
  const recent = (s: Session) => showAll || recentSubagent(s, now);
  // Memoised, with the in-progress mark doubling as a guard against a cycle in bad data.
  const kept = new Map<string, boolean>();
  const keep = (s: Session): boolean => {
    const key = sessionKey(s);
    const known = kept.get(key);
    if (known !== undefined) return known;
    kept.set(key, false);
    const result = recent(s) || (layout === 'nested' && (spawned.get(key) ?? []).some(keep));
    kept.set(key, result);
    return result;
  };
  const top = (s: Session): Session => {
    let at = s;
    for (let depth = 0, up = parentOf(at); up && depth < 32; depth++, up = parentOf(at)) at = up;
    return at;
  };
  const rows: Session[] = [];
  const childrenOf = new Map<string, Session[]>();
  const add = (under: Session, s: Session) => {
    const list = childrenOf.get(sessionKey(under)) ?? [];
    list.push(s);
    childrenOf.set(sessionKey(under), list);
  };
  for (const s of sessions) {
    if (!s.subagent) {
      rows.push(s);
      continue;
    }
    if (!keep(s)) continue;
    const parent = parentOf(s);
    if (!parent || layout === 'root') rows.push(s);
    else if (layout === 'nested') add(parent, s);
    else {
      // A flat thread hangs off its top session; a top session that is itself spawned and not kept has no row.
      const head = top(s);
      if (head.subagent && !keep(head)) rows.push(s);
      else add(head, s);
    }
  }
  for (const list of childrenOf.values()) list.sort(byStart);
  return { rows, childrenOf };
}

export interface ViewOptions {
  groupBy: GroupBy;
  scope: 'all' | 'workspace';
  showArchived: boolean;
  showSubagents: boolean;
  subagentLayout: SubagentLayout;
  showEmpty: boolean;
  historyLimit: number;
  /** Sessions archived from this view (kept in this extension's own state). */
  locallyArchived: ReadonlySet<string>;
  pinned: ReadonlySet<string>;
}

export class SessionItem extends vscode.TreeItem {
  constructor(
    public readonly session: Session,
    public readonly archivedHere: boolean,
    showTool: boolean,
    stats: WorktreeStats | undefined,
    idPrefix = '',
    pinned = false,
    idSuffix = '',
    /** Subagents and teammates this session spawned, shown under it. */
    public readonly children: SessionItem[] = [],
  ) {
    // A session's thread opens collapsed; inside it, every spawned session's own subtree is already open.
    super(session.title, !children.length ? vscode.TreeItemCollapsibleState.None : session.subagent ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed);
    const archived = session.archived || archivedHere;
    this.id = `${idPrefix}${session.tool}:${session.id}${idSuffix}`;
    this.iconPath = stateIcon(session.tool, session.state, archived);
    this.description = `${pinned ? '📌 ' : ''}${describe(session, showTool, stats)}`;
    this.tooltip = tooltipFor(session, archived, stats);
    if (pinned) this.tooltip.appendMarkdown('\n\n$(pin) Pinned to Active');
    this.contextValue = ['session', session.tool, archived ? 'archived' : '', pinned ? 'pinned' : '', isLive(session.state) ? 'live' : 'stopped', session.subagent ? 'subagent' : '']
      .filter(Boolean)
      .join('-');
    // A spawned agent has no panel of its own to resume; its transcript is what there is to see.
    this.command = session.subagent
      ? { command: 'agentSessions.openTranscript', title: 'Open Transcript', arguments: [this] }
      : { command: 'agentSessions.open', title: 'Open Session', arguments: [this] };
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
  if (session.agentRole) parts.push(session.agentRole);
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
  md.appendMarkdown(`${toolLabel(session.tool)} · ${STATE_LABEL[session.state]}${session.inThisWindow ? ' · **this window**' : ''}${archived ? ' · archived' : ''}${session.subagent ? (session.agentRole === 'teammate' ? ' · teammate' : ' · subagent') : ''}\n\n`);
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

/** Live rows: newest session first, by start time, so the order holds still while agents work and reply. */
function byStart(a: Session, b: Session): number {
  return b.startedAt - a.startedAt || byRecency(a, b);
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
  /** Per session, how many times its row identity was retired to drop a selection (see `dropSelection`). */
  private readonly retired = new Map<string, number>();
  /** Whether the first scan has landed, and whether the view has been told (see `announceLoaded`). */
  private scanned = false;
  private announced = false;

  /** `onLoaded` runs once, when the view has the first scan's rows, so its empty state can stop saying "loading". */
  constructor(options: ViewOptions, private readonly onLoaded: () => void) {
    this.options = options;
  }

  setSessions(sessions: Session[]): void {
    this.sessions = sessions;
    this.scanned = true;
    this.rebuild();
    // No rows means no change event and no fetch to wait for: the empty state is already the answer.
    if (!this.roots.length) this.announceLoaded();
  }

  private announceLoaded(): void {
    if (this.announced) return;
    this.announced = true;
    this.onLoaded();
  }

  setWorktreeStats(stats: Map<string, WorktreeStats>): void {
    this.stats = stats;
    this.rebuild();
  }

  setOptions(options: ViewOptions): void {
    this.options = options;
    this.rebuild();
  }

  /** Sessions after filtering, for badges and the status bar: the rows themselves, not the spawned sessions nested under them. */
  visible(): Session[] {
    return this.topLevel(this.filtered()).all;
  }

  /** Split the filtered sessions into rows and the spawned sessions shown under them (see `arrangeSubagents`). */
  private topLevel(sessions: Session[]): { all: Session[]; childrenOf: Map<string, Session[]> } {
    const { rows, childrenOf } = arrangeSubagents(sessions, this.options.subagentLayout, this.options.showSubagents);
    return { all: rows, childrenOf };
  }

  getTreeItem(element: Node): vscode.TreeItem {
    return element;
  }

  getChildren(element?: Node): Node[] {
    if (!element) {
      // Announced from the fetch itself, so the rows reach the view before its "no sessions" state could show.
      if (this.scanned) this.announceLoaded();
      return this.roots;
    }
    return element.children;
  }

  getParent(element: Node): Node | undefined {
    if (!(element instanceof SessionItem)) return undefined;
    for (const [node, parent] of this.walk()) if (node === element) return parent;
    return undefined;
  }

  /** Every node with its parent: groups, their sessions, and the spawned sessions nested under those. */
  private *walk(): Generator<[Node, Node | undefined]> {
    const visit = function* (node: Node, parent: Node | undefined): Generator<[Node, Node | undefined]> {
      yield [node, parent];
      for (const child of node.children) yield* visit(child, node);
    };
    for (const root of this.roots) yield* visit(root, undefined);
  }

  /**
   * Deselect a row. The tree API has no way to clear a selection, but the view restores selection by element id
   * across a refresh and drops ids that are gone, so the row is rebuilt under a fresh id.
   */
  dropSelection(item: SessionItem): void {
    const key = `${item.session.tool}:${item.session.id}`;
    this.retired.set(key, (this.retired.get(key) ?? 0) + 1);
    this.rebuild();
  }

  /** The row showing a session, for `TreeView.reveal`. */
  itemFor(tool: Session['tool'], id: string): SessionItem | undefined {
    for (const [node] of this.walk()) if (node instanceof SessionItem && node.session.tool === tool && node.session.id === id) return node;
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
    const byKey = new Map(this.sessions.map((s) => [`${s.tool}:${s.id}`, s]));
    // Archiving a session puts away what it spawned too; otherwise its subagents would lose their parent row and
    // stand alone in the list. The chain is followed up to the top, with a guard against a cycle in bad data.
    const archivedWithAncestors = (s: Session): boolean => {
      for (let at: Session | undefined = s, depth = 0; at && depth < 32; depth++) {
        if (at.archived || o.locallyArchived.has(`${at.tool}:${at.id}`)) return true;
        at = at.subagent && at.parentId ? byKey.get(`${at.parentTool ?? at.tool}:${at.parentId}`) : undefined;
      }
      return false;
    };
    return this.sessions.filter((s) => {
      if (!o.showArchived && archivedWithAncestors(s)) return false;
      // Spawned sessions stay in: `topLevel` nests them under their parent and drops the parentless unless switched on.
      if (s.empty && !s.subagent && !o.showEmpty && !isLive(s.state) && !o.pinned.has(`${s.tool}:${s.id}`)) return false;
      if (repoRoots) {
        const root = s.worktree?.repoRoot ?? repoRootOf(s.cwd) ?? s.cwd;
        if (!root || !repoRoots.has(path.resolve(root))) return false;
      }
      return true;
    });
  }

  private rebuild(): void {
    const o = this.options;
    const { all, childrenOf } = this.topLevel(this.filtered());
    const isPinned = (s: Session) => o.pinned.has(`${s.tool}:${s.id}`);
    // A session another agent was handed keeps working after its parent stops; the parent stays with it in Active.
    const working = (s: Session) => isLive(s.state) || (childrenOf.get(`${s.tool}:${s.id}`) ?? []).some((c) => isLive(c.state));
    const active = all.filter((s) => working(s) || isPinned(s)).sort((a, b) => Number(isPinned(b)) - Number(isPinned(a)) || byStart(a, b));
    const history = all.filter((s) => !working(s) && !isPinned(s)).sort(byRecency).slice(0, o.historyLimit);
    const shown = [...active, ...history];
    const item = (s: Session, showTool = true): SessionItem =>
      new SessionItem(s, o.locallyArchived.has(`${s.tool}:${s.id}`), showTool, s.worktree ? this.stats.get(s.worktree.path) : undefined, '', isPinned(s), retiredSuffix(s),
        (childrenOf.get(`${s.tool}:${s.id}`) ?? []).map((c) => item(c, false)));
    const retiredSuffix = (s: Session) => {
      const n = this.retired.get(`${s.tool}:${s.id}`);
      return n ? `#${n}` : '';
    };

    switch (o.groupBy) {
      case 'none':
        this.roots = shown.map((s) => item(s));
        break;
      case 'activity': {
        const groups: Node[] = [];
        if (active.length) groups.push(new GroupItem('active', 'Active', active.map((s) => item(s)), new vscode.ThemeIcon('pulse'), true));
        if (history.length) groups.push(new GroupItem('history', 'History', history.map((s) => item(s)), new vscode.ThemeIcon('history'), true));
        this.roots = groups;
        break;
      }
      case 'tool': {
        const groups: Node[] = [];
        for (const tool of ['claude', 'codex'] as const) {
          const mine = shown.filter((s) => s.tool === tool);
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
            const expanded = workspaceRoots.has(path.resolve(root)) || list.some((s) => isLive(s.state) || isPinned(s));
            return new GroupItem(root, label, list.map((s) => item(s)), new vscode.ThemeIcon('repo'), expanded);
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

/** A tree row with the rows nested under it. */
export interface Row extends vscode.TreeItem {
  readonly children: readonly Row[];
}

/** Everything a row shows, so equal keys mean an equal picture. */
export function renderKey(node: Row): unknown {
  const icon = node.iconPath;
  const iconKey =
    icon instanceof vscode.ThemeIcon ? `${icon.id}:${icon.color?.id ?? ''}`
    : typeof icon === 'object' && icon !== null && 'dark' in icon ? String(icon.dark)
    : String(icon);
  const base = [node.id, node.label, node.description, node.contextValue, node.collapsibleState, iconKey];
  return node.children.length ? [...base, node.children.map(renderKey)] : base;
}
