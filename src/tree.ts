import * as path from 'node:path';
import * as vscode from 'vscode';
import { isLive, toolLabel, type Session, type SessionState } from './types.js';
import { relativeTime, repoRootOf } from './util.js';
import { statsInline, type WorktreeStats } from './worktree.js';
import { stateIcon, toolIcon } from './icons.js';
import { hasNotes, noteCounts, type Answer, type NoteKind, type Question, type SessionDone, type SessionNotes, type Task } from './notes.js';

export type GroupBy = 'activity' | 'repository' | 'tool' | 'none';

/** The order of the Active rows; pinned sessions lead whichever is chosen. */
export type ActiveSort = 'newest' | 'oldest' | 'activity' | 'attention' | 'title';

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
  activeSort: ActiveSort;
  /** Archived sessions still in use (see `archivedOutOfUse`) are listed anyway. */
  showActiveArchived: boolean;
  showEmpty: boolean;
  historyLimit: number;
  /** Sessions archived from this view (kept in this extension's own state). */
  locallyArchived: ReadonlySet<string>;
  pinned: ReadonlySet<string>;
  /** Sessions moved to Backlog: listed there whatever their state, until moved out or pinned. */
  backlog: ReadonlySet<string>;
  /** Sessions shown in a tab of this window, by `tool:id`. */
  open: ReadonlySet<string>;
  /** Words every shown session must match; empty shows the list as usual (see `matchesSearch`). */
  search: string;
  /** What a session's row says after its title, in this order (see `describe`). */
  rowDetails: readonly RowDetail[];
  /** Each session's recorded tasks, answers and questions, by `tool:id` (notes.ts). */
  notes: ReadonlyMap<string, SessionNotes>;
}

/**
 * A part of a session row's description. `edits` is a worktree's commits ahead and behind and its changed lines; it
 * stands with the worktree's name when both are shown.
 */
export const ROW_DETAILS = ['questions', 'tasks', 'worktree', 'edits', 'age'] as const;
export type RowDetail = (typeof ROW_DETAILS)[number];

/**
 * Whether a session matches every word of a search, ignoring case: in its title, tool, role, worktree, branch,
 * folder or id.
 */
export function matchesSearch(s: Session, search: string): boolean {
  const text = [s.title, toolLabel(s.tool), s.agentRole, s.worktree?.name, s.worktree?.branch, s.branch, s.cwd, s.id].filter(Boolean).join('\n').toLowerCase();
  return search.toLowerCase().split(/\s+/).filter(Boolean).every((word) => text.includes(word));
}

/** A row whose tooltip is built when the pointer reaches it (see `resolveTooltip`). */
interface HoverTooltip {
  readonly tooltipOnHover: () => vscode.MarkdownString;
}

const oneLine = (text: string): string => {
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length > 140 ? `${line.slice(0, 139)}…` : line;
};

/** One recorded task, answer or question, under its session's notes row. */
export class NoteItem extends vscode.TreeItem implements HoverTooltip {
  readonly children: readonly never[] = [];
  readonly tooltipOnHover: () => vscode.MarkdownString;

