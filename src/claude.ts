import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Session, SessionState } from './types.js';
import type { WatchSpec, Worktree } from './types.js';
import { cleanTitle, expandHome, listDir, processAlive, readJsonFile, statOrUndefined } from './util.js';
import { FileCache } from './file-cache.js';
import { type Scan, scanAppended } from './appended.js';
import { commandDirs, inRepository, worktreeFromCwd, worktreeFromPath } from './worktree.js';

export function claudeHome(configured: string): string {
  if (configured) return expandHome(configured);
  if (process.env.CLAUDE_CONFIG_DIR) return expandHome(process.env.CLAUDE_CONFIG_DIR);
  return path.join(os.homedir(), '.claude');
}

/** The sidecar Claude Code writes on `/rename`, next to the transcript: `<project dir>/<session id>/custom-title.json`. */
export function customTitleFile(transcriptPath: string, sessionId: string): string {
  return path.join(path.dirname(transcriptPath), sessionId, 'custom-title.json');
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
  /**
   * The repository directory the session last worked in: a file it edited, a `cd` or `git -C` in a command, or its
   * shell moving. Claude's shell returns to the start directory after every command, so this finds a worktree the
   * session reaches by absolute path, which is how agents working from the main checkout use one.
   */
  workDir: string | undefined;
  /** Timestamp of the last message; the file's mtime drifts (Claude rewrites transcripts on resume and title updates). */
  lastAt: number | undefined;
  firstAt: number | undefined;
  lastRole: 'user' | 'assistant' | undefined;
  /** The last record is the person (or parent agent) cutting the turn off. */
  lastInterrupted: boolean;
  hasPrompt: boolean;
  /** The permission mode the last prompt ran in, and that prompt's time. */
  permissionMode: { mode: string; at: number } | undefined;
}

/** A summary as far as the transcript was read (see appended.ts). */
interface TranscriptScan extends TranscriptSummary, Scan {
  customTitle: string | undefined;
  aiTitle: string | undefined;
  firstPrompt: string | undefined;
}

/** Bump when summarizeTranscript reads something new or reads it differently. */
const transcriptCache = new FileCache<TranscriptScan>('claude-transcripts', 3);

interface TranscriptLine {
  type?: string;
  customTitle?: string;
  aiTitle?: string;
  cwd?: string;
  gitBranch?: string;
  isMeta?: boolean;
  isSidechain?: boolean;
  timestamp?: string;
  /** On a user record: the permission mode that prompt was sent in. */
  permissionMode?: string;
  message?: { role?: string; content?: unknown };
  /** `worktree-state` records: the session's current worktree binding, null once it has exited. */
  worktreeSession?: { worktreePath?: string; worktreeName?: string; worktreeBranch?: string; originalCwd?: string } | null;
}

/** Tools whose target is a file the session is changing. */
const EDIT_TOOLS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit']);

