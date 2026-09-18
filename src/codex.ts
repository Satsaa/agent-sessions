import * as os from 'node:os';
import * as path from 'node:path';
import * as readline from 'node:readline';
import { createReadStream } from 'node:fs';
import * as fsp from 'node:fs/promises';
import type { Session, SessionState } from './types.js';
import { cleanTitle, expandHome, listDir, statOrUndefined, walkFiles } from './util.js';
import { worktreeFromCwd } from './worktree.js';
import { holdersOfFilesIn } from './window.js';
import type { Worktree } from './types.js';

export function codexHome(configured: string): string {
  if (configured) return expandHome(configured);
  if (process.env.CODEX_HOME) return expandHome(process.env.CODEX_HOME);
  return path.join(os.homedir(), '.codex');
}

// ---- node:sqlite, loaded lazily so the extension still works on a host without it ----

interface SqliteStatement {
  all(...params: unknown[]): Record<string, unknown>[];
  run(...params: unknown[]): { changes: number | bigint };
}
interface SqliteDatabase {
  prepare(sql: string): SqliteStatement;
  close(): void;
}
interface SqliteModule {
  DatabaseSync: new (file: string, options?: { readOnly?: boolean }) => SqliteDatabase;
}

let sqlite: SqliteModule | null | undefined;
export function loadSqlite(): SqliteModule | null {
  if (sqlite !== undefined) return sqlite;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    sqlite = require('node:sqlite') as SqliteModule;
  } catch {
    sqlite = null;
  }
  return sqlite;
}

/** Newest `<prefix>_<n>.sqlite` in the Codex home, since the schema version is in the file name. */
export async function newestDb(home: string, prefix: string): Promise<string | undefined> {
  let best: { n: number; file: string } | undefined;
  for (const e of await listDir(home)) {
    const m = new RegExp(`^${prefix}_(\\d+)\\.sqlite$`).exec(e.name);
    if (!m || !e.isFile()) continue;
    const n = Number(m[1]);
    if (!best || n > best.n) best = { n, file: path.join(home, e.name) };
  }
  return best?.file;
}

interface ThreadRow {
  id: string;
  title: string;
  first_user_message: string | null;
  cwd: string;
  git_branch: string | null;
  updated_at: number;
  updated_at_ms: number | null;
  created_at: number;
  archived: number;
  source: string;
  rollout_path: string;
  agent_nickname: string | null;
}

/** `source` of a spawned thread: `{"subagent":{"thread_spawn":{"parent_thread_id":…,"agent_nickname":…}}}`; guardians carry `{"subagent":{"other":"guardian"}}`. */
interface SpawnSource {
  subagent?: { thread_spawn?: { parent_thread_id?: string; agent_nickname?: string | null; agent_role?: string | null } };
}

function spawnOf(source: unknown): { parentId: string | undefined; role: string | undefined } {
  const raw = typeof source === 'string' ? (isSubagentSource(source) ? source : undefined) : source;
  if (!raw) return { parentId: undefined, role: undefined };
  try {
    const parsed = (typeof raw === 'string' ? JSON.parse(raw) : raw) as SpawnSource;
    const spawn = parsed.subagent?.thread_spawn;
    return { parentId: spawn?.parent_thread_id || undefined, role: spawn?.agent_nickname || spawn?.agent_role || undefined };
  } catch {
    return { parentId: undefined, role: undefined };
  }
}