  constructor(public readonly session: Session, public readonly kind: NoteKind, public readonly note: Task | Answer | Question, idPrefix: string) {
    super(oneLine(note.text), vscode.TreeItemCollapsibleState.None);
    this.id = `${idPrefix}/${note.id}`;
    const unread = kind === 'answer' && note.state === 'answered' && !(note as Answer).read;
    // `note-<kind>-<state>[-unread]`: what the menus' when-clauses and the row action picker read (row-actions.ts).
    this.contextValue = `note-${kind}-${note.state}${unread ? '-unread' : ''}`;
    const faded = new vscode.ThemeColor('disabledForeground');
    // The icon and its colour say the state, so the description is only how long ago it last changed.
    this.iconPath =
      note.state === 'stale' || note.state === 'dropped' ? new vscode.ThemeIcon('circle-slash', faded)
      : kind === 'task' ? (note.state === 'done' ? new vscode.ThemeIcon('pass', faded) : new vscode.ThemeIcon('circle-large-outline'))
      : kind === 'question' ? new vscode.ThemeIcon('question', note.state === 'open' ? new vscode.ThemeColor('charts.red') : faded)
      : note.state === 'answered' ? (unread ? new vscode.ThemeIcon('mail', new vscode.ThemeColor('charts.green')) : new vscode.ThemeIcon('mail-read', faded))
      : new vscode.ThemeIcon('comment', new vscode.ThemeColor('charts.yellow'));
    const said = kind === 'task' ? (note as Task).resolution : (note as Answer | Question).answer;
    const changedAt = kind === 'task' ? (note as Task).closedAt : (note as Answer | Question).answeredAt;
    this.description = relativeTime(note.state === 'stale' ? note.at : (changedAt ?? note.at));
    this.tooltipOnHover = () => {
      const md = new vscode.MarkdownString(undefined, true);
      md.appendMarkdown(`**${escapeMd(note.text)}**\n\n`);
      if (kind === 'question' && note.state === 'open') md.appendMarkdown('Waiting for you\n\n');
      if (said !== undefined) md.appendMarkdown(`${said}\n\n`);
      md.appendMarkdown(`$(clock) ${new Date(note.at).toLocaleString()} · \`${note.id}\``);
      return md;
    };
    // A note opens as a page with what was said of it; opening an answer marks it read.
    this.command = { command: 'agentSessions.note.open', title: 'Open', arguments: [this] };
  }
}

/** The row of a session its agent closed (notes.ts), opening what it said it delivered, did with its tickets and cleaned up. */
export class DoneItem extends vscode.TreeItem implements HoverTooltip {
  readonly children: readonly never[] = [];
  readonly tooltipOnHover: () => vscode.MarkdownString;

  constructor(public readonly session: Session, public readonly done: SessionDone, idPrefix: string) {
    super('Done', vscode.TreeItemCollapsibleState.None);
    this.id = `${idPrefix}/done`;
    this.description = `${oneLine(done.features)} · ${relativeTime(done.at)}`;
    this.iconPath = new vscode.ThemeIcon('pass-filled', new vscode.ThemeColor('charts.green'));
    this.contextValue = 'note-done';
    this.tooltipOnHover = () => {
      const md = new vscode.MarkdownString(undefined, true);
      md.appendMarkdown(`**Features**\n\n${done.features}\n\n**Tickets**\n\n${done.tickets}\n\n**Cleanup**\n\n${done.cleanup}\n\n$(clock) ${new Date(done.at).toLocaleString()}`);
      return md;
    };
    this.command = { command: 'agentSessions.note.open', title: 'Open', arguments: [this] };
  }
}

/** A session's one row of notes: its questions, answers and tasks, named after the kinds it holds. */
export class NoteGroupItem extends vscode.TreeItem {
  constructor(public readonly children: NoteItem[], label: string, summary: string, idPrefix: string) {
    super(label, vscode.TreeItemCollapsibleState.Expanded);
    this.id = `${idPrefix}/notes`;
    this.description = summary;
    this.iconPath = new vscode.ThemeIcon('checklist');
    this.contextValue = 'notes';
  }
}

/**
 * What wants you first: a question waiting for you, then an unread answer, then what the agent still owes (answers
 * before tasks), then what is settled, and last what was set aside; each rank oldest first. A dropped task is no part
 * of the count.
 */
const QUESTION_ORDER: Record<Question['state'], number> = { open: 0, answered: 4, stale: 5 };
const ANSWER_ORDER: Record<Answer['state'], number> = { open: 2, answered: 4, stale: 5 };
const TASK_ORDER: Record<Task['state'], number> = { open: 3, done: 4, dropped: 5 };

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

