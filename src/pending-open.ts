import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Tool } from './types.js';

/**
 * A session to open (or start) in the window on its folder. Claude Code runs `claude` in the window's first folder and
 * resumes only that folder's sessions, so a session from elsewhere is handed to a window on its folder: this one
 * reopened there (phone), or a window of its own, new or already open (desktop). The hand-off is a file under the
 * user's home that every window watches, so a window already on the folder takes it as well as a new one.
 */
export interface PendingOpen {
  tool: Tool;
  /** The session to resume; none starts a new one there. */
  id?: string;
  folder: string;
  /** The VS Code install (its global storage) that asked: the phone server's windows never take the desktop's. */
  install: string;
  at: number;
}

/** A hand-off nobody took within this long is stale (the window never came up). */
const FRESH_MS = 60_000;

export function pendingOpenFile(): string {
  return path.join(os.homedir(), '.agent-sessions', 'pending-open.json');
}

export async function offerOpen(file: string, pending: PendingOpen): Promise<void> {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(pending));
  await fsp.rename(tmp, file);
}

/**
 * The pending open, if it is meant for a window of this install on this folder. Claimed by renaming the file away,
 * which only one window can do, so two windows on the folder never both open it.
 */
export async function claimOpen(file: string, install: string, folder: string | undefined, now = Date.now()): Promise<PendingOpen | undefined> {
  if (!folder) return undefined;
  let pending: PendingOpen;
  try {
    pending = JSON.parse(await fsp.readFile(file, 'utf8')) as PendingOpen;
  } catch {
    return undefined;
  }
  if (pending.install !== install || path.resolve(pending.folder) !== path.resolve(folder) || now - pending.at > FRESH_MS) return undefined;
  const claimed = `${file}.${process.pid}.claimed`;
  try {
    await fsp.rename(file, claimed);
  } catch {
    return undefined;
  }
  await fsp.rm(claimed, { force: true });
  return pending;
}

/** Calls `onOffer` whenever a window writes a hand-off. */
export function watchOffers(file: string, onOffer: () => void): { dispose(): void } {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const watcher = fs.watch(dir, { persistent: false }, (_event, name) => {
    if (name === path.basename(file)) onOffer();
  });
  return { dispose: () => watcher.close() };
}
