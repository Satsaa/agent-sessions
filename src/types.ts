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
  state: SessionState;
  /** Archived by the tool itself (Codex) — this view's own archive list is applied separately. */
  archived: boolean;
  /** Spawned by another session rather than started by a person. */
  subagent: boolean;
  /** No prompt was ever sent. */
  empty: boolean;
  /** Path of the transcript on disk. */
  transcriptPath: string;
  /** PID of the process holding the session, when known. */
  pid: number | undefined;
}

export const STATE_ORDER: Record<SessionState, number> = {
  waiting: 0,
  running: 1,
  replied: 2,
  stopped: 3,
};

export function isLive(state: SessionState): boolean {
  return state !== 'stopped';
}

export function toolLabel(tool: Tool): string {
  return tool === 'claude' ? 'Claude' : 'Codex';
}