function noteGroups(session: Session, notes: SessionNotes | undefined, idPrefix: string): (DoneItem | NoteGroupItem)[] {
  if (!notes) return [];
  const counts = noteCounts(notes);
  const groups: (DoneItem | NoteGroupItem)[] = [];
  if (notes.done) groups.push(new DoneItem(session, notes.done, idPrefix));
  if (notes.questions.length || notes.answers.length || notes.tasks.length) {
    const ranked = [
      ...notes.questions.map((q) => ({ rank: QUESTION_ORDER[q.state], item: new NoteItem(session, 'question', q, idPrefix), at: q.at })),
      ...notes.answers.map((a) => ({ rank: a.state === 'answered' && !a.read ? 1 : ANSWER_ORDER[a.state], item: new NoteItem(session, 'answer', a, idPrefix), at: a.at })),
      ...notes.tasks.map((t) => ({ rank: TASK_ORDER[t.state], item: new NoteItem(session, 'task', t, idPrefix), at: t.at })),
    ].sort((a, b) => a.rank - b.rank || a.at - b.at);
    const kinds = [notes.questions.length ? 'Questions' : '', notes.answers.length ? 'Answers' : '', notes.tasks.length ? 'Tasks' : ''].filter(Boolean);
    const label = kinds.length > 1 ? `${kinds.slice(0, -1).join(', ')} and ${kinds.at(-1)}` : kinds[0]!;
    const tasks = counts.tasksOpen + counts.tasksDone;
    const summary = [
      counts.questionsOpen ? `${plural(counts.questionsOpen, 'question')} for you` : '',
      counts.answersUnread ? plural(counts.answersUnread, 'new answer') : '',
      tasks ? `${counts.tasksDone}/${plural(tasks, 'task')} done` : '',
    ].filter(Boolean).join(' · ');
    groups.push(new NoteGroupItem(ranked.map((r) => r.item), label, summary, idPrefix));
  }
  return groups;
}

/** How a row shows a session: the details of its description, and the notes listed under it. */
export interface RowContent {
  details: readonly RowDetail[];
  notes?: SessionNotes | undefined;
}

export class SessionItem extends vscode.TreeItem implements HoverTooltip {
  readonly tooltipOnHover: () => vscode.MarkdownString;
  /** The session's Done and notes rows, listed before the sessions it spawned. */
  readonly notes: (DoneItem | NoteGroupItem)[];

