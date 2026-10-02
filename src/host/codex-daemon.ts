import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import WebSocket from 'ws';

/**
 * Codex keeps sessions running on its own: `codex app-server daemon` serves threads to any number of clients over a
 * WebSocket on a Unix socket, a turn carries on when its client goes, and resuming a running thread rejoins it. The
 * VS Code extension instead starts a private `codex app-server` per window on stdio, which ends with the window; the
 * Codex wrapper (codex-wrapper.ts) connects that stdio to the daemon.
 */
export function codexHome(): string {
  return process.env['CODEX_HOME'] || path.join(os.homedir(), '.codex');
}

export function daemonSocketPath(home = codexHome()): string {
  return path.join(home, 'app-server-control', 'app-server-control.sock');
}

/** The daemon's app-server process, which holds the writer lock of every thread it has loaded. */
export function daemonPid(home = codexHome()): number | undefined {
  try {
    const pid = (JSON.parse(fs.readFileSync(path.join(home, 'app-server-daemon', 'app-server.pid'), 'utf8')) as { pid?: unknown }).pid;
    return typeof pid === 'number' ? pid : undefined;
  } catch {
    return undefined;
  }
}

export function connectDaemon(home = codexHome(), timeoutMs = 3000): Promise<WebSocket | undefined> {
  const file = daemonSocketPath(home);
  if (!fs.existsSync(file)) return Promise.resolve(undefined);
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws+unix://${file}:/`, { handshakeTimeout: timeoutMs });
    ws.once('open', () => resolve(ws));
    ws.once('error', () => resolve(undefined));
  });
}

/** Starts the daemon with `codex` (Codex's own start, lock and all) unless it already answers; whether it answers after. */
export async function ensureDaemon(codex: string, home = codexHome(), timeoutMs = 15_000): Promise<boolean> {
  const existing = await connectDaemon(home);
  if (existing) {
    existing.close();
    return true;
  }
  await new Promise<void>((resolve) => {
    const child = spawn(codex, ['app-server', 'daemon', 'start'], { stdio: 'ignore', env: { ...process.env, CODEX_HOME: home } });
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.once('error', () => resolve());
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });
  const started = await connectDaemon(home);
  started?.close();
  return !!started;
}

interface Reply {
  id?: number;
  result?: unknown;
  error?: { message?: string };
}

/**
 * A JSON-RPC client on one daemon connection, for the few calls Agent Sessions makes itself. `clientName` is how
 * Codex records the threads it starts: `codex_vscode` makes one a VS Code thread, like the panel's own.
 */
export async function daemonClient(home = codexHome(), clientName = 'agent_sessions') {
  const ws = await connectDaemon(home);
  if (!ws) return undefined;
  let next = 0;
  const pending = new Map<number, (reply: Reply) => void>();
  ws.on('message', (data) => {
    let reply: Reply;
    try {
      reply = JSON.parse(data.toString()) as Reply;
    } catch {
      return;
    }
    if (typeof reply.id === 'number' && pending.has(reply.id) && !('method' in reply)) {
      pending.get(reply.id)!(reply);
      pending.delete(reply.id);
    }
  });
  ws.on('close', () => {
    for (const settle of pending.values()) settle({ error: { message: 'the Codex daemon closed the connection' } });
    pending.clear();
  });
  const request = <T>(method: string, params: unknown): Promise<T> =>
    new Promise((resolve, reject) => {
      const id = next++;
      pending.set(id, (reply) => (reply.error ? reject(new Error(reply.error.message ?? `${method} failed`)) : resolve(reply.result as T)));
      ws.send(JSON.stringify({ id, method, params }));
    });
  await request('initialize', { clientInfo: { name: clientName, title: 'Agent Sessions', version: '1' }, capabilities: null });
  ws.send(JSON.stringify({ method: 'initialized' }));
  return { request, close: () => ws.close() };
}

/**
 * Stops the turn a daemon thread is running, if any; the daemon unloads the thread by itself once no client is
 * subscribed. False when the daemon cannot be reached.
 */
export async function interruptDaemonThread(threadId: string, home = codexHome()): Promise<boolean> {
  const client = await daemonClient(home);
  if (!client) return false;
  try {
    const turns = await client.request<{ data: { id: string; status: string }[] }>('thread/turns/list', { threadId, sortDirection: 'desc', limit: 1 });
    const running = turns.data.find((t) => t.status === 'inProgress');
    if (running) await client.request('turn/interrupt', { threadId, turnId: running.id });
    return true;
  } finally {
    client.close();
  }
}

/**
 * Starts a thread in `cwd` whose first turn is `text`, with the settings of Codex's config like any new thread, and
 * returns its id; the turn carries on after this connection closes. Undefined when the daemon cannot be reached.
 * Returns once the thread has its preview, the message it is titled by — about two seconds after the turn starts —
 * or after `titledWithinMs`: a panel opened before then reads the thread untitled and stays so.
 */
export async function startDaemonThread(cwd: string | undefined, text: string, home = codexHome(), titledWithinMs = 15_000, pollMs = 250): Promise<string | undefined> {
  const client = await daemonClient(home, 'codex_vscode');
  if (!client) return undefined;
  try {
    const { thread } = await client.request<{ thread: { id: string } }>('thread/start', cwd ? { cwd } : {});
    await client.request('turn/start', { threadId: thread.id, input: [{ type: 'text', text, text_elements: [] }] });
    for (const until = Date.now() + titledWithinMs; Date.now() < until; await new Promise((r) => setTimeout(r, pollMs))) {
      const read = await client.request<{ thread: { preview: string } }>('thread/read', { threadId: thread.id, includeTurns: false });
      if (read.thread.preview) break;
    }
    return thread.id;
  } finally {
    client.close();
  }
}