/** The directories an assistant record's tool calls work in, in order. */
function toolCallDirs(content: unknown): string[] {
  if (!Array.isArray(content)) return [];
  const out: string[] = [];
  for (const c of content as { type?: string; name?: string; input?: { file_path?: unknown; notebook_path?: unknown; command?: unknown } }[]) {
    if (c?.type !== 'tool_use' || !c.input) continue;
    const file = c.input.file_path ?? c.input.notebook_path;
    if (c.name && EDIT_TOOLS.has(c.name) && typeof file === 'string' && path.isAbsolute(file)) out.push(path.dirname(file));
    else if (c.name === 'Bash' && typeof c.input.command === 'string') out.push(...commandDirs(c.input.command));
  }
  return out;
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

/** A subagent transcript's sidecar: `<session id>/subagents/agent-<id>.meta.json`. Teammates carry `name` and `taskKind`. */
interface SubagentMeta {
  agentType?: string;
  description?: string;
  name?: string;
  taskKind?: string;
}

function freshScan(): TranscriptScan {
  return {
    title: undefined, cwd: undefined, branch: undefined, worktree: undefined, lastCwd: undefined, workDir: undefined, lastAt: undefined, firstAt: undefined,
    lastRole: undefined, lastInterrupted: false, hasPrompt: false, permissionMode: undefined,
    customTitle: undefined, aiTitle: undefined, firstPrompt: undefined, offset: 0, tail: '',
  };
}

async function summarizeTranscript(file: string, mtimeMs: number, size: number, sidechain = false): Promise<TranscriptSummary> {
  const cached = transcriptCache.get(file, mtimeMs, size);
  if (cached) return cached;

  const scan = await scanAppended(file, size, transcriptCache.previous(file)?.value, freshScan, (scan, line) => readRecord(scan, line, sidechain));
  scan.title = scan.customTitle ?? scan.aiTitle ?? scan.firstPrompt;
  transcriptCache.set(file, mtimeMs, size, scan);
  return scan;
}

function readRecord(scan: TranscriptScan, line: string, sidechain: boolean): void {
  let d: TranscriptLine;
  try {
    d = JSON.parse(line) as TranscriptLine;
  } catch {
    return;
  }
  switch (d.type) {
    case 'custom-title':
      if (d.customTitle) scan.customTitle = d.customTitle;
      break;
    case 'ai-title':
      if (d.aiTitle) scan.aiTitle = d.aiTitle;
      break;
    case 'worktree-state': {
      // The record's cwd fields track the shell, hopping into subfolders and other worktrees;
      // only this record says which worktree the session itself is bound to.
      const ws = d.worktreeSession;
      scan.worktree = ws?.worktreePath ? worktreeFromPath(ws.worktreePath, ws.worktreeName, ws.worktreeBranch) : null;
      if (ws?.originalCwd) scan.cwd = ws.originalCwd;
      break;
    }
    case 'user':
    case 'assistant': {
      // A subagent's own transcript is all sidechain; in a main transcript sidechain records are another agent's.
      if (Boolean(d.isSidechain) !== sidechain) break;
      // The first cwd is the directory the session was started in; later ones follow the shell.
      if (d.cwd) {
        scan.cwd ??= d.cwd;
        if (d.cwd !== scan.lastCwd && inRepository(d.cwd)) scan.workDir = d.cwd;
        scan.lastCwd = d.cwd;
      }
      if (d.type === 'assistant') {
        for (const dir of toolCallDirs(d.message?.content)) if (inRepository(dir)) scan.workDir = dir;
      }
      if (d.gitBranch) scan.branch = d.gitBranch;
      const t = d.timestamp ? Date.parse(d.timestamp) : NaN;
      if (Number.isFinite(t)) {
        scan.firstAt ??= t;
        scan.lastAt = t;
        if (d.type === 'user' && d.permissionMode) scan.permissionMode = { mode: d.permissionMode, at: t };
      }
      const role = d.message?.role === 'assistant' || d.type === 'assistant' ? 'assistant' : 'user';
      scan.lastInterrupted = false;
      if (role === 'user') {
        if (d.isMeta) break;
        const text = textOf(d.message?.content);
        if (/^\[Request interrupted by user/.test(text.trim())) {
          scan.lastInterrupted = true;
          scan.lastRole = role;
          break;
        }
        // Tool results are user-role records too; only free text counts as a prompt.
        if (!text.trim()) break;
        scan.hasPrompt = true;
        if (!scan.firstPrompt) {
          const cleaned = cleanTitle(text);
          if (cleaned) scan.firstPrompt = cleaned;
        }
      }
      scan.lastRole = role;
      break;
    }
    default:
      break;
  }
}

/**
 * The worktree a session is bound to (EnterWorktree) or, without a binding, the one it last worked in; undefined
 * when that was a main checkout. The recorded branch belongs to the shell's directory, so it names the worktree
 * only when that directory is where the work was.
 */
function workingWorktree(summary: TranscriptSummary): Worktree | undefined {
  if (summary.worktree !== undefined) return summary.worktree ?? undefined;
  if (!summary.workDir) return undefined;
  return worktreeFromCwd(summary.workDir, summary.workDir === summary.lastCwd ? summary.branch : undefined);
}

function stateFor(live: LiveInfo | undefined, last: Pick<TranscriptSummary, 'lastRole' | 'lastInterrupted'> | undefined): SessionState {
  if (!live) return 'stopped';
  switch (live.status) {
    case 'busy':
    case 'shell':
      return 'running';
    case 'waiting':
      return 'waiting';
    case 'idle':
      // A prompt not yet picked up is still running; an interruption is the turn ending.
      return last?.lastRole === 'user' && !last.lastInterrupted ? 'running' : 'replied';
    default:
      return 'replied';
  }
}

/** A subagent is live only while its parent is; within that, a transcript still moving is running. */
const SUBAGENT_ACTIVE_WINDOW_MS = 2 * 60_000;
/** A subagent waiting on a tool call writes nothing until it returns; allow a long one before calling it stopped. */
const SUBAGENT_TOOL_WINDOW_MS = 10 * 60_000;

/**
 * Claude writes no end marker for a subagent, so recency stands in for one: a transcript that stopped growing is a
 * subagent that finished. An interruption marker ends it outright, however recent.
 */
function subagentState(parentLive: LiveInfo | undefined, summary: TranscriptSummary): SessionState {
  if (!parentLive || summary.lastInterrupted || summary.lastAt === undefined) return 'stopped';
  const idle = Date.now() - summary.lastAt;
  if (idle < (summary.lastRole === 'user' ? SUBAGENT_TOOL_WINDOW_MS : SUBAGENT_ACTIVE_WINDOW_MS)) return 'running';
  return 'stopped';
}

/**
 * Subagents and teammates a session spawned: `<project dir>/<session id>/subagents/agent-*.jsonl`, each with a
 * `.meta.json` naming it (a teammate by its `name`, a subagent by the task description).
 */
async function listSubagents(parent: Session, parentLive: LiveInfo | undefined): Promise<Session[]> {
  const dir = path.join(path.dirname(parent.transcriptPath), parent.id, 'subagents');
  // Subagents run only while their session does, so a stopped session's list holds until a file is added or removed.
  const dirMtime = parentLive ? undefined : (await statOrUndefined(dir))?.mtimeMs;
  const key = dirMtime === undefined ? undefined : `${dirMtime}:${parent.updatedAt}`;
  const known = stoppedSubagents.get(parent.transcriptPath);
  if (key !== undefined && known?.key === key) return known.sessions;
  const out: Session[] = [];
  for (const e of await listDir(dir)) {
    if (!e.isFile() || !e.name.startsWith('agent-') || !e.name.endsWith('.jsonl')) continue;
    const file = path.join(dir, e.name);
    const st = await statOrUndefined(file);
    if (!st) continue;
    const agentId = e.name.slice('agent-'.length, -'.jsonl'.length);
    const summary = await summarizeTranscript(file, st.mtimeMs, st.size, true);
    const meta = await readJsonFile<SubagentMeta>(file.slice(0, -'.jsonl'.length) + '.meta.json');
    const teammate = meta?.taskKind === 'in_process_teammate';
    const label = (teammate ? meta?.name : undefined) ?? meta?.description ?? meta?.name;
    out.push({
      tool: 'claude',
      id: agentId,
      title: label?.trim() || summary.title || '(subagent)',
      cwd: summary.cwd ?? parent.cwd,
      branch: summary.branch ?? parent.branch,
      worktree: workingWorktree(summary) ?? parent.worktree,
      updatedAt: summary.lastAt ?? st.mtimeMs,
      startedAt: summary.firstAt ?? st.birthtimeMs,
      state: subagentState(parentLive, summary),
      archived: false,
      subagent: true,
      parentId: parent.id,
      agentRole: teammate ? 'teammate' : meta?.agentType,
      empty: !summary.hasPrompt,
      transcriptPath: file,
      pid: undefined,
      inThisWindow: false,
      permissionMode: summary.permissionMode,
    });
  }
  if (key !== undefined) stoppedSubagents.set(parent.transcriptPath, { key, sessions: out });
  else stoppedSubagents.delete(parent.transcriptPath);
  return out;
}

const stoppedSubagents = new Map<string, { key: string; sessions: Session[] }>();

export async function listClaudeSessions(home: string): Promise<Session[]> {
  const projectsDir = path.join(home, 'projects');
  await transcriptCache.ready();
  const live = await readLiveSessions(home);
  const sessions: Session[] = [];
  const seen = new Set<string>();

  for (const project of await listDir(projectsDir)) {
    if (!project.isDirectory()) continue;
    const dir = path.join(projectsDir, project.name);
    const entries = await listDir(dir);
    // A session's title sidecar and subagents live in a folder named after it, which most sessions never get.
    const sessionDirs = new Set(entries.filter((e) => e.isDirectory()).map((e) => e.name));
    for (const e of entries) {
      if (!e.isFile() || !e.name.endsWith('.jsonl')) continue;
      const id = e.name.slice(0, -'.jsonl'.length);
      const file = path.join(dir, e.name);
      const st = await statOrUndefined(file);
      if (!st) continue;
      const summary = await summarizeTranscript(file, st.mtimeMs, st.size);
      // Claude Code keeps a renamed title beside the transcript too (`<id>/custom-title.json`) and reads that first.
      const sidecar = sessionDirs.has(id) ? await readJsonFile<{ customTitle?: string }>(customTitleFile(file, id)) : undefined;
      const customTitle = typeof sidecar?.customTitle === 'string' && sidecar.customTitle.trim() ? sidecar.customTitle.trim() : undefined;
      const liveInfo = live.get(id);
      const cwd = summary.cwd ?? liveInfo?.cwd;
      seen.add(id);
      const parent: Session = {
        tool: 'claude',
        id,
        title: customTitle ?? liveInfo?.name ?? summary.title ?? '(no prompt yet)',
        cwd,
        branch: summary.branch,
        worktree: workingWorktree(summary) ?? (summary.workDir ? undefined : worktreeFromCwd(cwd, undefined)),
        updatedAt: summary.lastAt ?? st.mtimeMs,
        startedAt: summary.firstAt ?? st.birthtimeMs,
        state: stateFor(liveInfo, summary),
        archived: false,
        subagent: false,
        parentId: undefined,
        agentRole: undefined,
        empty: !summary.hasPrompt,
        transcriptPath: file,
        pid: liveInfo?.pid,
        inThisWindow: false,
        permissionMode: summary.permissionMode,
      };
      sessions.push(parent);
      if (sessionDirs.has(id)) sessions.push(...(await listSubagents(parent, liveInfo)));
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
      startedAt: Date.now(),
      state: stateFor(info, undefined),
      archived: false,
      subagent: false,
      parentId: undefined,
      agentRole: undefined,
      empty: true,
      transcriptPath: '',
      pid: info.pid,
      inThisWindow: false,
      permissionMode: undefined,
    });
  }

  return sessions;
}

/** Directories whose change should trigger a refresh. */
export function claudeWatchPaths(home: string): WatchSpec[] {
  return [
    // `<pid>.json` says what a live session is doing; the key files beside it change without meaning anything here.
    { path: path.join(home, 'sessions'), recursive: false, accept: (name) => name.endsWith('.json') },
    // Transcripts, subagent transcripts, their meta files and title sidecars; not tool results or file backups.
    { path: path.join(home, 'projects'), recursive: true, accept: (name) => name.endsWith('.jsonl') || name.endsWith('.json') },
  ];
}

export async function claudeAvailable(home: string): Promise<boolean> {
  return (await statOrUndefined(path.join(home, 'projects'))) !== undefined || (await fsp.access(home).then(() => true, () => false));
}
