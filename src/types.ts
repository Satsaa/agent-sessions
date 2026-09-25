export type Tool = 'claude' | 'codex';

/**
 * running  – the agent is working right now
 * waiting  – the agent stopped because it needs the user (permission prompt, question)
 * replied  – the agent finished its turn and its process is still alive, waiting for the next message
 * stopped  – no process holds the session; it is history
 */
export type SessionState = 'running' | 'waiting' | 'replied' | 'stopped';

export interface Worktree {
  /** Top directory of the worktree. */
  path: string;
  /** The worktree's folder name. */
  name: string;
  /** Branch checked out there, when the tool recorded it. */
  branch: string | undefined;
  /** Main checkout that owns `.git/worktrees/<name>`, when resolvable. */
  repoRoot: string | undefined;
}

export interface Session {
  tool: Tool;
  id: string;
  title: string;
  /** Working directory the session was started in: the repository checkout, even when it later entered a worktree. */
  cwd: string | undefined;
  branch: string | undefined;
  /** The linked git worktree the session is working in, when it is not the main checkout. */
  worktree: Worktree | undefined;
  /** Epoch milliseconds of the last write to the transcript. */
  updatedAt: number;
  /** When the session began (first message); stable, unlike updatedAt, so a live list sorted on it does not reshuffle as agents talk. */
  startedAt: number;
  state: SessionState;
  /** Archived by the tool itself (Codex) — this view's own archive list is applied separately. */
  archived: boolean;
  /** Spawned by another session rather than started by a person. */
  subagent: boolean;
  /** The session that spawned this one (same tool), when the tool records it; a spawned session with no parent stands alone. */
  parentId: string | undefined;
  /** What the spawning session called this agent: a teammate's name, an agent type, a Codex nickname. */
  agentRole: string | undefined;
  /** No prompt was ever sent. */
  empty: boolean;
  /** Path of the transcript on disk. */
  transcriptPath: string;
  /** PID of the process holding the session, when known. */
  pid: number | undefined;
  /** The process was started from the VS Code window this extension runs in (see window.ts). */
  inThisWindow: boolean;
  /** The permission mode the session's last prompt ran in, and when (Claude records it on each prompt). */
  permissionMode: { mode: string; at: number } | undefined;
}


export function isLive(state: SessionState): boolean {
  return state !== 'stopped';
}

export function toolLabel(tool: Tool): string {
  return tool === 'claude' ? 'Claude' : 'Codex';
}

/** A folder whose changes may change a session list; `accept` sees a changed file's name and says whether it can. */
export interface WatchSpec {
  path: string;
  recursive: boolean;
  accept?: (name: string) => boolean;
}
