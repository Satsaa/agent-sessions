export type Tool = 'claude' | 'codex';

/**
 * running  – the agent is working right now
 * waiting  – the agent stopped because it needs the user (permission prompt, question)
 * replied  – the agent finished its turn and its process is still alive, waiting for the next message
 * stopped  – no process holds the session; it is history
 */
export type SessionState = 'running' | 'waiting' | 'replied' | 'stopped';

export interface Session {
  tool: Tool;
  id: string;
  title: string;
  /** Working directory the session was started in (a worktree path for worktree sessions). */
  cwd: string | undefined;
  branch: string | undefined;
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
