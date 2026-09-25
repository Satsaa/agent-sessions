import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import type { Session } from './types.js';

/**
 * VS Code hands every process of one window the same CLI IPC socket — the extension host,
 * the integrated terminals and whatever they spawn — so an agent whose environment carries
 * this window's socket was started from this window. Linux only (read from /proc); elsewhere
 * nothing is marked.
 */
export const THIS_WINDOW = process.env.VSCODE_IPC_HOOK_CLI;

const keyCache = new Map<number, { start: string; key: string | undefined }>();

async function read(file: string): Promise<string | undefined> {
  try {
    return await fsp.readFile(file, 'utf8');
  } catch {
    return undefined;
  }
}

export async function statFields(pid: number): Promise<string[] | undefined> {
  const stat = await read(`/proc/${pid}/stat`);
  if (!stat) return undefined;
  // The command name is in parentheses and may contain spaces; fields are counted after it.
  return stat.slice(stat.lastIndexOf(')') + 2).split(' ');
}

export async function startTimeOf(pid: number): Promise<string | undefined> {
  return (await statFields(pid))?.[19]; // starttime is field 22 of the whole line
}

async function parentOf(pid: number): Promise<number | undefined> {
  const ppid = Number((await statFields(pid))?.[1]); // ppid is field 4
  return Number.isInteger(ppid) && ppid > 1 ? ppid : undefined;
}

/** Whether `pid` runs under this extension host — what the Claude and Codex extensions' own processes do. */
async function descendsFromThisHost(pid: number): Promise<boolean> {
  let cur: number | undefined = pid;
  for (let i = 0; i < 30 && cur !== undefined; i++) {
    if (cur === process.pid) return true;
    cur = await parentOf(cur);
  }
  return false;
}

/** The window socket of a process, cached until the pid is reused by a different process. */
export async function windowKeyOfPid(pid: number): Promise<string | undefined> {
  const start = await startTimeOf(pid);
  if (!start) return undefined;
  const cached = keyCache.get(pid);
  if (cached && cached.start === start) return cached.key;
  const environ = await read(`/proc/${pid}/environ`);
  const key = environ
    ?.split('\0')
    .find((e) => e.startsWith('VSCODE_IPC_HOOK_CLI='))
    ?.slice('VSCODE_IPC_HOOK_CLI='.length);
  keyCache.set(pid, { start, key });
  return key;
}

/** A file's device and inode as `/proc/locks` writes them: `<major hex>:<minor hex>:<inode>`. */
function lockKey(dev: bigint, ino: bigint): string {
  const major = ((dev >> 8n) & 0xfffn) | ((dev >> 32n) & ~0xfffn);
  const minor = (dev & 0xffn) | ((dev >> 12n) & ~0xffn);
  return `${major.toString(16).padStart(2, '0')}:${minor.toString(16).padStart(2, '0')}:${ino}`;
}

/**
 * Pids of the named executable holding a writer flock under `dir`, keyed by basename. An open descriptor alone is
 * not ownership (see codex-close.test.mjs). The kernel lists every held lock with its holder in `/proc/locks`, so this
 * reads one file instead of every process's descriptors.
 */
export async function holdersOfFilesIn(dir: string, needle: string): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const locks = await read('/proc/locks');
  if (!locks) return out;
  const writers = new Map<string, number>();
  // A waiter's line reads `N: -> FLOCK …`, so only granted locks match.
  for (const m of locks.matchAll(/^\d+:\s+FLOCK\s+ADVISORY\s+WRITE\s+(\d+)\s+([0-9a-f]+:[0-9a-f]+:\d+)\s/gm)) writers.set(m[2]!, Number(m[1]));
  if (!writers.size) return out;
  let names: string[];
  try {
    names = await fsp.readdir(dir);
  } catch {
    return out;
  }
  const exeMatches = new Map<number, Promise<boolean>>();
  const isNeedle = (pid: number) => {
    let known = exeMatches.get(pid);
    if (!known) {
      known = fsp.readlink(`/proc/${pid}/exe`).then((exe) => path.basename(exe).replace(/ \(deleted\)$/, '') === needle, () => false);
      exeMatches.set(pid, known);
    }
    return known;
  };
  await Promise.all(
    names.map(async (name) => {
      try {
        const st = await fsp.stat(path.join(dir, name), { bigint: true });
        const pid = writers.get(lockKey(st.dev, st.ino));
        if (pid !== undefined && (await isNeedle(pid))) out.set(name, pid);
      } catch {
        // removed meanwhile
      }
    }),
  );
  return out;
}

/**
 * Set `inThisWindow` on every live session that belongs to this VS Code window. Three signs, any one suffices:
 * the process runs under this extension host (the vendor extensions spawn their agents there); its environment
 * carries this window's CLI socket (integrated terminals — though a reload or reconnect gives the window a new
 * socket while old processes keep the old one, so this alone under-reports); or a tab in this window carries the
 * session's title (the vendor extensions title their panels with it).
 */
export async function markThisWindow(sessions: Session[], tabLabels: ReadonlySet<string>): Promise<void> {
  if (process.platform !== 'linux') return;
  await Promise.all(
    sessions.map(async (s) => {
      if (s.pid === undefined) return;
      s.inThisWindow =
        (await descendsFromThisHost(s.pid)) ||
        (THIS_WINDOW !== undefined && (await windowKeyOfPid(s.pid)) === THIS_WINDOW) ||
        tabLabels.has(s.title);
    }),
  );
}
