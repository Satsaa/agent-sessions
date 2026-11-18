/**
 * Each row's "More Actions…" button: everything its context menu offers, without a right click, and on the phone,
 * where a finger has no hover to reveal inline buttons and no right click at all. `applies` reads the row's
 * contextValue the way that menu's when-clauses do (see package.json), and the menus test holds the two together:
 * every context-menu command is listed here.
 *
 * Both trees select several rows natively (ctrl/shift-click). An action marked `bulk` runs on every selected row when
 * invoked on one of them; the rest act on one row, and their context-menu entries hide while several are selected
 * (the `agentSessions.multiSelect` context key, see extension.ts), which the menus test holds to this table.
 */
export interface RowAction {
  command: string;
  applies: (contextValue: string) => boolean;
  /** Why the phone leaves this action out, for want of the desktop around it. */
  notOnPhone?: string;
  /** Runs on each row of a multi-selection. */
  bulk?: true;
}

const session = (cv: string) => cv.startsWith('session');
const mainThread = (cv: string) => session(cv) && !cv.includes('subagent');
/** A session its agent marked done (notes.ts): it has a completion record. */
const doneSession = (cv: string) => session(cv) && /-done(-|$)/.test(cv);
const worktree = (cv: string) => /^worktree(-main)?$/.test(cv);
/** A session's notes row (tree.ts `NoteGroupItem`): `notes-<part>`, then the `flag` of each action its notes allow. */
const notesRow = (flag: string) => (cv: string) => cv.startsWith('notes-') && cv.split('-').includes(flag);

/**
 * A notes row's bulk actions: each runs a note's own action (`note`) on every note under the row it fits (`fits`,
 * else that action's `applies`), so a row and its notes can never disagree on what a note allows.
 */
export interface NoteGroupAction {
  command: string;
  flag: string;
  note: string;
  fits?: (contextValue: string) => boolean;
  /** Asks before acting: what it says. */
  confirm?: (count: number) => string;
}

export const NOTE_GROUP_ACTIONS: NoteGroupAction[] = [
  { command: 'agentSessions.notes.doneAll', flag: 'done', note: 'agentSessions.note.done' },
  { command: 'agentSessions.notes.markAllRead', flag: 'read', note: 'agentSessions.note.markRead' },
  { command: 'agentSessions.notes.answerAll', flag: 'answered', note: 'agentSessions.note.answered' },
  { command: 'agentSessions.notes.staleAll', flag: 'stale', note: 'agentSessions.note.stale' },
  {
    command: 'agentSessions.notes.removeClosed', flag: 'closed', note: 'agentSessions.note.remove',
    fits: (cv) => /^note-(task-done|task-dropped|answer-stale|question-stale)$/.test(cv),
    confirm: (n) => `Remove ${n === 1 ? 'the closed note' : `${n} closed notes`} from the list?`,
  },
];

/** Whether `action` acts on the note whose contextValue is `cv`. */
export function noteGroupFits(action: NoteGroupAction, cv: string | undefined): boolean {
  if (!cv) return false;
  const fits = action.fits ?? ROW_ACTIONS.find((a) => a.command === action.note)?.applies;
  return !!fits?.(cv);
}

/** The flag a notes row carries when its session has answers, for View All Answers. */
export const ANSWERS_FLAG = 'answers';

