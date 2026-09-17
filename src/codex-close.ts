import * as path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { holdersOfFilesIn, startTimeOf } from './window.js';

export interface CodexOwner {
  pid: number;
  start: string;
  threadIds: string[];
}

/** Read ownership afresh rather than trusting a PID from a sidebar row. */
export async function codexOwner(home: string, threadId: string): Promise<CodexOwner | undefined> {
  if (process.platform !== 'linux') throw new Error('Releasing Codex sessions is currently supported only on Linux (including Remote-SSH and WSL).');
  const holders = await holdersOfFilesIn(path.join(home, 'thread-writer-locks'), 'codex');
  const pid = holders.get(`${threadId}.lock`);
  if (pid === undefined) return undefined;
  const start = await startTimeOf(pid);
  if (!start) return undefined;
  const threadIds = [...holders].filter(([name, owner]) => owner === pid && name.endsWith('.lock')).map(([name]) => name.slice(0, -5)).sort();
  return { pid, start, threadIds };
}

/** A changed owner or new sibling needs a new confirmation; tested in codex-close.test.mjs. */
export async function stopCodexOwner(home: string, threadId: string, approved: CodexOwner): Promise<void> {
  const current = await codexOwner(home, threadId);
  if (!current) return;
  if (current.pid !== approved.pid || current.start !== approved.start || current.threadIds.some((id) => !approved.threadIds.includes(id))) {
    throw new Error('The sessions held by this process changed. Click Close again to review the current sessions.');
  }
  if (await startTimeOf(current.pid) !== current.start) throw new Error('The Codex process changed. Refresh and try again.');
  try {
    process.kill(current.pid, 'SIGTERM');
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH')) throw error;
  }
  for (let attempt = 0; attempt < 40; attempt++) {
    const owner = await codexOwner(home, threadId);
    if (!owner) return;
    if (owner.pid !== current.pid || owner.start !== current.start) throw new Error('Another Codex process has already reopened this session.');
    await delay(100);
  }
  throw new Error('Codex did not release the session after being asked to stop. Its process may still be shutting down; refresh and try again.');
}
