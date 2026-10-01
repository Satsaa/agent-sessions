import * as path from 'node:path';
import * as vscode from 'vscode';
import { SessionItem, arrangeSubagents, renderKey, type SubagentLayout } from './tree.js';
import { isLive, type Session } from './types.js';
import { statsInline, type RepoWorktree, type WorktreeStats } from './worktree.js';

const RECENT_STOPPED = 3;

export class WorktreeItem extends vscode.TreeItem {
  constructor(
    public readonly worktree: RepoWorktree,
    public readonly stats: WorktreeStats | undefined,
    public readonly sessions: Session[],
    locallyArchived: ReadonlySet<string>,
    pinned: ReadonlySet<string>,
    childrenOf: ReadonlyMap<string, Session[]>,
  ) {
    super(worktree.isMain ? `${worktree.name} (main checkout)` : worktree.name, sessions.length ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.None);
    this.id = `worktree:${worktree.path}`;
    this.contextValue = worktree.isMain ? 'worktree-main' : 'worktree';
    this.iconPath = iconFor(worktree, stats, sessions);
    this.description = describe(worktree, stats, sessions);
    this.tooltip = tooltip(worktree, stats, sessions);
    this.resourceUri = vscode.Uri.file(worktree.path);
    const item = (s: Session, showTool: boolean): SessionItem =>
      new SessionItem(s, locallyArchived.has(`${s.tool}:${s.id}`), showTool, undefined, `wt:${worktree.path}:`, pinned.has(`${s.tool}:${s.id}`), '',
        (childrenOf.get(`${s.tool}:${s.id}`) ?? []).map((c) => item(c, false)));
    this.children = sessions.map((s) => item(s, true));
  }

  readonly children: SessionItem[];
}

/** A repository's linked worktrees that no session uses, collapsed as its last row. */
class InactiveItem extends vscode.TreeItem {
  constructor(
    root: string,
    public readonly children: WorktreeItem[],
  ) {
    super('Inactive', vscode.TreeItemCollapsibleState.Collapsed);
    this.id = `worktree-inactive:${root}`;
    this.contextValue = 'worktree-group';
    this.iconPath = new vscode.ThemeIcon('folder');
    this.description = `${children.length}`;
    this.tooltip = 'Worktrees no session is bound to. Archived sessions do not count; stopped ones do.';
  }
}

class RepoItem extends vscode.TreeItem {
  constructor(
    public readonly root: string,
    public readonly children: (WorktreeItem | InactiveItem)[],
    linked: number,
  ) {
    super(path.basename(root) || root, vscode.TreeItemCollapsibleState.Expanded);
    this.id = `worktree-repo:${root}`;
    this.contextValue = 'worktree-repo';
    this.iconPath = new vscode.ThemeIcon('repo');
    this.description = `${linked} worktree${linked === 1 ? '' : 's'}`;
    this.tooltip = root;
  }
}

type Node = RepoItem | InactiveItem | WorktreeItem | SessionItem;

function iconFor(wt: RepoWorktree, stats: WorktreeStats | undefined, sessions: Session[]): vscode.ThemeIcon {
  if (stats?.gone || wt.prunable) return new vscode.ThemeIcon('warning', new vscode.ThemeColor('charts.orange'));
  const live = sessions.filter((s) => isLive(s.state));
  if (live.some((s) => s.state === 'waiting')) return new vscode.ThemeIcon('bell-dot', new vscode.ThemeColor('charts.orange'));
  if (live.some((s) => s.state === 'running')) return new vscode.ThemeIcon('sync~spin', new vscode.ThemeColor('charts.green'));
  if (live.length) return new vscode.ThemeIcon('comment-discussion', new vscode.ThemeColor('charts.blue'));
  return new vscode.ThemeIcon(wt.isMain ? 'repo' : 'git-branch');
}

function describe(wt: RepoWorktree, stats: WorktreeStats | undefined, sessions: Session[]): string {
  const parts: string[] = [];
  const branch = stats?.branch ?? wt.branch;
  if (branch) parts.push(branch);
  else if (wt.detached) parts.push(`detached ${wt.head?.slice(0, 7) ?? ''}`.trim());
  if (stats?.gone) parts.push('gone');
  else if (stats) {
    const inline = statsInline(stats);
    if (inline) parts.push(inline);
  }
  const live = sessions.filter((s) => isLive(s.state)).length;
  if (live) parts.push(`${live} agent${live === 1 ? '' : 's'}`);
  return parts.join(' · ');
}

function changesText(stats: WorktreeStats): string {
  if (stats.changedFiles === undefined) return 'status unavailable';
  if (!stats.changedFiles) return 'clean';
  const files: string[] = [];
  if (stats.staged) files.push(`${stats.staged} staged`);
  if (stats.unstaged) files.push(`${stats.unstaged} unstaged`);
  if (stats.untracked) files.push(`${stats.untracked} untracked`);
  return `+${stats.insertions ?? '?'} −${stats.deletions ?? '?'} lines (${files.join(', ')})`;
}

