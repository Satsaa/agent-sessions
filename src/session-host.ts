import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { CLIENT_LABEL_ENV, IDLE_STOP_ENV, PROTOCOL, lineReader, socketPath, type HostMessage, type HostRequest, type HostedSession } from './host/protocol.js';

const REQUEST_TIMEOUT_MS = 2000;

/**
 * A tool whose sessions Agent Sessions keeps running: the setting that names the executable its extension starts, and
 * what the launcher runs when our wrapper or Node has since gone (a stale launcher costs sessions their keep-alive,
 * never the panel itself).
 */
interface KeptTool {
  extensionId: string;
  section: string;
  setting: string;
  wrapper: string;
  fallback: string;
}

const KEPT_TOOLS: readonly KeptTool[] = [
  // Claude Code passes its own binary as the first argument.
  { extensionId: 'anthropic.claude-code', section: 'claudeCode', setting: 'claudeProcessWrapper', wrapper: 'claude-wrapper', fallback: 'exec "$@"' },
  { extensionId: 'openai.chatgpt', section: 'chatgpt', setting: 'cliExecutable', wrapper: 'codex-wrapper', fallback: 'exec codex "$@"' },
];

/**
 * The executable a tool's setting names. It is a fixed path so the setting survives extension and VS Code updates,
 * rewritten on every activation with this extension's wrapper and this server's Node.
 */
function launcherPath(tool: Pick<KeptTool, 'wrapper'>): string {
  return path.join(os.homedir(), '.agent-sessions', 'bin', tool.wrapper);
}

/**
 * Writes a shell launcher at a fixed path that runs one of this extension's Node programs with this server's Node,
 * or `fallback` when either has since gone. Rewritten on every activation: both paths change with an update.
 */
export function writeNodeLauncher(file: string, program: string, comment: string, fallback: string): void {
  const quote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
  const script = [
    '#!/bin/sh',
    `# Written by Agent Sessions: ${comment}`,
    `node=${quote(process.execPath)}`,
    `wrapper=${quote(program)}`,
    '[ -x "$node" ] || node=$(command -v node)',
    'if [ -n "$node" ] && [ -f "$wrapper" ]; then ELECTRON_RUN_AS_NODE=1 exec "$node" "$wrapper" "$@"; fi',
    fallback,
    '',
  ].join('\n');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, script, { mode: 0o755 });
  fs.renameSync(tmp, file);
}

function writeLauncher(tool: KeptTool, extensionPath: string): void {
  writeNodeLauncher(launcherPath(tool), path.join(extensionPath, 'dist', `${tool.wrapper}.mjs`), "keeps this tool's panel sessions running when their window closes.", tool.fallback);
}

/**
 * Points each installed tool at its launcher while `agentSessions.keepSessionsRunning` is on, and takes it back when
 * it goes off. An executable someone else configured is left alone and reported.
 */
export async function applyKeepSessionsRunning(enabled: boolean, extensionPath: string, output: vscode.OutputChannel): Promise<void> {
  // The panels start their wrappers from this extension host, so they inherit the name; a server that knows better
  // (the phone view) sets it in the environment first.
  if (enabled) process.env[CLIENT_LABEL_ENV] ||= vscode.env.uiKind === vscode.UIKind.Web ? 'a VS Code browser tab' : 'the desktop VS Code';
  for (const tool of KEPT_TOOLS) {
    const config = vscode.workspace.getConfiguration(tool.section);
    const current = config.get<string | null>(tool.setting) || undefined;
    const ours = launcherPath(tool);
    const name = `${tool.section}.${tool.setting}`;
    if (!enabled || !vscode.extensions.getExtension(tool.extensionId)) {
      if (current === ours) await config.update(tool.setting, undefined, vscode.ConfigurationTarget.Global);
      continue;
    }
    writeLauncher(tool, extensionPath);
    if (current === ours) continue;
    if (current) {
      output.appendLine(`keepSessionsRunning: ${name} is already ${current}; leaving it`);
      void vscode.window.showWarningMessage(`Agent Sessions cannot keep these sessions running: ${name} is already ${current}.`);
      continue;
    }
    await config.update(tool.setting, ours, vscode.ConfigurationTarget.Global);
    output.appendLine(`keepSessionsRunning: ${name} now starts sessions through ${ours}; reload windows opened before this`);
  }
}

/**
 * Hands `agentSessions.idleStopMinutes` to the panels this extension host starts from now on: their wrappers inherit
 * it and tell the session host. A session already open keeps what its window said when it attached.
 */
export function publishIdleStop(minutes: number): void {
  process.env[IDLE_STOP_ENV] = String(minutes);
}

function ask(request: HostRequest): Promise<HostMessage | undefined> {
  return new Promise((resolve) => {
    const socket = net.connect(socketPath());
    const done = (message: HostMessage | undefined) => {
      clearTimeout(timer);
      socket.destroy();
      resolve(message);
    };
    const timer = setTimeout(() => done(undefined), REQUEST_TIMEOUT_MS);
    socket.once('connect', () => socket.write(`${JSON.stringify(request)}\n`));
    socket.on('data', lineReader((line) => {
      try {
        done(JSON.parse(line) as HostMessage);
      } catch {
        done(undefined);
      }
    }));
    socket.once('error', () => done(undefined));
  });
}

/** What the host runs now; empty when it is not running. */
export async function hostedSessions(): Promise<HostedSession[]> {
  const reply = await ask({ op: 'status', protocol: PROTOCOL });
  return reply && 'ev' in reply && reply.ev === 'status' ? reply.sessions : [];
}

/**
 * Before this window opens a Claude session another window holds, asks whether to move it here; the host refuses
 * the open otherwise. False when the person keeps it where it is.
 */
export async function moveHereIfHeldElsewhere(sessionId: string, title: string): Promise<boolean> {
  const hosted = (await hostedSessions()).find((s) => s.sessionId === sessionId);
  const holder = hosted?.holder;
  if (!hosted || !holder || holder.ownerPid === process.pid) return true;
  const move = 'Move Here';
  const choice = await vscode.window.showWarningMessage(
    `“${title}” is running in ${holder.label}.`,
    {
      modal: true,
      detail:
        hosted.state === 'idle'
          ? 'Moving it here closes it there.'
          : 'Moving it here keeps the current turn running; the other window loses the session.',
    },
    move,
  );
  if (choice !== move) return false;
  await ask({ op: 'allow-takeover', protocol: PROTOCOL, sessionId });
  return true;
}
