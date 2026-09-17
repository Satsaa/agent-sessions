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

async function startTimeOf(pid: number): Promise<string | undefined> {
  const stat = await read(`/proc/${pid}/stat`);
  if (!stat) return undefined;
  // The command name is in parentheses and may contain spaces; fields are counted after it.
  const rest = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
  return rest[19]; // starttime is field 22 of the whole line
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
 * Pids of processes whose command line mentions `needle` and that hold files under `dir` open,
 * keyed by the file's basename. Codex keeps each live thread's writer lock open, which is the
 * only thing that ties a thread to a process.
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
      const cmd = await read(`/proc/${p}/cmdline`);
      if (!cmd?.includes(needle)) return;
      let fds: string[];
      try {
        fds = await fsp.readdir(`/proc/${p}/fd`);
      } catch {
        return;
      }
      for (const fd of fds) {
        try {
          const target = await fsp.readlink(`/proc/${p}/fd/${fd}`);
          if (target.startsWith(prefix)) out.set(path.basename(target), Number(p));
        } catch {
          // fd closed meanwhile
        }
      }
    }),
  );
  return out;
}

/** Set `inThisWindow` on every live session whose process was started from this VS Code window. */
export async function markThisWindow(sessions: Session[]): Promise<void> {
  if (!THIS_WINDOW || process.platform !== 'linux') return;
  await Promise.all(
    sessions.map(async (s) => {
      if (s.pid === undefined) return;
      s.inThisWindow = (await windowKeyOfPid(s.pid)) === THIS_WINDOW;
    }),
  );
}
