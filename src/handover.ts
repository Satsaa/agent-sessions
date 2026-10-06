import { toolLabel, type Session, type Tool } from './types.js';

/**
 * Moving a session to the other tool starts a new session there whose first prompt points at the old session's
 * transcript: neither tool can import the other's history, but either agent can read a JSON-lines file.
 */
export function handoverTarget(session: Session): Tool {
  return session.tool === 'claude' ? 'codex' : 'claude';
}

export function handoverNote(session: Session & { transcriptPath: string }): string {
  return [
    `Continue a session that was started in ${toolLabel(session.tool)}: "${session.title}".`,
    `Its transcript is ${session.transcriptPath} (one JSON object per line). Read it to pick up the task, what was decided and done, and where it stopped, then carry on from there.`,
    ...(session.cwd ? [`It worked in ${session.cwd}.`] : []),
  ].join('\n');
}