async function readThreadNames(home: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const file = path.join(home, 'session_index.jsonl');
  if (!(await statOrUndefined(file))) return out;
  const rl = readline.createInterface({ input: createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
  try {
    for await (const line of rl) {
      if (!line) continue;
      try {
        const d = JSON.parse(line) as { id?: string; thread_name?: string };
        if (d.id && d.thread_name) out.set(d.id, d.thread_name);
      } catch {
        // skip
      }
    }
  } finally {
    rl.close();
  }
  return out;
}

/** Live thread ids → the pid of the codex process holding the writer lock (CLI or the VS Code extension's app-server), when /proc can tell. */
async function readLocks(home: string): Promise<Map<string, number | undefined>> {
  const dir = path.join(home, 'thread-writer-locks');
  const out = new Map<string, number | undefined>();
  const holders = process.platform === 'linux' ? await holdersOfFilesIn(dir, 'codex') : new Map<string, number>();
  for (const e of await listDir(dir)) {
    if (e.isFile() && e.name.endsWith('.lock') && (process.platform !== 'linux' || holders.has(e.name))) {
      out.set(e.name.slice(0, -'.lock'.length), holders.get(e.name));
    }
  }
  return out;
}

function isSubagentSource(source: string): boolean {
  // Human-started threads record a plain word ("cli", "vscode", "exec"); spawned ones record a JSON object.
  return source.trimStart().startsWith('{');
}

function stateFor(locked: boolean, lastTurn: string | undefined): SessionState {
  if (!locked) return 'stopped';
  if (lastTurn === 'inProgress') return 'running';
  return 'replied';
}

// ---- Where a thread's commands actually run ----

const DIR_REF = /"workdir"\s*:\s*"([^"]+)"|\bcd\s+(\/[^\s;&|"')]+)|\bgit\s+-C\s+(\/[^\s;&|"')]+)/g;
const TAIL_BYTES = 256 * 1024;
const workDirCache = new Map<string, { mtimeMs: number; size: number; dir: string | undefined }>();

/**
 * Codex records a thread's cwd once and never moves it, but the agent addresses a worktree through
 * the `workdir` of its exec calls (or `cd` / `git -C`), so the last such directory in the rollout is
 * where the thread is working now.
 */
function lastDirInLine(line: string): string | undefined {
  if (!line.includes('"response_item"') || !(line.includes('"function_call"') || line.includes('"custom_tool_call"'))) return undefined;
  let d: { type?: string; payload?: { type?: string; input?: string; arguments?: string } };
  try {
    d = JSON.parse(line) as typeof d;
  } catch {
    return undefined;
  }
  const p = d.payload;
  if (!p || (p.type !== 'function_call' && p.type !== 'custom_tool_call')) return undefined;
  const text = p.input ?? p.arguments ?? '';
  let last: string | undefined;
  for (const m of text.matchAll(DIR_REF)) last = m[1] ?? m[2] ?? m[3];
  return last;
}

async function lastDirInTail(rolloutPath: string, size: number): Promise<string | undefined> {
  const fh = await fsp.open(rolloutPath, 'r');
  try {
    const start = Math.max(0, size - TAIL_BYTES);
    const buf = Buffer.alloc(size - start);
    await fh.read(buf, 0, buf.length, start);
    const lines = buf.toString('utf8').split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      const dir = lastDirInLine(lines[i] ?? '');
      if (dir) return dir;
    }
  } finally {
    await fh.close();
  }
  return undefined;
}

async function lastDirInFile(rolloutPath: string): Promise<string | undefined> {
  let dir: string | undefined;
  const rl = readline.createInterface({ input: createReadStream(rolloutPath, { encoding: 'utf8' }), crlfDelay: Infinity });
  try {
    for await (const line of rl) dir = lastDirInLine(line) ?? dir;
  } finally {
    rl.close();
  }
  return dir;
}

async function lastCommandDir(rolloutPath: string, mtimeMs: number, size: number): Promise<string | undefined> {
  const cached = workDirCache.get(rolloutPath);
  if (cached && cached.mtimeMs === mtimeMs && cached.size === size) return cached.dir;
  let dir: string | undefined;
  try {
    // The tail is enough while the thread keeps issuing commands; a stretch of pure output
    // (one tool result can be far larger than the tail) must not make a known directory vanish,
    // so the previous answer sticks, and a rollout seen for the first time is read in full.
    dir = (await lastDirInTail(rolloutPath, size)) ?? cached?.dir ?? (cached ? undefined : await lastDirInFile(rolloutPath));
  } catch {
    dir = cached?.dir;
  }
  workDirCache.set(rolloutPath, { mtimeMs, size, dir });
  return dir;
}

const STREAM_SCAN_AGE_MS = 14 * 24 * 3600 * 1000;

async function worktreeForThread(cwd: string | undefined, branch: string | undefined, rolloutPath: string, live: boolean, mtimeMs: number, size: number): Promise<Worktree | undefined> {
  const direct = worktreeFromCwd(cwd, branch);
  if (direct) return direct;
  if (!live && Date.now() - mtimeMs > STREAM_SCAN_AGE_MS) return undefined;
  const dir = await lastCommandDir(rolloutPath, mtimeMs, size);
  return worktreeFromCwd(dir, undefined);
}

