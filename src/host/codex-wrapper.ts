import { spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type WebSocket from 'ws';
import { connectDaemon } from './codex-daemon.js';
import { lineReader } from './protocol.js';

/**
 * Started by the Codex extension in place of its bundled `codex` (`chatgpt.cliExecutable`). The window's
 * `codex app-server` on stdio becomes a connection to Codex's own app-server daemon, so its turns outlive the window
 * and every window sees the same running thread. Anything else (the LSP bridge, a one-off command), and every case
 * where the daemon cannot be reached, runs the bundled binary directly so the panel never breaks because of us.
 */
const argv = process.argv.slice(2);
const OPTIONS_WITH_VALUE = new Set(['-c', '--config', '--enable', '--disable', '--listen', '--code-mode-host', '--ws-auth']);
const START_TIMEOUT_MS = 30_000;

/**
 * The extension appends its own `bin/<platform>` folder to PATH before starting us; that `codex` is the version the
 * panel was built against. Any other `codex` on PATH is the fallback.
 */
function realCodex(): string | undefined {
  const candidates = (process.env['PATH'] ?? '')
    .split(path.delimiter)
    .filter(Boolean)
    .map((dir) => path.join(dir, 'codex'))
    .filter((file) => {
      try {
        fs.accessSync(file, fs.constants.X_OK);
        return true;
      } catch {
        return false;
      }
    });
  return candidates.find((file) => file.includes(`${path.sep}openai.chatgpt-`)) ?? candidates[0];
}

/** `codex [options] app-server [options]` with no subcommand, serving stdio: the panel's own app-server. */
function isPanelAppServer(args: readonly string[]): boolean {
  const positional: string[] = [];
  let listen: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (OPTIONS_WITH_VALUE.has(a)) {
      if (a === '--listen') listen = args[i + 1];
      i++;
    } else if (a.startsWith('--listen=')) listen = a.slice('--listen='.length);
    else if (!a.startsWith('-')) positional.push(a);
  }
  return positional.length === 1 && positional[0] === 'app-server' && (listen === undefined || listen === 'stdio://');
}

function runDirect(real: string | undefined): void {
  if (!real) {
    process.stderr.write('Agent Sessions: no codex executable found on PATH.\n');
    process.exit(127);
  }
  const child = spawn(real, argv, { stdio: 'inherit' });
  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) process.on(signal, () => child.kill(signal));
  child.on('exit', (code, signal) => process.exit(code ?? (signal ? 128 : 1)));
}

async function reachDaemon(real: string): Promise<WebSocket | undefined> {
  const existing = await connectDaemon();
  if (existing) return existing;
  // `daemon start` returns once the daemon answers, or fails; either way it is Codex's own start, lock and all.
  spawnSync(real, ['app-server', 'daemon', 'start'], { stdio: 'ignore', timeout: START_TIMEOUT_MS });
  return connectDaemon();
}

async function main(): Promise<void> {
  const real = realCodex();
  if (!real || !isPanelAppServer(argv)) return runDirect(real);
  const ws = await reachDaemon(real);
  if (!ws) {
    process.stderr.write('Agent Sessions: Codex’s app-server daemon did not start; this window’s sessions end with it.\n');
    return runDirect(real);
  }
  let finished = false;
  const finish = (code: number, message?: string) => {
    if (finished) return;
    finished = true;
    if (message) process.stderr.write(`${message}\n`);
    ws.close();
    process.stdout.write('', () => process.exit(code));
  };
  process.stdin.on('data', lineReader((line) => ws.send(line)));
  process.stdin.on('end', () => finish(0));
  process.stdout.on('error', () => finish(0));
  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) process.on(signal, () => finish(0));
  ws.on('message', (data) => process.stdout.write(`${data.toString()}\n`));
  // The daemon restarting (an update, say) drops every client; the extension reports it and starts a new wrapper.
  ws.on('close', () => finish(1, 'Agent Sessions: Codex’s app-server daemon closed the connection.'));
  ws.on('error', () => {});
}

void main();
