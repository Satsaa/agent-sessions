/**
 * The phone's per-row action picker: a finger has no hover to reveal a row's inline buttons and no right click, so
 * each row carries one "More Actions…" button listing what its context menu offers. `applies` reads the row's
 * contextValue the way that menu's when-clauses do (see package.json), and the menus test holds the two together:
 * every context-menu command is listed here or in PHONE_OMITTED.
 */
export interface RowAction {
  command: string;
  applies: (contextValue: string) => boolean;
}

const session = (cv: string) => cv.startsWith('session');
const mainThread = (cv: string) => session(cv) && !cv.includes('subagent');
const worktree = (cv: string) => /^worktree(-main)?$/.test(cv);

export const ROW_ACTIONS: RowAction[] = [
  { command: 'agentSessions.open', applies: mainThread },
  { command: 'agentSessions.openTranscript', applies: (cv) => session(cv) && cv.includes('subagent') },
  { command: 'agentSessions.rename', applies: mainThread },
  { command: 'agentSessions.pin', applies: (cv) => mainThread(cv) && !cv.includes('-pinned-') },
  { command: 'agentSessions.unpin', applies: (cv) => mainThread(cv) && cv.includes('-pinned-') },
  { command: 'agentSessions.archive', applies: (cv) => mainThread(cv) && !cv.includes('archived') },
  { command: 'agentSessions.unarchive', applies: (cv) => cv.includes('archived') },
  { command: 'agentSessions.closeCodex', applies: (cv) => cv.startsWith('session-codex') },
  { command: 'agentSessions.reloadCodexPanel', applies: (cv) => cv.startsWith('session-codex') && !cv.includes('subagent') },
  { command: 'agentSessions.copyTranscript', applies: session },
  { command: 'agentSessions.copyIdentifier', applies: session },
  { command: 'agentSessions.worktree.copyPath', applies: worktree },
  { command: 'agentSessions.worktree.delete', applies: (cv) => cv === 'worktree' },
];

/** Context-menu commands the phone leaves out, each for want of the desktop around it. */
export const PHONE_OMITTED: Record<string, string> = {
  'agentSessions.openInTerminal': 'the phone layout shows no terminal; the session opens in its panel',
  'agentSessions.copyResumeCommand': 'for pasting into a desktop terminal',
  'agentSessions.revealTranscript': 'opens a file in an editor the phone layout does not show',
  'agentSessions.openFolder': 'the phone has one window',
  'agentSessions.worktree.openFolder': 'the phone has one window',
  'agentSessions.worktree.openTerminal': 'the phone layout shows no terminal',
  'agentSessions.worktree.newClaude': 'starts the agent in a terminal; the view’s New buttons start a panel and ask for the folder',
  'agentSessions.worktree.newCodex': 'starts the agent in a terminal; the view’s New buttons start a panel and ask for the folder',
};

export function rowActionsFor(contextValue: string | undefined): string[] {
  return contextValue ? ROW_ACTIONS.filter((a) => a.applies(contextValue)).map((a) => a.command) : [];
}