  constructor(
    public readonly session: Session,
    public readonly archivedHere: boolean,
    content: RowContent,
    stats: WorktreeStats | undefined,
    idPrefix = '',
    pinned = false,
    idSuffix = '',
    /** Subagents and teammates this session spawned, shown under it. */
    public readonly children: SessionItem[] = [],
    backlog = false,
  ) {
    super(session.title, vscode.TreeItemCollapsibleState.None);
    const archived = session.archived || archivedHere;
    this.id = `${idPrefix}${session.tool}:${session.id}${idSuffix}`;
    this.notes = noteGroups(session, content.notes, this.id);
    // A session's thread opens collapsed, unless its notes row is the one thing under it;
    // inside a thread, every spawned session's own subtree is already open.
    const onlyNotes = !children.length && this.notes.some((row) => row instanceof NoteGroupItem);
    this.collapsibleState =
      !children.length && !hasNotes(content.notes) ? vscode.TreeItemCollapsibleState.None
      : session.subagent || onlyNotes ? vscode.TreeItemCollapsibleState.Expanded
      : vscode.TreeItemCollapsibleState.Collapsed;
    this.iconPath = stateIcon(session.tool, session.state, archived);
    this.description = `${pinned ? '📌 ' : ''}${describe(session, content, stats)}`;
    // Built on hover (`resolveTreeItem`), which is also how the view learns the pointer is over it.
    this.tooltipOnHover = () => {
      const tooltip = tooltipFor(session, archived, stats, content.notes);
      if (pinned) tooltip.appendMarkdown('\n\n$(pin) Pinned to Active');
      if (backlog) tooltip.appendMarkdown('\n\n$(inbox) In Backlog');
      if (session.detached) tooltip.appendMarkdown('\n\n$(debug-disconnect) Detached from the session that started it');
      return tooltip;
    };
    // `linked`: the parent comes from a marker (only then is `parentTool` set), so the row can be detached.
    const linked = session.subagent && session.parentTool !== undefined;
    this.contextValue = ['session', session.tool, archived ? 'archived' : '', pinned ? 'pinned' : '', backlog ? 'backlog' : '', isLive(session.state) ? 'live' : 'stopped', session.subagent ? 'subagent' : '', linked ? 'linked' : '', session.detached ? 'detached' : '']
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

type Node = SessionItem | GroupItem | NoteGroupItem | NoteItem | DoneItem;

/** How long the view keeps still after the pointer reaches a row, so a row is not moved from under a click. */
const HOVER_HOLD_MS = 3000;

/** How long a session that stops working stays in Active, so a moment's stop (opening it rewrites its transcript) does not move it to History and back. */
const ACTIVE_HOLD_MS = 5000;

/** Fill in a hovered row's tooltip. */
export function resolveTooltip(item: vscode.TreeItem, element: unknown): vscode.TreeItem {
  if (element instanceof SessionItem || element instanceof NoteItem || element instanceof DoneItem) item.tooltip = element.tooltipOnHover();
  return item;
}

const STATE_LABEL: Record<SessionState, string> = {
  running: 'Working',
  waiting: 'Needs your input',
  replied: 'Replied, waiting for you',
  stopped: 'Stopped',
};

/**
 * What follows a row's title: the agent's role, then the details chosen in `agentSessions.rowDetails`, in their order.
 * The tool is the row's icon, and a detail with nothing to say is left out.
 */
function describe(session: Session, content: RowContent, stats: WorktreeStats | undefined): string {
  const parts: string[] = [];
  if (session.agentRole) parts.push(session.agentRole);
  // Shown whatever details are chosen: a done session is one to stop reading.
  if (content.notes?.done) parts.push('✓ done');
  const counts = noteCounts(content.notes);
  const wt = session.worktree;
  const edits = wt && stats && !stats.gone ? statsInline(stats) : '';
  for (const detail of content.details) {
    switch (detail) {
      case 'questions':
        // Questions waiting for you, then answers you have not read.
        if (counts.questionsOpen) parts.push(`? ${counts.questionsOpen}`);
        if (counts.answersUnread) parts.push(`✉ ${counts.answersUnread}`);
        break;
      case 'tasks':
        if (counts.tasksOpen + counts.tasksDone) parts.push(`☑ ${counts.tasksDone}/${counts.tasksOpen + counts.tasksDone}`);
        break;
      case 'worktree':
        // A session in the main checkout names neither: the repository is where you
        // are anyway, and its branch is the tooltip's business.
        if (wt) parts.push(`⎇ ${wt.name}${stats?.gone ? ' (gone)' : edits && content.details.includes('edits') ? ` ${edits}` : ''}`);
        break;
      case 'edits':
        if (edits && !content.details.includes('worktree')) parts.push(edits);
        break;
      case 'age':
        parts.push(relativeTime(session.updatedAt));
        break;
    }
  }
  return parts.join(' · ');
}

function tooltipFor(session: Session, archived: boolean, stats: WorktreeStats | undefined, notes: SessionNotes | undefined): vscode.MarkdownString {
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
  const counts = noteCounts(notes);
  if (notes?.done) md.appendMarkdown(`$(pass-filled) Done ${new Date(notes.done.at).toLocaleString()}\n\n`);
  if (counts.questionsOpen) md.appendMarkdown(`$(question) ${plural(counts.questionsOpen, 'question')} waiting for you\n\n`);
  if (counts.answersUnread + counts.answersOpen) md.appendMarkdown(`$(comment-discussion) ${[counts.answersUnread ? plural(counts.answersUnread, 'unread answer') : '', counts.answersOpen ? `${plural(counts.answersOpen, 'question')} of yours not answered yet` : ''].filter(Boolean).join(', ')}\n\n`);
  if (counts.tasksOpen + counts.tasksDone) md.appendMarkdown(`$(checklist) ${counts.tasksDone} of ${counts.tasksOpen + counts.tasksDone} task${counts.tasksOpen + counts.tasksDone === 1 ? '' : 's'} done\n\n`);
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

/** How urgently a state wants you: a question first, then a finished turn, then work in progress. */
const ATTENTION: Record<SessionState, number> = { waiting: 0, replied: 1, running: 2, stopped: 3 };

const titles = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true });

/** The Active order for `sort`; `state` is a row's state as Active sees it (a stopped parent of a working agent works). */
export function activeOrder(sort: ActiveSort, state: (s: Session) => SessionState = (s) => s.state): (a: Session, b: Session) => number {
  switch (sort) {
    case 'newest':
      return byStart;
    case 'oldest':
      return (a, b) => byStart(b, a);
    case 'activity':
      return byRecency;
    case 'attention':
      return (a, b) => ATTENTION[state(a)] - ATTENTION[state(b)] || byStart(a, b);
    case 'title':
      return (a, b) => titles.compare(a.title, b.title) || byStart(a, b);
  }
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
  /** How many rows the search found, while there is one. */
  private found: number | undefined;
  /** Whether the first scan has landed, and whether the view has been told (see `announceLoaded`). */
  private scanned = false;
  private announced = false;
  /** When the pointer last reached a row, and the update waiting for it to leave the rows alone. */
  private hoveredAt = -Infinity;
  private held: ReturnType<typeof setTimeout> | undefined;
  /** Per session, when a rebuild last saw it working, and the rebuild due when the first of them leaves Active (see `ACTIVE_HOLD_MS`). */
  private readonly workedAt = new Map<string, number>();
  private leaving: ReturnType<typeof setTimeout> | undefined;

  /** `onLoaded` runs once, when the view has the first scan's rows, so its empty state can stop saying "loading". */
  constructor(options: ViewOptions, private readonly onLoaded: () => void) {
    this.options = options;
  }

  setSessions(sessions: Session[]): void {
    this.sessions = sessions;
    this.scanned = true;
    this.rebuild(true);
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
    this.rebuild(true);
  }

  /** The notes map the options share was filled anew: by a session's own command (`background`), or by a person here. */
  notesChanged(background: boolean): void {
    this.rebuild(background);
  }

  setOptions(options: ViewOptions): void {
    this.options = options;
    this.rebuild();
  }

  /** Sessions after filtering, for badges and the status bar: the rows themselves, not the spawned sessions nested under them. */
  visible(): Session[] {
    return this.topLevel(this.filtered()).all;
  }

  /** Rows the current search found, or undefined when nothing is searched. */
  searchResults(): number | undefined {
    return this.found;
  }

  /** Split the filtered sessions into rows and the spawned sessions shown under them (see `arrangeSubagents`). */
  private topLevel(sessions: Session[]): { all: Session[]; childrenOf: Map<string, Session[]> } {
    const { rows, childrenOf } = arrangeSubagents(sessions, this.options.subagentLayout, this.options.showSubagents);
    return { all: rows, childrenOf };
  }

  getTreeItem(element: Node): vscode.TreeItem {
    return element;
  }

  /**
   * VS Code asks for a row's tooltip when the pointer rests on it, the only sign a tree view gets of the pointer:
   * it is asked once per row, so the hold counts from reaching a row, not from the pointer's last move.
   */
  resolveTreeItem(item: vscode.TreeItem, element: Node): vscode.TreeItem {
    this.hoveredAt = Date.now();
    return resolveTooltip(item, element);
  }

  /** Tell the view its rows changed; a change nobody asked for (`background`) waits out a hover. */
  private announceChange(background: boolean): void {
    clearTimeout(this.held);
    this.held = undefined;
    const wait = background ? this.hoveredAt + HOVER_HOLD_MS - Date.now() : 0;
    if (wait > 0) this.held = setTimeout(() => this.announceChange(true), wait);
    else this.changed.fire(undefined);
  }

  getChildren(element?: Node): Node[] {
    if (!element) {
      // Announced from the fetch itself, so the rows reach the view before its "no sessions" state could show.
      if (this.scanned) this.announceLoaded();
      return this.roots;
    }
    return element instanceof SessionItem ? [...element.notes, ...element.children] : [...element.children];
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

  /**
   * Archiving a session puts away what it spawned too; otherwise its subagents would lose their parent row and
   * stand alone in the list. The chain is followed up to the top, with a guard against a cycle in bad data.
   */
  private archivedWithAncestors(): (s: Session) => boolean {
    const o = this.options;
    const byKey = new Map(this.sessions.map((s) => [`${s.tool}:${s.id}`, s]));
    return (s) => {
      for (let at: Session | undefined = s, depth = 0; at && depth < 32; depth++) {
        if (at.archived || o.locallyArchived.has(`${at.tool}:${at.id}`)) return true;
        at = at.subagent && at.parentId ? byKey.get(`${at.parentTool ?? at.tool}:${at.parentId}`) : undefined;
      }
      return false;
    };
  }

  /**
   * Archived sessions to put away. While `showActiveArchived` is on, one still in use is not: working or waiting for
   * you, open in a tab of this window, or holding a spawned session that is, so the parent stays with it as it does in
   * Active. A replied session is idle: the Claude extension keeps a closed panel's process alive until the window
   * reloads, and Codex's app-server holds the threads it loaded, so a live process alone does not keep one listed.
   */
  private archivedOutOfUse(): (s: Session) => boolean {
    const o = this.options;
    const archived = this.archivedWithAncestors();
    if (!o.showActiveArchived) return archived;
    const spawned = new Map<string, Session[]>();
    for (const s of this.sessions) {
      const key = parentKeyOf(s);
      if (!key) continue;
      const list = spawned.get(key) ?? [];
      list.push(s);
      spawned.set(key, list);
    }
    // Memoised, with the in-progress mark doubling as a guard against a cycle in bad data.
    const known = new Map<string, boolean>();
    const inUse = (s: Session): boolean => {
      const key = sessionKey(s);
      const seen = known.get(key);
      if (seen !== undefined) return seen;
      known.set(key, false);
      const result = s.state === 'running' || s.state === 'waiting' || o.open.has(key) || (spawned.get(key) ?? []).some(inUse);
      known.set(key, result);
      return result;
    };
    return (s) => archived(s) && !inUse(s);
  }

  /** The sessions the view's filters keep; a search keeps archived ones too, for their own section. */
  private filtered(withArchived = false): Session[] {
    const o = this.options;
    const repoRoots = o.scope === 'workspace' ? this.workspaceRepoRoots() : undefined;
    const archived = this.archivedOutOfUse();
    return this.sessions.filter((s) => {
      if (!o.showArchived && !withArchived && archived(s)) return false;
      // Spawned sessions stay in: `topLevel` nests them under their parent and drops the parentless unless switched on.
      if (s.empty && !s.subagent && !o.showEmpty && !isLive(s.state) && !o.pinned.has(`${s.tool}:${s.id}`) && !o.backlog.has(`${s.tool}:${s.id}`)) return false;
      if (repoRoots) {
        const root = s.worktree?.repoRoot ?? repoRootOf(s.cwd) ?? s.cwd;
        if (!root || !repoRoots.has(path.resolve(root))) return false;
      }
      return true;
    });
  }

  /** `background`: the sessions themselves changed, rather than a person changing what the view shows. */
  private rebuild(background = false): void {
    const o = this.options;
    const searching = o.search.trim() !== '';
    const { all, childrenOf } = this.topLevel(this.filtered(searching));
    const isPinned = (s: Session) => o.pinned.has(`${s.tool}:${s.id}`);
    // Pinning wins over Backlog, should both marks reach the file (each normally clears the other, see marks.ts).
    const inBacklog = (s: Session) => o.backlog.has(`${s.tool}:${s.id}`) && !isPinned(s);
    // A session another agent was handed keeps working after its parent stops; the parent stays with it in Active.
    const live = (s: Session) => isLive(s.state) || (childrenOf.get(`${s.tool}:${s.id}`) ?? []).some((c) => isLive(c.state));
    const now = Date.now();
    const liveNow = new Set(all.filter(live).map((s) => `${s.tool}:${s.id}`));
    for (const key of liveNow) this.workedAt.set(key, now);
    for (const [key, at] of this.workedAt) if (now - at >= ACTIVE_HOLD_MS) this.workedAt.delete(key);
    // One that stopped a moment ago is still working here: it moves to History only once it has stayed stopped.
    const working = (s: Session) => this.workedAt.has(`${s.tool}:${s.id}`);
    clearTimeout(this.leaving);
    this.leaving = undefined;
    const due = Math.min(...[...this.workedAt].filter(([key]) => !liveNow.has(key)).map(([, at]) => at)) + ACTIVE_HOLD_MS - now;
    if (Number.isFinite(due)) this.leaving = setTimeout(() => this.rebuild(true), due);
    const order = activeOrder(o.activeSort, (s) => (s.state === 'stopped' && working(s) ? 'running' : s.state));
    const active = all.filter((s) => !inBacklog(s) && (working(s) || isPinned(s))).sort((a, b) => Number(isPinned(b)) - Number(isPinned(a)) || order(a, b));
    // Backlog is parked work: a session stays there while it works, and is never cut by the history limit.
    const backlog = all.filter(inBacklog).sort(byRecency);
    const history = all.filter((s) => !inBacklog(s) && !working(s) && !isPinned(s)).sort(byRecency).slice(0, o.historyLimit);
    const shown = [...active, ...backlog, ...history];
    const item = (s: Session): SessionItem =>
      new SessionItem(s, o.locallyArchived.has(`${s.tool}:${s.id}`), { details: o.rowDetails, notes: o.notes.get(`${s.tool}:${s.id}`) }, s.worktree ? this.stats.get(s.worktree.path) : undefined, '', isPinned(s), retiredSuffix(s),
        (childrenOf.get(`${s.tool}:${s.id}`) ?? []).map((c) => item(c)), inBacklog(s));
    const retiredSuffix = (s: Session) => {
      const n = this.retired.get(`${s.tool}:${s.id}`);
      return n ? `#${n}` : '';
    };

    if (searching) {
      // A row is found by its own text or by a session nested under it, and is shown with everything under it.
      const found = (s: Session): boolean => matchesSearch(s, o.search) || (childrenOf.get(`${s.tool}:${s.id}`) ?? []).some(found);
      const hits = new Set(all.filter(found));
      const archived = this.archivedOutOfUse();
      const rest = all.filter((s) => hits.has(s) && !archived(s) && !inBacklog(s) && !working(s) && !isPinned(s));
      const sections: [key: string, label: string, icon: string, sessions: Session[]][] = [
        ['active', 'Active', 'pulse', active.filter((s) => hits.has(s) && !archived(s))],
        ['backlog', 'Backlog', 'inbox', backlog.filter((s) => hits.has(s) && !archived(s))],
        ['history', 'History', 'history', rest.sort(byRecency)],
        ['archived', 'Archived', 'archive', [...hits].filter(archived).sort(byRecency)],
      ];
      this.found = hits.size;
      this.roots = sections.filter(([, , , list]) => list.length).map(([key, label, icon, list]) => new GroupItem(`search-${key}`, label, list.map((s) => item(s)), new vscode.ThemeIcon(icon), true));
    } else {
      this.found = undefined;
      switch (o.groupBy) {
        case 'none':
          this.roots = shown.map((s) => item(s));
          break;
        case 'activity': {
          const groups: Node[] = [];
          if (active.length) groups.push(new GroupItem('active', 'Active', active.map((s) => item(s)), new vscode.ThemeIcon('pulse'), true));
          if (backlog.length) groups.push(new GroupItem('backlog', 'Backlog', backlog.map((s) => item(s)), new vscode.ThemeIcon('inbox'), true));
          if (history.length) groups.push(new GroupItem('history', 'History', history.map((s) => item(s)), new vscode.ThemeIcon('history'), true));
          this.roots = groups;
          break;
        }
        case 'tool': {
          const groups: Node[] = [];
          for (const tool of ['claude', 'codex'] as const) {
            const mine = shown.filter((s) => s.tool === tool);
            if (mine.length) groups.push(new GroupItem(tool, toolLabel(tool), mine.map((s) => item(s)), toolIcon(tool), true));
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
    }
    // VS Code shows the view's progress bar on every data-change event. Refreshes
    // arrive every few hundred milliseconds while an agent writes its transcript,
    // so firing unconditionally kept that bar flickering at the top of the view.
    // Fire only when something the rows display has actually changed.
    const rendered = JSON.stringify(this.roots.map(renderKey));
    if (rendered === this.rendered) return;
    this.rendered = rendered;
    this.announceChange(background);
  }
}

/** A tree row with the rows nested under it. */
export interface Row extends vscode.TreeItem {
  readonly children: readonly Row[];
  /** A session's Done and notes rows, listed before `children`. */
  readonly notes?: readonly Row[];
}

/** Everything a row shows, so equal keys mean an equal picture. */
export function renderKey(node: Row): unknown {
  const icon = node.iconPath;
  const iconKey =
    icon instanceof vscode.ThemeIcon ? `${icon.id}:${icon.color?.id ?? ''}`
    : typeof icon === 'object' && icon !== null && 'dark' in icon ? String(icon.dark)
    : String(icon);
  const base = [node.id, node.label, node.description, node.contextValue, node.collapsibleState, iconKey];
  const under = [...(node.notes ?? []), ...node.children];
  return under.length ? [...base, under.map(renderKey)] : base;
}
