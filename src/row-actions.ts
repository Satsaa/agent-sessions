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
const worktree = (cv: string) => /^worktree(-main)?$/.test(cv);

export const ROW_ACTIONS: RowAction[] = [
  { command: 'agentSessions.open', applies: mainThread },
  { command: 'agentSessions.openTranscript', applies: (cv) => session(cv) && cv.includes('subagent') },
  { command: 'agentSessions.openInTerminal', applies: mainThread, notOnPhone: 'the phone layout shows no terminal; the session opens in its panel', bulk: true },
  { command: 'agentSessions.openFolder', applies: session, notOnPhone: 'the phone has one window' },
  { command: 'agentSessions.rename', applies: mainThread },
  { command: 'agentSessions.pin', applies: (cv) => mainThread(cv) && !cv.includes('-pinned-'), bulk: true },
  { command: 'agentSessions.unpin', applies: (cv) => mainThread(cv) && cv.includes('-pinned-'), bulk: true },
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
