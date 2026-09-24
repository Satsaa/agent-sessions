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

interface Reply {
  id?: number;
  result?: unknown;
  error?: { message?: string };
}

/** A JSON-RPC client on one daemon connection, for the few calls Agent Sessions makes itself. */
export async function daemonClient(home = codexHome()) {
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
  await request('initialize', { clientInfo: { name: 'agent_sessions', title: 'Agent Sessions', version: '1' }, capabilities: null });
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