export const ROW_ACTIONS: RowAction[] = [
  { command: 'agentSessions.open', applies: mainThread },
  { command: 'agentSessions.openTranscript', applies: (cv) => session(cv) && cv.includes('subagent') },
  { command: 'agentSessions.openInTerminal', applies: mainThread, notOnPhone: 'the phone layout shows no terminal; the session opens in its panel', bulk: true },
  { command: 'agentSessions.openFolder', applies: session, notOnPhone: 'the phone has one window' },
  { command: 'agentSessions.rename', applies: mainThread },
  { command: 'agentSessions.pin', applies: (cv) => mainThread(cv) && !cv.includes('-pinned-'), bulk: true },
  { command: 'agentSessions.unpin', applies: (cv) => mainThread(cv) && cv.includes('-pinned-'), bulk: true },
  { command: 'agentSessions.moveToBacklog', applies: (cv) => mainThread(cv) && !cv.includes('-backlog-'), bulk: true },
  { command: 'agentSessions.removeFromBacklog', applies: (cv) => mainThread(cv) && cv.includes('-backlog-'), bulk: true },
  { command: 'agentSessions.detach', applies: (cv) => session(cv) && cv.endsWith('-linked'), bulk: true },
  { command: 'agentSessions.reattach', applies: (cv) => session(cv) && cv.endsWith('-detached'), bulk: true },
  { command: 'agentSessions.archive', applies: (cv) => mainThread(cv) && !cv.includes('archived'), bulk: true },
  { command: 'agentSessions.unarchive', applies: (cv) => cv.includes('archived'), bulk: true },
  { command: 'agentSessions.moveToCodex', applies: (cv) => mainThread(cv) && cv.startsWith('session-claude') },
  { command: 'agentSessions.moveToClaude', applies: (cv) => mainThread(cv) && cv.startsWith('session-codex') },
  { command: 'agentSessions.closeCodex', applies: (cv) => cv.startsWith('session-codex') },
  { command: 'agentSessions.reloadCodexPanel', applies: (cv) => cv.startsWith('session-codex') && !cv.includes('subagent') },
  { command: 'agentSessions.copyResumeCommand', applies: mainThread, notOnPhone: 'for pasting into a desktop terminal', bulk: true },
  { command: 'agentSessions.revealTranscript', applies: session, notOnPhone: 'opens a file in an editor the phone layout does not show' },
  { command: 'agentSessions.copyTranscript', applies: session, bulk: true },
  { command: 'agentSessions.copyIdentifier', applies: session, bulk: true },
  { command: 'agentSessions.note.done', applies: (cv) => cv === 'note-task-open', bulk: true },
  { command: 'agentSessions.note.editResolution', applies: (cv) => cv === 'note-task-done' || cv === 'note-task-dropped' },
  { command: 'agentSessions.note.markRead', applies: (cv) => cv === 'note-answer-answered-unread', bulk: true },
  { command: 'agentSessions.note.answered', applies: (cv) => cv === 'note-question-open', bulk: true },
  { command: 'agentSessions.note.stale', applies: (cv) => /^note-(answer|question)-(open|answered)/.test(cv), bulk: true },
  { command: 'agentSessions.note.reopen', applies: (cv) => /^note-(task-done|task-dropped|answer-stale|question-stale)$/.test(cv), bulk: true },
  { command: 'agentSessions.note.remove', applies: (cv) => /^note-(task|answer|question)-/.test(cv), bulk: true },
  ...NOTE_GROUP_ACTIONS.map((g): RowAction => ({ command: g.command, applies: notesRow(g.flag), bulk: true })),
  { command: 'agentSessions.notes.viewAnswers', applies: notesRow(ANSWERS_FLAG) },
  { command: 'agentSessions.note.viewDone', applies: doneSession },
  { command: 'agentSessions.note.editDone', applies: doneSession },
  { command: 'agentSessions.note.reopenSession', applies: doneSession, bulk: true },
  { command: 'agentSessions.worktree.openFolder', applies: worktree, notOnPhone: 'the phone has one window' },
  { command: 'agentSessions.worktree.openTerminal', applies: worktree, notOnPhone: 'the phone layout shows no terminal' },
  { command: 'agentSessions.worktree.copyPath', applies: worktree, bulk: true },
  { command: 'agentSessions.worktree.newClaude', applies: worktree, notOnPhone: 'starts the agent in a terminal; the view’s New buttons start a panel and ask for the folder' },
  { command: 'agentSessions.worktree.newCodex', applies: worktree, notOnPhone: 'starts the agent in a terminal; the view’s New buttons start a panel and ask for the folder' },
  { command: 'agentSessions.worktree.delete', applies: (cv) => cv === 'worktree', bulk: true },
];

/** The actions offered for the selected rows' contextValues: with several, the bulk ones that fit every row. */
export function rowActionsFor(contextValues: readonly (string | undefined)[], phone: boolean): string[] {
  const known = contextValues.filter((cv): cv is string => !!cv);
  if (!known.length || known.length < contextValues.length) return [];
  return ROW_ACTIONS.filter((a) => (known.length === 1 || a.bulk) && known.every((cv) => a.applies(cv)) && !(phone && a.notOnPhone)).map((a) => a.command);
}
