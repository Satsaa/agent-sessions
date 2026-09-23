import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * Archived and pinned sessions (`<tool>:<id>` keys), kept in one file under the user's home rather than in a VS Code
 * install's globalState, so every window whose extension runs as this user shares them: the desktop remote window and
 * the phone's serve-web alike.
 */
export interface SessionMarks {
  archived: string[];
  pinned: string[];
}
export type MarkList = keyof SessionMarks;

export function marksFile(): string {
  return path.join(os.homedir(), '.agent-sessions', 'state.json');
}

export async function readMarks(file: string): Promise<SessionMarks> {
  let raw: unknown;
  try {
    raw = JSON.parse(await fsp.readFile(file, 'utf8'));
  } catch {
    // Missing, or mid-write by a hand edit: nothing marked.
  }
  const list = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
  const o = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  return { archived: list(o.archived), pinned: list(o.pinned) };
}

// Changes from this window apply one at a time; each re-reads the file, so another window's change since is kept.
let queue: Promise<unknown> = Promise.resolve();

function update(file: string, change: (m: SessionMarks) => SessionMarks): Promise<SessionMarks> {
  const next = queue.then(async () => {
    const marks = change(await readMarks(file));
    const sorted = { archived: [...new Set(marks.archived)].sort(), pinned: [...new Set(marks.pinned)].sort() };
    await fsp.mkdir(path.dirname(file), { recursive: true });
    // Written beside and renamed over, so a reader never sees half a file.
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    await fsp.writeFile(tmp, JSON.stringify(sorted, null, 2) + '\n');
    await fsp.rename(tmp, file);
    return sorted;
  });
  queue = next.catch(() => undefined);
  return next;
}

/** Add or remove one session key from a list, as a change to the file's current content. */
export function setMark(file: string, list: MarkList, key: string, present: boolean): Promise<SessionMarks> {
  return update(file, (m) => ({ ...m, [list]: present ? [...m[list], key] : m[list].filter((k) => k !== key) }));
}

/** Union marks into the file: how a window brings over what it kept in globalState before the file existed. */
export function mergeMarks(file: string, add: SessionMarks): Promise<SessionMarks> {
  return update(file, (m) => ({ archived: [...m.archived, ...add.archived], pinned: [...m.pinned, ...add.pinned] }));
}

/** Calls `onChange` with the file's marks whenever any window rewrites it. */
export function watchMarks(file: string, onChange: (m: SessionMarks) => void): { dispose(): void } {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  let timer: NodeJS.Timeout | undefined;
  // The directory, not the file: a rename replaces the file, which ends a watch on it.
  const watcher = fs.watch(dir, { persistent: false }, (_event, name) => {
    if (name !== path.basename(file)) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => void readMarks(file).then(onChange), 100);
  });
  return {
    dispose: () => {
      if (timer) clearTimeout(timer);
      watcher.close();
    },
  };
}
