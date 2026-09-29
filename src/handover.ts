import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
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

/** The note as a file, for Codex, whose panel can be given a file to attach but no text to prefill. */
export async function writeHandoverNote(session: Session & { transcriptPath: string }): Promise<string> {
  const dir = path.join(os.homedir(), '.agent-sessions', 'handovers');
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, `${session.tool}-${session.id}.md`);
  await fs.writeFile(file, handoverNote(session) + '\n');
  return file;
}
