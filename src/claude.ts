import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import * as readline from 'node:readline';
import { createReadStream } from 'node:fs';
import type { Session, SessionState } from './types.js';
import type { Worktree } from './types.js';
import { cleanTitle, expandHome, listDir, processAlive, readJsonFile, statOrUndefined } from './util.js';
import { worktreeFromCwd, worktreeFromPath } from './worktree.js';

export function claudeHome(configured: string): string {
  if (configured) return expandHome(configured);
  if (process.env.CLAUDE_CONFIG_DIR) return expandHome(process.env.CLAUDE_CONFIG_DIR);
  return path.join(os.homedir(), '.claude');
}

/** Shape of ~/.claude/sessions/<pid>.json, written by every running claude process. */
interface LiveSessionFile {
  pid?: number;
  sessionId?: string;
  cwd?: string;
  status?: 'busy' | 'shell' | 'idle' | 'waiting';
  kind?: 'interactive' | 'bg' | 'daemon' | 'daemon-worker';
  entrypoint?: string;
  name?: string;
  nameSource?: string;
}

interface LiveInfo {
  pid: number;
  status: LiveSessionFile['status'];
  name: string | undefined;
  cwd: string | undefined;
}

async function readLiveSessions(home: string): Promise<Map<string, LiveInfo>> {
  const out = new Map<string, LiveInfo>();
  for (const e of await listDir(path.join(home, 'sessions'))) {
    if (!e.isFile() || !e.name.endsWith('.json')) continue;
    const pid = Number.parseInt(e.name.slice(0, -'.json'.length), 10);
    if (!Number.isInteger(pid)) continue;
    const data = await readJsonFile<LiveSessionFile>(path.join(home, 'sessions', e.name));
    if (!data?.sessionId) continue;
    if (!processAlive(data.pid ?? pid)) continue;
    out.set(data.sessionId, {
      pid: data.pid ?? pid,
      status: data.status,
      // "derived" names are just the folder name; only user- or AI-given names are titles.
      name: data.nameSource && data.nameSource !== 'derived' ? data.name : undefined,
      cwd: data.cwd,
    });
  }
  return out;
}

interface TranscriptSummary {
  title: string | undefined;
  cwd: string | undefined;
  branch: string | undefined;
  /** From the latest `worktree-state` record: set on EnterWorktree, null after ExitWorktree, undefined when never recorded. */
  worktree: Worktree | null | undefined;
  /** The most recent cwd recorded on a message: where the session's shell is now. */
  lastCwd: string | undefined;
  lastRole: 'user' | 'assistant' | undefined;
  hasPrompt: boolean;
}

interface CacheEntry {
  mtimeMs: number;
  size: number;
  summary: TranscriptSummary;
}

const transcriptCache = new Map<string, CacheEntry>();

interface TranscriptLine {
  type?: string;
  customTitle?: string;
  aiTitle?: string;
  cwd?: string;
  gitBranch?: string;
  isMeta?: boolean;
  isSidechain?: boolean;
  message?: { role?: string; content?: unknown };
  /** `worktree-state` records: the session's current worktree binding, null once it has exited. */
  worktreeSession?: { worktreePath?: string; worktreeName?: string; worktreeBranch?: string; originalCwd?: string } | null;
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((c) => (c && typeof c === 'object' && (c as { type?: string }).type === 'text' ? String((c as { text?: string }).text ?? '') : ''))
      .join('\n');
  }
  return '';
}

