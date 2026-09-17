import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

export function expandHome(p: string): string {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}

export function processAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means the process exists but belongs to someone else; still alive.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export async function readJsonFile<T = unknown>(file: string): Promise<T | undefined> {
  try {
    return JSON.parse(await fsp.readFile(file, 'utf8')) as T;
  } catch {
    return undefined;
  }
}

export async function listDir(dir: string): Promise<fs.Dirent[]> {
  try {
    return await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

export async function statOrUndefined(file: string): Promise<fs.Stats | undefined> {
  try {
    return await fsp.stat(file);
  } catch {
    return undefined;
  }
}

/** Walk a directory tree and return files matching the predicate. */
export async function walkFiles(root: string, match: (name: string) => boolean): Promise<string[]> {
  const out: string[] = [];
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop()!;
    for (const e of await listDir(dir)) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) stack.push(full);
      else if (e.isFile() && match(e.name)) out.push(full);
    }
  }
  return out;
}

/**
 * Strip the machinery that both tools prepend to a first prompt (IDE context blocks,
 * system reminders, slash-command wrappers) and return one displayable line.
 */
export function cleanTitle(raw: string, max = 90): string {
  let text = raw
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, ' ')
    .replace(/<ide_opened_file>[\s\S]*?<\/ide_opened_file>/g, ' ')
    .replace(/<ide_selection>[\s\S]*?<\/ide_selection>/g, ' ')
    .replace(/<command-message>[\s\S]*?<\/command-message>/g, ' ')
    .replace(/<command-name>([\s\S]*?)<\/command-name>/g, '$1')
    .replace(/<[a-z_-]+>[\s\S]*?<\/[a-z_-]+>/g, ' ');

  // Codex puts "# Context from my IDE setup:" paragraphs before the actual prompt.
  const paragraphs = text
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean);
  const meaningful = paragraphs.filter((p) => !/^#{1,6}\s/.test(p) && !/^<INSTRUCTIONS/i.test(p));
  text = (meaningful.length ? meaningful : paragraphs).join(' ');

  text = text.replace(/\s+/g, ' ').trim();
  if (text.length > max) text = text.slice(0, max - 1).trimEnd() + '…';
  return text;
}

export function relativeTime(epochMs: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - epochMs) / 1000));
  if (s < 45) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 36) return `${h}h ago`;
  const d = Math.round(h / 24);
  if (d < 14) return `${d}d ago`;
  const w = Math.round(d / 7);
  if (w < 9) return `${w}w ago`;
  return new Date(epochMs).toLocaleDateString();
}

const repoRootCache = new Map<string, string | undefined>();

/**
 * The main repository root for a path: for a linked worktree this is the checkout
 * that owns `.git/worktrees/<name>`, so all worktrees of one repo share a root.
 */
export function repoRootOf(dir: string | undefined): string | undefined {
  if (!dir) return undefined;
  if (repoRootCache.has(dir)) return repoRootCache.get(dir);
  let result: string | undefined;
  let cur = path.resolve(dir);
  for (let i = 0; i < 40; i++) {
    const dotGit = path.join(cur, '.git');
    let st: fs.Stats | undefined;
    try {
      st = fs.statSync(dotGit);
    } catch {
      st = undefined;
    }
    if (st?.isDirectory()) {
      result = cur;
      break;
    }
    if (st?.isFile()) {
      try {
        const content = fs.readFileSync(dotGit, 'utf8');
        const m = /^gitdir:\s*(.+)$/m.exec(content);
        if (m?.[1]) {
          const gitdir = path.resolve(cur, m[1].trim());
          const wt = /^(.*)[\\/]\.git[\\/]worktrees[\\/][^\\/]+$/.exec(gitdir);
          result = wt?.[1] ?? cur;
          break;
        }
      } catch {
        // fall through
      }
      result = cur;
      break;
    }
    const parent = path.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  repoRootCache.set(dir, result);
  return result;
}

/** The linked worktree a path lies in: its top directory (the one holding the `.git` file), or undefined for a main checkout. */
export function worktreeTopOf(cwd: string | undefined): string | undefined {
  if (!cwd) return undefined;
  const root = repoRootOf(cwd);
  if (!root || path.resolve(root) === path.resolve(cwd)) return undefined;
  let cur = path.resolve(cwd);
  for (let i = 0; i < 40; i++) {
    const dotGit = path.join(cur, '.git');
    try {
      const st = fs.statSync(dotGit);
      if (st.isFile()) return cur;
      if (st.isDirectory()) return undefined; // reached a main checkout: cwd was a subfolder of it
    } catch {
      // keep climbing
    }
    const parent = path.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return undefined;
}

/**
 * Whether a tab label names this session. The vendor extensions truncate (Codex appends "…", Claude cuts at 200) and
 * trim differently from our own title cleaning, so compare on normalised text and accept either being a prefix of
 * the other once at least a few characters agree.
 */
export function titleMatchesLabel(title: string, label: string): boolean {
  const norm = (s: string) => s.replace(/\u2026$|\.\.\.$/, '').replace(/\s+/g, ' ').trim().toLowerCase();
  const a = norm(title);
  const b = norm(label);
  if (!a || !b) return false;
  if (a === b) return true;
  const shorter = a.length < b.length ? a : b;
  const longer = shorter === a ? b : a;
  return shorter.length >= 8 && longer.startsWith(shorter);
}