async function listFromSqlite(home: string, names: Map<string, string>, locks: Map<string, number | undefined>): Promise<Session[] | undefined> {
  const mod = loadSqlite();
  if (!mod) return undefined;
  const stateFile = await newestDb(home, 'state');
  if (!stateFile) return undefined;

  let rows: ThreadRow[];
  const lastTurn = new Map<string, string>();
  const parents = new Map<string, string>();
  try {
    const db = new mod.DatabaseSync(stateFile, { readOnly: true });
    try {
      rows = db
        .prepare(
          'SELECT id, title, first_user_message, cwd, git_branch, updated_at, updated_at_ms, created_at, archived, source, rollout_path, agent_nickname FROM threads',
        )
        .all() as unknown as ThreadRow[];
      try {
        // Codex's own record of who spawned whom; the source JSON is the fallback for rows written before the table.
        for (const e of db.prepare('SELECT parent_thread_id, child_thread_id FROM thread_spawn_edges').all() as { parent_thread_id: string; child_thread_id: string }[]) {
          parents.set(e.child_thread_id, e.parent_thread_id);
        }
      } catch {
        // Older state databases have no spawn edges.
      }
    } finally {
      db.close();
    }
  } catch {
    return undefined;
  }

  const historyFile = await newestDb(home, 'thread_history');
  if (historyFile) {
    try {
      const db = new mod.DatabaseSync(historyFile, { readOnly: true });
      try {
        const turns = db
          .prepare(
            `SELECT t.thread_id AS thread_id, t.status AS status
             FROM thread_turns t
             WHERE t.rollout_ordinal = (SELECT MAX(rollout_ordinal) FROM thread_turns u WHERE u.thread_id = t.thread_id)`,
          )
          .all() as { thread_id: string; status: string }[];
        for (const t of turns) lastTurn.set(t.thread_id, t.status);
      } finally {
        db.close();
      }
    } catch {
      // Status detail is optional; locks alone still tell live from stopped.
    }
  }

  const sessions: Session[] = [];
  for (const r of rows) {
    const st = await statOrUndefined(r.rollout_path);
    // Codex's own clock for the thread; the rollout's mtime also moves on maintenance rewrites.
    const updatedAt = r.updated_at_ms ?? (r.updated_at ? r.updated_at * 1000 : undefined) ?? st?.mtimeMs ?? 0;
    const locked = locks.has(r.id);
    const worktree = st ? await worktreeForThread(r.cwd || undefined, r.git_branch ?? undefined, r.rollout_path, locked, st.mtimeMs, st.size) : undefined;
    const prompt = r.first_user_message ? cleanTitle(r.first_user_message) : '';
    const title = names.get(r.id) ?? (r.title ? cleanTitle(r.title) : '') ?? prompt;
    const spawn = spawnOf(r.source);
    sessions.push({
      tool: 'codex',
      id: r.id,
      title: title || prompt || '(no prompt yet)',
      cwd: r.cwd || undefined,
      branch: r.git_branch ?? undefined,
      worktree,
      updatedAt,
      startedAt: r.created_at ? r.created_at * 1000 : updatedAt,
      state: stateFor(locked, lastTurn.get(r.id)),
      archived: r.archived === 1,
      subagent: isSubagentSource(r.source),
      parentId: parents.get(r.id) ?? spawn.parentId,
      agentRole: r.agent_nickname || spawn.role,
      empty: !r.first_user_message,
      transcriptPath: r.rollout_path,
      pid: locks.get(r.id),
      inThisWindow: false,
    });
  }
  return sessions;
}

// ---- Fallback: read the rollout files directly ----

interface RolloutMeta {
  id?: string;
  cwd?: string;
  source?: unknown;
  thread_source?: string;
  git?: { branch?: string };
}

interface RolloutSummary {
  id: string | undefined;
  cwd: string | undefined;
  branch: string | undefined;
  subagent: boolean;
  parentId: string | undefined;
  agentRole: string | undefined;
  firstPrompt: string | undefined;
  lastTurnInProgress: boolean;
  lastAt: number | undefined;
  firstAt: number | undefined;
}

const rolloutCache = new Map<string, { mtimeMs: number; size: number; summary: RolloutSummary }>();