async function summarizeTranscript(file: string, mtimeMs: number, size: number): Promise<TranscriptSummary> {
  const cached = transcriptCache.get(file);
  if (cached && cached.mtimeMs === mtimeMs && cached.size === size) return cached.summary;

  const summary: TranscriptSummary = { title: undefined, cwd: undefined, branch: undefined, worktree: undefined, lastCwd: undefined, lastRole: undefined, hasPrompt: false };
  let customTitle: string | undefined;
  let aiTitle: string | undefined;
  let firstPrompt: string | undefined;

  const rl = readline.createInterface({ input: createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
  try {
    for await (const line of rl) {
      if (!line) continue;
      let d: TranscriptLine;
      try {
        d = JSON.parse(line) as TranscriptLine;
      } catch {
        continue;
      }
      switch (d.type) {
        case 'custom-title':
          if (d.customTitle) customTitle = d.customTitle;
          break;
        case 'ai-title':
          if (d.aiTitle) aiTitle = d.aiTitle;
          break;
        case 'worktree-state': {
          // The record's cwd fields track the shell, hopping into subfolders and other worktrees;
          // only this record says which worktree the session itself is bound to.
          const ws = d.worktreeSession;
          summary.worktree = ws?.worktreePath ? worktreeFromPath(ws.worktreePath, ws.worktreeName, ws.worktreeBranch) : null;
          if (ws?.originalCwd) summary.cwd = ws.originalCwd;
          break;
        }
        case 'user':
        case 'assistant': {
          if (d.isSidechain) break;
          // The first cwd is the directory the session was started in; later ones follow the shell.
          if (d.cwd) {
            summary.cwd ??= d.cwd;
            summary.lastCwd = d.cwd;
          }
          if (d.gitBranch) summary.branch = d.gitBranch;
          const role = d.message?.role === 'assistant' || d.type === 'assistant' ? 'assistant' : 'user';
          if (role === 'user') {
            if (d.isMeta) break;
            const text = textOf(d.message?.content);
            // Tool results are user-role records too; only free text counts as a prompt.
            if (!text.trim()) break;
            summary.hasPrompt = true;
            if (!firstPrompt) {
              const cleaned = cleanTitle(text);
              if (cleaned) firstPrompt = cleaned;
            }
          }
          summary.lastRole = role;
          break;
        }
        default:
          break;
      }
    }
  } finally {
    rl.close();
  }

  summary.title = customTitle ?? aiTitle ?? firstPrompt;
  transcriptCache.set(file, { mtimeMs, size, summary });
  return summary;
}

function stateFor(live: LiveInfo | undefined, lastRole: TranscriptSummary['lastRole']): SessionState {
  if (!live) return 'stopped';
  switch (live.status) {
    case 'busy':
    case 'shell':
      return 'running';
    case 'waiting':
      return 'waiting';
    case 'idle':
      return lastRole === 'user' ? 'running' : 'replied';
    default:
      return 'replied';
  }
}

export async function listClaudeSessions(home: string): Promise<Session[]> {
  const projectsDir = path.join(home, 'projects');
  const live = await readLiveSessions(home);
  const sessions: Session[] = [];
  const seen = new Set<string>();

  for (const project of await listDir(projectsDir)) {
    if (!project.isDirectory()) continue;
    const dir = path.join(projectsDir, project.name);
    for (const e of await listDir(dir)) {
      if (!e.isFile() || !e.name.endsWith('.jsonl')) continue;
      const id = e.name.slice(0, -'.jsonl'.length);
      const file = path.join(dir, e.name);
      const st = await statOrUndefined(file);
      if (!st) continue;
      const summary = await summarizeTranscript(file, st.mtimeMs, st.size);
      const liveInfo = live.get(id);
      const cwd = summary.cwd ?? liveInfo?.cwd;
      seen.add(id);
      sessions.push({
        tool: 'claude',
        id,
        title: liveInfo?.name ?? summary.title ?? '(no prompt yet)',
        cwd,
        branch: summary.branch,
        // Without a binding, the shell's current directory tells: started inside a worktree, or `cd`'d into one and stayed.
        worktree: summary.worktree ?? worktreeFromCwd(summary.lastCwd ?? cwd, summary.branch),
        updatedAt: st.mtimeMs,
        state: stateFor(liveInfo, summary.lastRole),
        archived: false,
        subagent: false,
        empty: !summary.hasPrompt,
        transcriptPath: file,
        pid: liveInfo?.pid,
      });
    }
  }

  // A process that has started but not written its transcript yet is still a session.
  for (const [id, info] of live) {
    if (seen.has(id)) continue;
    sessions.push({
      tool: 'claude',
      id,
      title: info.name ?? '(new session)',
      cwd: info.cwd,
      branch: undefined,
      worktree: worktreeFromCwd(info.cwd, undefined),
      updatedAt: Date.now(),
      state: stateFor(info, undefined),
      archived: false,
      subagent: false,
      empty: true,
      transcriptPath: '',
      pid: info.pid,
    });
  }

  return sessions;
}

/** Directories whose change should trigger a refresh. */
export function claudeWatchPaths(home: string): string[] {
  return [path.join(home, 'sessions'), path.join(home, 'projects')];
}

export async function claudeAvailable(home: string): Promise<boolean> {
  return (await statOrUndefined(path.join(home, 'projects'))) !== undefined || (await fsp.access(home).then(() => true, () => false));
}
