import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * Claude Code keeps what mode each session runs in per VS Code install: in a tab's own state while the tab lives, and
 * in `<globalStorage>/anthropic.claude-code/session-permission-modes/<id>.json` (`{ mode, updatedAt }`), which its
 * panel re-reads whenever it lists sessions. The phone's serve-web is another install, and with a process wrapper set
 * Claude Code no longer lets the CLI choose a mode it has none for: it passes `--permission-mode default`. A session
 * moved to the phone came up in Manual.
 *
 * So before a window opens a Claude session, its store is given the mode the session's last prompt ran in, unless
 * this install recorded a choice since. The panel still decides: a mode this window may not use (bypass without
 * `claudeCode.allowDangerouslySkipPermissions`) is dropped by the panel as it would drop its own.
 */
export function claudeModeStore(globalStorageDir: string): string {
  return path.join(path.dirname(globalStorageDir), 'anthropic.claude-code', 'session-permission-modes');
}

/** Claude Code's own rule for an id it will name a file after. */
const SESSION_ID = /^[0-9a-f-]{8,64}$/i;

export async function seedSessionMode(store: string, sessionId: string, last: { mode: string; at: number }, now = Date.now()): Promise<boolean> {
  if (!SESSION_ID.test(sessionId)) return false;
  const file = path.join(store, `${sessionId}.json`);
  try {
    const current = JSON.parse(await fsp.readFile(file, 'utf8')) as { updatedAt?: unknown };
    if (typeof current.updatedAt === 'number' && current.updatedAt >= last.at) return false;
  } catch {
    // None recorded, or unreadable: the transcript's is the best there is.
  }
  await fsp.mkdir(store, { recursive: true });
  const tmp = `${file}.${process.pid}.${now}.tmp`;
  // Stamped now, not with the prompt's time: the panel ignores entries older than 30 days, and it orders its own
  // writes by this stamp, so a choice made in this window after the open still wins.
  await fsp.writeFile(tmp, JSON.stringify({ mode: last.mode, updatedAt: now }));
  await fsp.rename(tmp, file);
  return true;
}

/**
 * Claude Code's permission settings are machine-scoped, so the phone's serve-web has its own and never sees the
 * desktop's. Desktop windows publish theirs here; the phone applies them to itself.
 */
export const MIRRORED_CLAUDE_SETTINGS = ['allowDangerouslySkipPermissions', 'initialPermissionMode'] as const;
export type MirroredClaudeSetting = (typeof MIRRORED_CLAUDE_SETTINGS)[number];
export type ClaudePermissionSettings = Partial<Record<MirroredClaudeSetting, unknown>>;

export function claudeSettingsFile(): string {
  return path.join(os.homedir(), '.agent-sessions', 'claude-settings.json');
}

export async function readClaudeSettings(file: string): Promise<ClaudePermissionSettings | undefined> {
  try {
    const raw: unknown = JSON.parse(await fsp.readFile(file, 'utf8'));
    if (!raw || typeof raw !== 'object') return undefined;
    const out: ClaudePermissionSettings = {};
    for (const key of MIRRORED_CLAUDE_SETTINGS) if (key in raw) out[key] = (raw as Record<string, unknown>)[key];
    return out;
  } catch {
    // Never published (no desktop window has run this version yet), or mid-write.
    return undefined;
  }
}

export async function writeClaudeSettings(file: string, settings: ClaudePermissionSettings): Promise<void> {
  const text = JSON.stringify(settings, null, 2) + '\n';
  try {
    if ((await fsp.readFile(file, 'utf8')) === text) return;
  } catch {
    // Not there yet.
  }
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fsp.writeFile(tmp, text);
  await fsp.rename(tmp, file);
}

/** Calls `onChange` whenever a desktop window republishes the settings. */
export function watchClaudeSettings(file: string, onChange: () => void): { dispose(): void } {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  let timer: NodeJS.Timeout | undefined;
  // The directory, not the file: a rename replaces the file, which ends a watch on it.
  const watcher = fs.watch(dir, { persistent: false }, (_event, name) => {
    if (name !== path.basename(file)) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(onChange, 100);
  });
  return {
    dispose: () => {
      if (timer) clearTimeout(timer);
      watcher.close();
    },
  };
}
