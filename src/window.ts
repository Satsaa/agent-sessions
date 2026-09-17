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

/**
 * Pids of the named executable holding a writer flock under `dir`, keyed by basename.
 * An open descriptor alone is not ownership (see codex-close.test.mjs).
 */
export async function holdersOfFilesIn(dir: string, needle: string): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const prefix = path.resolve(dir) + path.sep;
  let pids: string[];
  try {
    pids = (await fsp.readdir('/proc')).filter((n) => /^\d+$/.test(n));
  } catch {
    return out;
  }
  await Promise.all(
    pids.map(async (p) => {
      try {
        const executable = await fsp.readlink(`/proc/${p}/exe`);
        if (path.basename(executable).replace(/ \(deleted\)$/, '') !== needle) return;
      } catch {
        return;
      }
      let fds: string[];
      try {
        fds = await fsp.readdir(`/proc/${p}/fd`);
      } catch {
        return;
      }
      for (const fd of fds) {
        try {
          const target = await fsp.readlink(`/proc/${p}/fd/${fd}`);
          if (!target.startsWith(prefix) || path.dirname(target) !== path.resolve(dir)) continue;
          const info = await read(`/proc/${p}/fdinfo/${fd}`);
          if (info && /^lock:\s+\d+: FLOCK\s+ADVISORY\s+WRITE\s/m.test(info)) out.set(path.basename(target), Number(p));
        } catch {
          // fd closed meanwhile
        }
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
