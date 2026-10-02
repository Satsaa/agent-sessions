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

const RECONNECT_TIMEOUT_MS = 60_000;
const RECONNECT_POLL_MS = 500;

interface RpcMessage {
  id?: number | string;
  method?: string;
  params?: { threadId?: unknown };
  result?: { thread?: { id?: unknown } };
}

function parse(line: string): RpcMessage | undefined {
  try {
    const m: unknown = JSON.parse(line);
    return m && typeof m === 'object' ? (m as RpcMessage) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * What a new daemon connection must be told for the panel to carry on as if nothing happened: the panel's own
 * `initialize`, and a `thread/resume` for every thread it is subscribed to, since the daemon's subscriptions are per
 * connection. The Codex extension never starts a second app-server after its first exits — every panel shows "Codex
 * process is not available" until the window reloads — so the wrapper outlives a daemon restart (an update, say)
 * rather than exiting with it.
 */
class PanelSession {
  initialize: string | undefined;
  initialized = false;
  /** Thread id → the params to resume it with: the panel's own `thread/resume`, or just the id. */
  readonly threads = new Map<string, unknown>();
  /** Panel requests sent to the daemon and not yet answered, by id. */
  readonly inFlight = new Map<number | string, string | undefined>();

  fromPanel(line: string): void {
    const m = parse(line);
    if (!m?.method) return;
    if (m.method === 'initialize') this.initialize = line;
    else if (m.method === 'initialized') this.initialized = true;
    if (m.id !== undefined) this.inFlight.set(m.id, m.method);
    const threadId = typeof m.params?.threadId === 'string' ? m.params.threadId : undefined;
    if (!threadId) return;
    if (m.method === 'thread/resume') this.threads.set(threadId, m.params);
    else if (m.method === 'thread/unsubscribe' || m.method === 'thread/archive' || m.method === 'thread/delete') this.threads.delete(threadId);
  }

  fromDaemon(line: string): void {
    const m = parse(line);
    if (!m || m.method !== undefined || m.id === undefined || !this.inFlight.has(m.id)) return;
    const method = this.inFlight.get(m.id);
    this.inFlight.delete(m.id);
    const threadId = m.result?.thread?.id;
    if (typeof threadId === 'string' && (method === 'thread/start' || method === 'thread/fork' || method === 'thread/resume') && !this.threads.has(threadId)) {
      this.threads.set(threadId, { threadId });
    }
  }

  /** Errors for the requests the old connection took with it, so the panel does not wait on them forever. */
  dropped(): string[] {
    const lines = [...this.inFlight.keys()].map((id) => JSON.stringify({ id, error: { code: -32603, message: 'Codex’s app-server daemon restarted; try again.' } }));
    this.inFlight.clear();
    return lines;
  }
}

async function main(): Promise<void> {
  const real = realCodex();
  if (!real || !isPanelAppServer(argv)) return runDirect(real);
  const first = await reachDaemon(real);
  if (!first) {
    process.stderr.write('Agent Sessions: Codex’s app-server daemon did not start; this window’s sessions end with it.\n');
    return runDirect(real);
  }
  let ws: WebSocket = first;
  const session = new PanelSession();
  /** Panel lines held while reconnecting, sent once the new connection is set up. */
  let held: string[] | undefined;
  let finished = false;
  const finish = (code: number, message?: string) => {
    if (finished) return;
    finished = true;
    if (message) process.stderr.write(`${message}\n`);
    ws.close();
    process.stdout.write('', () => process.exit(code));
  };

  const replayId = (n: number) => `agent-sessions-replay-${n}`;
  /** Sends the setup a new connection needs and waits for its answers, which the panel already had once. */
  const replay = (next: WebSocket) =>
    new Promise<void>((resolve) => {
      const lines: string[] = [];
      const init = session.initialize ? parse(session.initialize) : undefined;
      if (init) lines.push(JSON.stringify({ ...init, id: replayId(lines.length) }));
      if (session.initialized) lines.push(JSON.stringify({ method: 'initialized' }));
      for (const params of session.threads.values()) lines.push(JSON.stringify({ id: replayId(lines.length), method: 'thread/resume', params }));
      const waiting = new Set(lines.map((l) => parse(l)?.id).filter((id) => id !== undefined));
      if (waiting.size === 0) return resolve();
      const timer = setTimeout(done, START_TIMEOUT_MS);
      function done() {
        clearTimeout(timer);
        next.off('message', onReply);
        resolve();
      }
      function onReply(data: WebSocket.RawData) {
        const id = parse(data.toString())?.id;
        if (id !== undefined && waiting.delete(id) && waiting.size === 0) done();
      }
      next.on('message', onReply);
      // `initialized` must follow `initialize`'s answer; the resumes may go together after it.
      const [head, ...rest] = lines;
      const sendRest = () => rest.forEach((l) => next.send(l));
      if (init && session.initialized) {
        const afterInit = (data: WebSocket.RawData) => {
          if (parse(data.toString())?.id !== replayId(0)) return;
          next.off('message', afterInit);
          sendRest();
        };
        next.on('message', afterInit);
        next.send(head!);
      } else lines.forEach((l) => next.send(l));
    });

  const attach = (socket: WebSocket) => {
    socket.on('message', (data) => {
      const line = data.toString();
      const id = parse(line)?.id;
      if (typeof id === 'string' && id.startsWith('agent-sessions-replay-')) return;
      session.fromDaemon(line);
      process.stdout.write(`${line}\n`);
    });
    socket.on('error', () => {});
    socket.on('close', () => void reconnect(socket));
  };

  const reconnect = async (closed: WebSocket) => {
    if (finished || closed !== ws) return;
    held = [];
    for (const line of session.dropped()) process.stdout.write(`${line}\n`);
    process.stderr.write('Agent Sessions: Codex’s app-server daemon closed the connection; reconnecting.\n');
    for (const until = Date.now() + RECONNECT_TIMEOUT_MS; !finished && Date.now() < until; await new Promise((r) => setTimeout(r, RECONNECT_POLL_MS))) {
      const next = await reachDaemon(real);
      if (!next) continue;
      await replay(next);
      if (finished) return void next.close();
      ws = next;
      attach(next);
      const lines = held;
      held = undefined;
      for (const line of lines) send(line);
      return;
    }
    finish(1, 'Agent Sessions: Codex’s app-server daemon closed the connection and did not come back.');
  };

  const send = (line: string) => {
    if (held) return void held.push(line);
    session.fromPanel(line);
    ws.send(line);
  };

  attach(ws);
  process.stdin.on('data', lineReader(send));
  process.stdin.on('end', () => finish(0));
  process.stdout.on('error', () => finish(0));
  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) process.on(signal, () => finish(0));
}

void main();