async function summarizeRollout(file: string, mtimeMs: number, size: number): Promise<RolloutSummary> {
  const cached = rolloutCache.get(file);
  if (cached && cached.mtimeMs === mtimeMs && cached.size === size) return cached.summary;
  const summary: RolloutSummary = { id: undefined, cwd: undefined, branch: undefined, subagent: false, parentId: undefined, agentRole: undefined, firstPrompt: undefined, lastTurnInProgress: false, lastAt: undefined, firstAt: undefined };
  const rl = readline.createInterface({ input: createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
  try {
    for await (const line of rl) {
      if (!line) continue;
      let d: { type?: string; timestamp?: string; payload?: Record<string, unknown> };
      try {
        d = JSON.parse(line) as typeof d;
      } catch {
        continue;
      }
      const p = d.payload ?? {};
      if (d.timestamp) {
        const t = Date.parse(d.timestamp);
        if (Number.isFinite(t)) {
          summary.firstAt ??= t;
          summary.lastAt = t;
        }
      }
      if (d.type === 'session_meta') {
        const meta = p as RolloutMeta;
        summary.id ??= meta.id;
        summary.cwd ??= meta.cwd;
        summary.branch ??= meta.git?.branch;
        if (meta.thread_source === 'subagent' || (meta.source && typeof meta.source === 'object')) {
          summary.subagent = true;
          const spawn = spawnOf(meta.source);
          summary.parentId = spawn.parentId;
          summary.agentRole = spawn.role;
        }
      } else if (d.type === 'event_msg') {
        const kind = p.type;
        if (kind === 'user_message' && !summary.firstPrompt) {
          const t = cleanTitle(String(p.message ?? ''));
          if (t) summary.firstPrompt = t;
        }
        if (kind === 'task_started') summary.lastTurnInProgress = true;
        else if (kind === 'task_complete' || kind === 'turn_aborted' || kind === 'error') summary.lastTurnInProgress = false;
      }
    }
  } finally {
    rl.close();
  }
  if (!summary.id) {
    const m = /rollout-.*?-([0-9a-f]{8}-[0-9a-f-]{27,})\.jsonl$/.exec(path.basename(file));
    summary.id = m?.[1];
  }
  rolloutCache.set(file, { mtimeMs, size, summary });
  return summary;
}

async function listFromRollouts(home: string, names: Map<string, string>, locks: Map<string, number | undefined>): Promise<Session[]> {
  const sessions: Session[] = [];
  const dirs: { dir: string; archived: boolean }[] = [
    { dir: path.join(home, 'sessions'), archived: false },
    { dir: path.join(home, 'archived_sessions'), archived: true },
  ];
  for (const { dir, archived } of dirs) {
    for (const file of await walkFiles(dir, (n) => n.startsWith('rollout-') && n.endsWith('.jsonl'))) {
      const st = await statOrUndefined(file);
      if (!st) continue;
      const s = await summarizeRollout(file, st.mtimeMs, st.size);
      if (!s.id) continue;
      const locked = locks.has(s.id);
      sessions.push({
        tool: 'codex',
        id: s.id,
        title: names.get(s.id) ?? s.firstPrompt ?? '(no prompt yet)',
        cwd: s.cwd,
        branch: s.branch,
        worktree: await worktreeForThread(s.cwd, s.branch, file, locked, st.mtimeMs, st.size),
        updatedAt: s.lastAt ?? st.mtimeMs,
        startedAt: s.firstAt ?? st.birthtimeMs,
        state: stateFor(locked, s.lastTurnInProgress ? 'inProgress' : undefined),
        archived,
        subagent: s.subagent,
        parentId: s.parentId,
        agentRole: s.agentRole,
        empty: !s.firstPrompt,
        transcriptPath: file,
        pid: locks.get(s.id),
        inThisWindow: false,
      });
    }
  }
  return sessions;
}

export async function listCodexSessions(home: string): Promise<Session[]> {
  const [names, locks] = await Promise.all([readThreadNames(home), readLocks(home)]);
  return (await listFromSqlite(home, names, locks)) ?? (await listFromRollouts(home, names, locks));
}

export function codexWatchPaths(home: string): string[] {
  return [home, path.join(home, 'sessions'), path.join(home, 'archived_sessions'), path.join(home, 'thread-writer-locks')];
}
