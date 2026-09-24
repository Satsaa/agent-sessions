/**
 * Each row's "More Actions…" button: everything its context menu offers, without a right click, and on the phone,
 * where a finger has no hover to reveal inline buttons and no right click at all. `applies` reads the row's
 * contextValue the way that menu's when-clauses do (see package.json), and the menus test holds the two together:
 * every context-menu command is listed here.
 */
export interface RowAction {
  command: string;
  applies: (contextValue: string) => boolean;
  /** Why the phone leaves this action out, for want of the desktop around it. */
  notOnPhone?: string;
}

const session = (cv: string) => cv.startsWith('session');
const mainThread = (cv: string) => session(cv) && !cv.includes('subagent');
const worktree = (cv: string) => /^worktree(-main)?$/.test(cv);

export const ROW_ACTIONS: RowAction[] = [
  { command: 'agentSessions.open', applies: mainThread },
  { command: 'agentSessions.openTranscript', applies: (cv) => session(cv) && cv.includes('subagent') },
  { command: 'agentSessions.openInTerminal', applies: mainThread, notOnPhone: 'the phone layout shows no terminal; the session opens in its panel' },
  { command: 'agentSessions.openFolder', applies: session, notOnPhone: 'the phone has one window' },
  { command: 'agentSessions.rename', applies: mainThread },
  { command: 'agentSessions.pin', applies: (cv) => mainThread(cv) && !cv.includes('-pinned-') },
  { command: 'agentSessions.unpin', applies: (cv) => mainThread(cv) && cv.includes('-pinned-') },
  { command: 'agentSessions.archive', applies: (cv) => mainThread(cv) && !cv.includes('archived') },
  { command: 'agentSessions.unarchive', applies: (cv) => cv.includes('archived') },
  { command: 'agentSessions.closeCodex', applies: (cv) => cv.startsWith('session-codex') },
  { command: 'agentSessions.reloadCodexPanel', applies: (cv) => cv.startsWith('session-codex') && !cv.includes('subagent') },
  { command: 'agentSessions.copyResumeCommand', applies: mainThread, notOnPhone: 'for pasting into a desktop terminal' },
  { command: 'agentSessions.revealTranscript', applies: session, notOnPhone: 'opens a file in an editor the phone layout does not show' },
  { command: 'agentSessions.copyTranscript', applies: session },
  { command: 'agentSessions.copyIdentifier', applies: session },
  { command: 'agentSessions.worktree.openFolder', applies: worktree, notOnPhone: 'the phone has one window' },
  { command: 'agentSessions.worktree.openTerminal', applies: worktree, notOnPhone: 'the phone layout shows no terminal' },
  { command: 'agentSessions.worktree.copyPath', applies: worktree },
  { command: 'agentSessions.worktree.newClaude', applies: worktree, notOnPhone: 'starts the agent in a terminal; the view’s New buttons start a panel and ask for the folder' },
  { command: 'agentSessions.worktree.newCodex', applies: worktree, notOnPhone: 'starts the agent in a terminal; the view’s New buttons start a panel and ask for the folder' },
  { command: 'agentSessions.worktree.delete', applies: (cv) => cv === 'worktree' },
];

export function rowActionsFor(contextValue: string | undefined, phone: boolean): string[] {
  if (!contextValue) return [];
  return ROW_ACTIONS.filter((a) => a.applies(contextValue) && !(phone && a.notOnPhone)).map((a) => a.command);
}
