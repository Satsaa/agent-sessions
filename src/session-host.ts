import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { CLIENT_LABEL_ENV, PROTOCOL, lineReader, socketPath, type HostMessage, type HostRequest, type HostedSession } from './host/protocol.js';

const CLAUDE_SECTION = 'claudeCode';
const WRAPPER_SETTING = 'claudeProcessWrapper';
const REQUEST_TIMEOUT_MS = 2000;

/**
 * The executable `claudeCode.claudeProcessWrapper` names. It is a fixed path so the setting survives extension and
 * VS Code updates, rewritten on every activation with this extension's wrapper and this server's Node. If either has
 * since been removed it runs `claude` directly: a stale launcher costs a session its host, never the panel itself.
 */
export function launcherPath(): string {
  return path.join(os.homedir(), '.agent-sessions', 'bin', 'claude-wrapper');
}

function writeLauncher(extensionPath: string): void {
  const quote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
  const script = [
    '#!/bin/sh',
    '# Written by Agent Sessions: runs Claude Code panel sessions under its session host.',
    `node=${quote(process.execPath)}`,
    `wrapper=${quote(path.join(extensionPath, 'dist', 'claude-wrapper.mjs'))}`,
    '[ -x "$node" ] || node=$(command -v node)',
    'if [ -n "$node" ] && [ -f "$wrapper" ]; then ELECTRON_RUN_AS_NODE=1 exec "$node" "$wrapper" "$@"; fi',
    'exec "$@"',
    '',
  ].join('\n');
  const file = launcherPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, script, { mode: 0o755 });
  fs.renameSync(tmp, file);
}

/**
 * Points Claude Code at the launcher while `agentSessions.keepSessionsRunning` is on, and takes it back when it goes
 * off. A wrapper someone else configured is left alone and reported.
 */
export async function applyKeepSessionsRunning(enabled: boolean, extensionPath: string, output: vscode.OutputChannel): Promise<void> {
  const claude = vscode.workspace.getConfiguration(CLAUDE_SECTION);
  const current = claude.get<string>(WRAPPER_SETTING) || undefined;
  const ours = launcherPath();
  if (!enabled) {
    if (current === ours) await claude.update(WRAPPER_SETTING, undefined, vscode.ConfigurationTarget.Global);
    return;
  }
  writeLauncher(extensionPath);
  // The Claude panel starts the wrapper from this extension host, so it inherits the name; a server that knows
  // better (the phone view) sets it in the environment first.
  process.env[CLIENT_LABEL_ENV] ||= vscode.env.uiKind === vscode.UIKind.Web ? 'a VS Code browser tab' : 'the desktop VS Code';
  if (current === ours) return;
  if (current) {
    output.appendLine(`keepSessionsRunning: claudeCode.claudeProcessWrapper is already ${current}; leaving it`);
    void vscode.window.showWarningMessage(
      `Agent Sessions cannot keep Claude sessions running: Claude Code already runs through ${current}.`,
    );
    return;
  }
  await claude.update(WRAPPER_SETTING, ours, vscode.ConfigurationTarget.Global);
  output.appendLine(`keepSessionsRunning: Claude Code now starts sessions through ${ours}`);
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
