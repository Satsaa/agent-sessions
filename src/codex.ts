import * as os from 'node:os';
import * as path from 'node:path';
import * as readline from 'node:readline';
import { createReadStream } from 'node:fs';
import type { Session, SessionState } from './types.js';
import { cleanTitle, expandHome, listDir, statOrUndefined, walkFiles } from './util.js';

export function codexHome(configured: string): string {
  if (configured) return expandHome(configured);
  if (process.env.CODEX_HOME) return expandHome(process.env.CODEX_HOME);
  return path.join(os.homedir(), '.codex');
}

// ---- node:sqlite, loaded lazily so the extension still works on a host without it ----

interface SqliteStatement {
  all(...params: unknown[]): Record<string, unknown>[];
}
interface SqliteDatabase {
  prepare(sql: string): SqliteStatement;
  close(): void;
}
interface SqliteModule {
  DatabaseSync: new (file: string, options?: { readOnly?: boolean }) => SqliteDatabase;
}

let sqlite: SqliteModule | null | undefined;
function loadSqlite(): SqliteModule | null {
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
async function newestDb(home: string, prefix: string): Promise<string | undefined> {
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
  created_at: number;
  archived: number;
  source: string;
  rollout_path: string;
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

/** Thread ids currently held open by a codex process (CLI or the VS Code extension's app-server). */
async function readLocks(home: string): Promise<Set<string>> {
  const out = new Set<string>();
  for (const e of await listDir(path.join(home, 'thread-writer-locks'))) {
    if (e.isFile() && e.name.endsWith('.lock')) out.add(e.name.slice(0, -'.lock'.length));
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

async function listFromSqlite(home: string, names: Map<string, string>, locks: Set<string>): Promise<Session[] | undefined> {
  const mod = loadSqlite();
  if (!mod) return undefined;
  const stateFile = await newestDb(home, 'state');
  if (!stateFile) return undefined;

  let rows: ThreadRow[];
  const lastTurn = new Map<string, string>();
  try {
    const db = new mod.DatabaseSync(stateFile, { readOnly: true });
    try {
      rows = db
        .prepare(
          'SELECT id, title, first_user_message, cwd, git_branch, updated_at, created_at, archived, source, rollout_path FROM threads',
        )
        .all() as unknown as ThreadRow[];
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
    const updatedAt = st?.mtimeMs ?? r.updated_at * 1000;
    const prompt = r.first_user_message ? cleanTitle(r.first_user_message) : '';
    const title = names.get(r.id) ?? (r.title ? cleanTitle(r.title) : '') ?? prompt;
    sessions.push({
      tool: 'codex',
      id: r.id,
      title: title || prompt || '(no prompt yet)',
      cwd: r.cwd || undefined,
      branch: r.git_branch ?? undefined,
      updatedAt,
      state: stateFor(locks.has(r.id), lastTurn.get(r.id)),
      archived: r.archived === 1,
      subagent: isSubagentSource(r.source),
      empty: !r.first_user_message,
      transcriptPath: r.rollout_path,
      pid: undefined,
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
  firstPrompt: string | undefined;
  lastTurnInProgress: boolean;
}

const rolloutCache = new Map<string, { mtimeMs: number; size: number; summary: RolloutSummary }>();

async function summarizeRollout(file: string, mtimeMs: number, size: number): Promise<RolloutSummary> {
  const cached = rolloutCache.get(file);
  if (cached && cached.mtimeMs === mtimeMs && cached.size === size) return cached.summary;
  const summary: RolloutSummary = { id: undefined, cwd: undefined, branch: undefined, subagent: false, firstPrompt: undefined, lastTurnInProgress: false };
  const rl = readline.createInterface({ input: createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
  try {
    for await (const line of rl) {
      if (!line) continue;
      let d: { type?: string; payload?: Record<string, unknown> };
      try {
        d = JSON.parse(line) as typeof d;
      } catch {
        continue;
      }
      const p = d.payload ?? {};
      if (d.type === 'session_meta') {
        const meta = p as RolloutMeta;
        summary.id ??= meta.id;
        summary.cwd ??= meta.cwd;
        summary.branch ??= meta.git?.branch;
        if (meta.thread_source === 'subagent' || (meta.source && typeof meta.source === 'object')) summary.subagent = true;
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

async function listFromRollouts(home: string, names: Map<string, string>, locks: Set<string>): Promise<Session[]> {
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
        updatedAt: st.mtimeMs,
        state: stateFor(locked, s.lastTurnInProgress ? 'inProgress' : undefined),
        archived,
        subagent: s.subagent,
        empty: !s.firstPrompt,
        transcriptPath: file,
        pid: undefined,
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