function tooltip(wt: RepoWorktree, stats: WorktreeStats | undefined, sessions: Session[]): vscode.MarkdownString {
  const md = new vscode.MarkdownString(undefined, true);
  md.appendMarkdown(`**${wt.name}**${wt.isMain ? ' — main checkout' : ''}\n\n\`${wt.path}\`\n\n`);
  const branch = stats?.branch ?? wt.branch;
  if (branch) md.appendMarkdown(`$(git-branch) \`${branch}\`\n\n`);
  else if (wt.detached) md.appendMarkdown(`$(git-commit) detached at \`${wt.head?.slice(0, 12) ?? '?'}\`\n\n`);
  if (stats && !stats.gone) {
    if (stats.base) md.appendMarkdown(`$(arrow-swap) ${stats.commitsAhead ?? '?'} ahead, ${stats.commitsBehind ?? '?'} behind \`${stats.base}\`\n\n`);
    md.appendMarkdown(`$(diff) ${changesText(stats)}\n\n`);
  }
  if (wt.locked) md.appendMarkdown(`$(lock) locked: ${wt.locked}\n\n`);
  if (wt.prunable) md.appendMarkdown(`$(warning) prunable: ${wt.prunable}\n\n`);
  const live = sessions.filter((s) => isLive(s.state));
  md.appendMarkdown(live.length ? `$(hubot) ${live.map((s) => s.title).join(', ')}` : '$(hubot) no live agent');
  return md;
}

/** Live sessions first (by start time, which holds still), then stopped ones by recency. */
function byLiveThenTime(a: Session, b: Session): number {
  const la = isLive(a.state) ? 0 : 1;
  const lb = isLive(b.state) ? 0 : 1;
  if (la !== lb) return la - lb;
  return la === 0 ? b.startedAt - a.startedAt : b.updatedAt - a.updatedAt;
}

export class WorktreesProvider implements vscode.TreeDataProvider<Node> {
  private readonly changed = new vscode.EventEmitter<Node | undefined>();
  readonly onDidChangeTreeData = this.changed.event;
  private roots: Node[] = [];
  /** What the view last rendered; as in the Sessions view, a rebuild that changes nothing visible fires no event. */
  private rendered = '';

  /** Every worktree found, with stats and the sessions bound to it. */
  set(worktrees: RepoWorktree[], stats: Map<string, WorktreeStats>, sessions: Session[], locallyArchived: ReadonlySet<string>, pinned: ReadonlySet<string>, showAllSubagents: boolean, layout: SubagentLayout = 'nested'): void {
    // Spawned sessions sit under their parent as in the Sessions view; only the root layout makes them rows of a worktree.
    const { rows: sessionRows, childrenOf } = arrangeSubagents(sessions, layout, showAllSubagents);
    const rowKeys = new Set(sessionRows.filter((s) => !s.subagent || layout === 'root').map((s) => `${s.tool}:${s.id}`));
    const byPath = new Map<string, Session[]>();
    for (const s of sessions) {
      const key = s.worktree?.path ?? (s.cwd ? path.resolve(s.cwd) : undefined);
      if (!key) continue;
      const list = byPath.get(key) ?? [];
      list.push(s);
      byPath.set(key, list);
    }
    const assigned = (wt: RepoWorktree): Session[] => {
      const isPinned = (s: Session) => pinned.has(`${s.tool}:${s.id}`);
      const all = (byPath.get(wt.path) ?? []).filter((s) => !s.archived && !locallyArchived.has(`${s.tool}:${s.id}`) && rowKeys.has(`${s.tool}:${s.id}`))
        .sort((a, b) => Number(isPinned(b)) - Number(isPinned(a)) || byLiveThenTime(a, b));
      const working = (s: Session) => isLive(s.state) || (childrenOf.get(`${s.tool}:${s.id}`) ?? []).some((c) => isLive(c.state));
      const active = all.filter((s) => working(s) || isPinned(s));
      const stopped = all.filter((s) => !working(s) && !isPinned(s) && !s.empty).slice(0, RECENT_STOPPED);
      return [...active, ...stopped];
    };
    // Any session not archived keeps its worktree in use, a stopped one included; one that never got a prompt
    // is not a use unless it is live.
    const used = (wt: RepoWorktree): boolean => (byPath.get(wt.path) ?? [])
      .some((s) => !s.archived && !locallyArchived.has(`${s.tool}:${s.id}`) && (!s.empty || isLive(s.state)));
    const byRepo = new Map<string, WorktreeItem[]>();
    for (const wt of worktrees) {
      const list = byRepo.get(wt.repoRoot) ?? [];
      list.push(new WorktreeItem(wt, stats.get(wt.path), assigned(wt), locallyArchived, pinned, childrenOf));
      byRepo.set(wt.repoRoot, list);
    }
    const rows = (root: string, items: WorktreeItem[]): (WorktreeItem | InactiveItem)[] => {
      const inactive = items.filter((i) => !i.worktree.isMain && !used(i.worktree));
      if (!inactive.length) return items;
      return [...items.filter((i) => !inactive.includes(i)), new InactiveItem(root, inactive)];
    };
    const repos = [...byRepo.entries()];
    this.roots = repos.length === 1
      ? rows(repos[0]![0], repos[0]![1])
      : repos.map(([root, items]) => new RepoItem(root, rows(root, items), items.filter((i) => !i.worktree.isMain).length));
    const rendered = JSON.stringify(this.roots.map(renderKey));
    if (rendered === this.rendered) return;
    this.rendered = rendered;
    this.changed.fire(undefined);
  }

  getTreeItem(element: Node): vscode.TreeItem {
    return element;
  }

  getChildren(element?: Node): Node[] {
    if (!element) return this.roots;
    return element.children;
  }

  getParent(): undefined {
    return undefined;
  }
}
