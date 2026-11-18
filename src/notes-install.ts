import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * The opt-in agent side of session notes (notes.ts) is the `agent-sessions` plugin in this repository's `plugin/`:
 * hooks that tell each session when to record a task or a question and remind it of what is open, and the task, ask,
 * ask-user and done skills. It is installed into Claude Code and Codex through their own plugin commands, from a copy of
 * the marketplace this extension ships, kept at a fixed path so an extension update does not move it. The plugin's
 * text names the `agent-sessions` command at its fixed path, which every activation writes.
 */
export function notesCommandPath(): string {
  return path.join(os.homedir(), '.agent-sessions', 'bin', 'agent-sessions');
}

export function marketplacePath(): string {
  return path.join(os.homedir(), '.agent-sessions', 'marketplace');
}

export const PLUGIN = 'agent-sessions@agent-sessions';
const MARKETPLACE = 'agent-sessions';
/** What a marketplace is made of: each tool's manifest, and the plugin both name. */
const MARKETPLACE_PARTS = ['.claude-plugin', '.agents', 'plugin'];

export type PluginTool = 'claude' | 'codex';
/** Runs one of the tools' own commands; rejects with what it printed when it fails or is not installed. */
export type RunTool = (tool: PluginTool, args: string[]) => Promise<string>;

export interface NotesInstallPaths {
  /** Claude Code's home (`~/.claude`) and Codex's (`~/.codex`). */
  claudeHome: string;
  codexHome: string;
  /** The marketplace this extension ships, and the fixed place its copy is installed from. */
  shipped: string;
  marketplace: string;
}

/** The tools' commands from this process, which may have a shorter PATH than a login shell: their usual folders are added. */
export const runTool: RunTool = (tool, args) =>
  new Promise((resolve, reject) => {
    const extra = ['.local/bin', '.npm-global/bin', '.bun/bin'].map((dir) => path.join(os.homedir(), dir));
    const env = { ...process.env, PATH: [process.env.PATH, ...extra, '/usr/local/bin', '/opt/homebrew/bin'].filter(Boolean).join(path.delimiter) };
    execFile(tool, args, { env, timeout: 60_000 }, (err, stdout, stderr) => {
      if (err) reject(new Error(`${tool} ${args.join(' ')}: ${(stderr || stdout || err.message).trim()}`));
      else resolve(stdout);
    });
  });

const pluginVersion = (marketplace: string): string | undefined => {
  try {
    return (JSON.parse(fs.readFileSync(path.join(marketplace, 'plugin', '.claude-plugin', 'plugin.json'), 'utf8')) as { version?: string }).version;
  } catch {
    return undefined;
  }
};

/** Whether the plugin was installed from here: its marketplace copy exists. */
export function notesInstalled(p: NotesInstallPaths): boolean {
  return pluginVersion(p.marketplace) !== undefined;
}

/** Whether the installed copy is another version than the one this extension ships. */
export function notesOutdated(p: NotesInstallPaths): boolean {
  return notesInstalled(p) && pluginVersion(p.marketplace) !== pluginVersion(p.shipped);
}

/**
 * Copies the marketplace into place and installs the plugin in each tool, replacing an earlier copy. Returns the
 * tools it could not be installed in and why (a tool that is not installed here, most often). What versions before
 * the plugin wrote into the tools' instruction files and prompt folders is taken back.
 */
export async function installNotes(p: NotesInstallPaths, run: RunTool = runTool): Promise<{ failed: { tool: PluginTool; reason: string }[] }> {
  fs.rmSync(p.marketplace, { recursive: true, force: true });
  for (const part of MARKETPLACE_PARTS) fs.cpSync(path.join(p.shipped, part), path.join(p.marketplace, part), { recursive: true });
  removeLegacyNotes(p);
  const steps: Record<PluginTool, string[][]> = {
    // Both are safe to repeat. Claude Code reads the plugin from its folder; Codex copies it, a new version beside the old.
    claude: [['plugin', 'marketplace', 'add', p.marketplace], ['plugin', 'install', PLUGIN]],
    codex: [['plugin', 'marketplace', 'add', p.marketplace], ['plugin', 'add', PLUGIN]],
  };
  const failed: { tool: PluginTool; reason: string }[] = [];
  for (const tool of ['claude', 'codex'] as const) {
    try {
      for (const args of steps[tool]) await run(tool, args);
    } catch (err) {
      failed.push({ tool, reason: err instanceof Error ? err.message : String(err) });
    }
  }
  return { failed };
}

/** Takes the plugin out of both tools. Recorded tasks and questions stay. */
export async function uninstallNotes(p: NotesInstallPaths, run: RunTool = runTool): Promise<void> {
  const steps: Record<PluginTool, string[][]> = {
    claude: [['plugin', 'uninstall', PLUGIN], ['plugin', 'marketplace', 'remove', MARKETPLACE]],
    codex: [['plugin', 'remove', PLUGIN], ['plugin', 'marketplace', 'remove', MARKETPLACE]],
  };
  for (const tool of ['claude', 'codex'] as const) {
    // Each step on its own: a plugin already gone must not keep its marketplace.
    for (const args of steps[tool]) await run(tool, args).catch(() => undefined);
  }
  fs.rmSync(p.marketplace, { recursive: true, force: true });
  removeLegacyNotes(p);
}

// Before the plugin, the same instructions were a marked block in each tool's global instructions and prompt files
// in their command folders. Only what carries our marker is removed.
const BLOCK_START = '<!-- agent-sessions:notes:start (written by the Agent Sessions extension; edits here are replaced) -->';
const BLOCK_END = '<!-- agent-sessions:notes:end -->';
const PROMPT_MARK = '<!-- agent-sessions:notes -->';


function read(file: string): string | undefined {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return undefined;
  }
}

/** `text` without our block, and whether it had one. */
function withoutBlock(text: string): { rest: string; had: boolean } {
  const start = text.indexOf(BLOCK_START);
  const end = text.indexOf(BLOCK_END);
  if (start < 0 || end < start) return { rest: text, had: false };
  const before = text.slice(0, start).trimEnd();
  const after = text.slice(end + BLOCK_END.length).trim();
  return { rest: [before, after].filter(Boolean).join('\n\n') + (before || after ? '\n' : ''), had: true };
}

function removeLegacyNotes(p: NotesInstallPaths): void {
  for (const file of [path.join(p.claudeHome, 'CLAUDE.md'), path.join(p.codexHome, 'AGENTS.md')]) {
    const text = read(file);
    if (text === undefined) continue;
    const { rest, had } = withoutBlock(text);
    if (!had) continue;
    if (rest.trim()) fs.writeFileSync(file, rest);
    else fs.rmSync(file, { force: true });
  }
  for (const name of ['question', 'task']) {
    for (const file of [path.join(p.claudeHome, 'commands', `${name}.md`), path.join(p.codexHome, 'prompts', `${name}.md`)]) {
      if (read(file)?.includes(PROMPT_MARK)) fs.rmSync(file, { force: true });
    }
  }
}
