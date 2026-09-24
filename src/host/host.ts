import { spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as net from 'node:net';
import {
  PROTOCOL,
  lineReader,
  resumedSessionId,
  type AttachRequest,
  type ClientIdentity,
  type HostMessage,
  type HostRequest,
  type HostedSession,
  type SessionState,
} from './protocol.js';

type Json = Record<string, unknown>;

export interface HostOptions {
  socketPath: string;
  /** How long a process nobody is connected to may sit idle before it is stopped; its transcript resumes it. */
  idleStopMs: number;
  /** How long the host runs with no processes and no connections before it exits. */
  emptyExitMs: number;
  /** How long an `allow-takeover` holds for the next attach to that session. */
  takeoverMs: number;
  log: (line: string) => void;
}

interface Client {
  socket: net.Socket;
  identity: ClientIdentity;
  /** Ids of the `initialize` requests this panel sent: its answer is when the panel can take replayed prompts. */
  initializeIds: Set<string>;
}

/** Requests that wait for a person; they outlive a window and are asked again in the next one. */
const ASKS_A_PERSON = new Set(['can_use_tool', 'elicitation']);
/** Output that means a turn is running, including one that starts on its own after a background task ends. */
const TURN_OUTPUT = new Set(['assistant', 'stream_event', 'user', 'tool_progress']);
const DETACHED = 'No VS Code window is connected to this session';

class Worker {
  sessionId: string | undefined;
  client: Client | undefined;
  busy = false;
  /** Questions for a person, by request id, as the process sent them. */
  readonly pending = new Map<string, string>();
  /** Everything else sent to the window and not yet answered: the host answers it if the window goes. */
  readonly forwarded = new Map<string, { subtype: unknown; request: unknown }>();
  stopTimer: ReturnType<typeof setTimeout> | undefined;
  readonly exited: Promise<void>;

  constructor(readonly proc: ChildProcess) {
    this.exited = new Promise((resolve) => proc.once('exit', () => resolve()));
  }

  get state(): SessionState {
    if (this.pending.size > 0) return 'waiting';
    return this.busy ? 'busy' : 'idle';
  }

  write(line: string): void {
    if (this.proc.stdin?.writable) this.proc.stdin.write(`${line}\n`);
  }
}

function send(socket: net.Socket, message: HostMessage): void {
  if (!socket.destroyed) socket.write(`${JSON.stringify(message)}\n`);
}

function parse(line: string): Json | undefined {
  try {
    const value: unknown = JSON.parse(line);
    return value && typeof value === 'object' ? (value as Json) : undefined;
  } catch {
    return undefined;
  }
}

function field(value: unknown, key: string): unknown {
  return value && typeof value === 'object' ? (value as Json)[key] : undefined;
}

/**
 * One process per conversation, whichever window asks for it. A window opening a session another window holds is
 * refused unless the person moved it (`allow-takeover`, which Agent Sessions sends after asking), so a phone
 * restoring its tabs never steals a session from the desktop, and neither side ever starts a clone.
 *
 * A reconnect joins the running process only while a turn runs or waits on a person; an idle process is restarted
 * from its transcript with the new panel's command line, so the model, permission mode, hooks and tools the panel
 * asks for always apply.
 */
export class SessionHost {
  private readonly workers = new Set<Worker>();
  private readonly bySession = new Map<string, Worker>();
  private readonly takeovers = new Map<string, number>();
  private readonly locks = new Map<string, Promise<void>>();
  private readonly server: net.Server;
  private connections = 0;
  private emptyTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly options: HostOptions) {
    this.server = net.createServer((socket) => this.accept(socket));
  }

  /** Resolves false when another host already answers on the socket. */
  async listen(): Promise<boolean> {
    const { socketPath } = this.options;
    const tryListen = () =>
      new Promise<NodeJS.ErrnoException | undefined>((resolve) => {
        this.server.once('error', resolve);
        this.server.listen(socketPath, () => {
          this.server.off('error', resolve);
          resolve(undefined);
        });
      });
    let error = await tryListen();
    if (error?.code === 'EADDRINUSE') {
      if (await answers(socketPath)) return false;
      fs.rmSync(socketPath, { force: true });
      error = await tryListen();
    }
    if (error) throw error;
    fs.chmodSync(socketPath, 0o600);
    this.armEmptyExit();
    return true;
  }

  close(): Promise<void> {
    if (this.emptyTimer) clearTimeout(this.emptyTimer);
    for (const w of this.workers) w.proc.kill('SIGTERM');
    return new Promise((resolve) => this.server.close(() => resolve()));
  }

  sessions(): HostedSession[] {
    return [...this.workers].map((w) => ({
      sessionId: w.sessionId,
      pid: w.proc.pid,
      state: w.state,
      holder: w.client?.identity,
    }));
  }

  private accept(socket: net.Socket): void {
    this.connections++;
    this.disarmEmptyExit();
    let first = true;
    let onLine: (line: string) => void = () => {};
    socket.on('data', lineReader((line) => {
      if (!first) return onLine(line);
      first = false;
      const request = parse(line) as HostRequest | undefined;
      if (!request || request.protocol !== PROTOCOL) {
        send(socket, { ev: 'error', message: `The session host speaks protocol ${PROTOCOL}` });
        socket.end();
        return;
      }
      // Lines the panel sends while the attachment is being decided wait for it, in order.
      const queued: string[] = [];
      onLine = (l) => queued.push(l);
      void this.handle(socket, request, (deliver) => {
        onLine = deliver;
        for (const l of queued.splice(0)) deliver(l);
      });
    }));
    socket.on('error', () => {});
    socket.on('close', () => {
      this.connections--;
      this.armEmptyExit();
    });
  }

  private async handle(socket: net.Socket, request: HostRequest, relay: (deliver: (line: string) => void) => void) {
    switch (request.op) {
      case 'status':
        send(socket, { ev: 'status', sessions: this.sessions() });
        socket.end();
        return;
      case 'allow-takeover':
        this.takeovers.set(request.sessionId, Date.now() + this.options.takeoverMs);
        send(socket, { ev: 'ok' });
        socket.end();
        return;
      case 'stop': {
        const w = this.bySession.get(request.sessionId);
        if (w) await this.stop(w);
        send(socket, { ev: 'ok' });
        socket.end();
        return;
      }
      case 'attach':
        return this.attach(socket, request, relay);
    }
  }

  private async attach(socket: net.Socket, request: AttachRequest, relay: (deliver: (line: string) => void) => void) {
    const id = resumedSessionId(request.argv);
    const decide = async (): Promise<Worker | undefined> => {
      let w = id ? this.bySession.get(id) : undefined;
      if (w?.client) {
        const holder = w.client.identity;
        const sameWindow = holder.ownerPid === request.client.ownerPid && holder.label === request.client.label;
        const allowed = id !== undefined && (this.takeovers.get(id) ?? 0) > Date.now();
        if (!sameWindow && !allowed) {
          this.options.log(`${id}: refused ${request.client.label}; ${holder.label} holds it`);
          send(socket, {
            ev: 'refused',
            message: `This session is running in ${holder.label}. Open it from Agent Sessions to move it here.`,
          });
          socket.end();
          return undefined;
        }
        if (id) this.takeovers.delete(id);
        this.options.log(`${id}: moved from ${holder.label} to ${request.client.label}`);
        send(w.client.socket, { ev: 'moved', to: request.client.label });
        w.client.socket.end();
        w.client = undefined;
      }
      if (w && w.state === 'idle') {
        await this.stop(w);
        w = undefined;
      }
      if (w) this.options.log(`${id}: ${request.client.label} joined a ${w.state} turn`);
      return w ?? this.spawn(request, id);
    };
    const w = await this.serialize(id, decide);
    if (!w) return;
    if (socket.destroyed) return this.detach(w, undefined);
    const client: Client = { socket, identity: request.client, initializeIds: new Set() };
    w.client = client;
    this.cancelStop(w);
    socket.on('close', () => this.detach(w, client));
    send(socket, { ev: 'attached' });
    relay((line) => this.fromPanel(w, client, line));
  }

  /** Decisions about one conversation run one at a time, so two windows opening it at once cannot both spawn. */
  private async serialize<T>(id: string | undefined, run: () => Promise<T>): Promise<T> {
    if (!id) return run();
    const previous = this.locks.get(id) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => (release = resolve));
    const chained = previous.then(() => current);
    this.locks.set(id, chained);
    await previous;
    try {
      return await run();
    } finally {
      release();
      if (this.locks.get(id) === chained) this.locks.delete(id);
    }
  }

  private spawn(request: AttachRequest, id: string | undefined): Worker {
    const [command, ...args] = request.argv;
    const proc = spawn(command!, args, { cwd: request.cwd, env: request.env, stdio: ['pipe', 'pipe', 'pipe'] });
    const w = new Worker(proc);
    this.workers.add(w);
    if (id) this.register(w, id);
    this.options.log(`${id ?? 'new session'}: started pid ${proc.pid} for ${request.client.label}`);
    proc.stdout!.on('data', lineReader((line) => this.fromProcess(w, line)));
    proc.stderr!.on('data', (chunk: Buffer) => {
      if (w.client) send(w.client.socket, { e: chunk.toString() });
    });
    proc.stdin!.on('error', () => {});
    proc.on('error', (error) => {
      if (w.client) send(w.client.socket, { e: `${error.message}\n` });
    });
    proc.once('exit', (code, signal) => {
      this.options.log(`${w.sessionId ?? 'new session'}: pid ${proc.pid} exited (${signal ?? code})`);
      this.workers.delete(w);
      if (w.sessionId && this.bySession.get(w.sessionId) === w) this.bySession.delete(w.sessionId);
      this.cancelStop(w);
      if (w.client) {
        send(w.client.socket, { ev: 'exit', code, signal });
        w.client.socket.end();
      }
      this.armEmptyExit();
    });
    return w;
  }

  private register(w: Worker, id: string): void {
    if (w.sessionId === id) return;
    if (w.sessionId && this.bySession.get(w.sessionId) === w) this.bySession.delete(w.sessionId);
    w.sessionId = id;
    this.bySession.set(id, w);
  }

  private fromProcess(w: Worker, line: string): void {
    const msg = parse(line);
    const client = w.client;
    if (msg) {
      const type = msg['type'];
      if (type === 'system' && msg['subtype'] === 'init' && typeof msg['session_id'] === 'string') {
        this.register(w, msg['session_id']);
      }
      if (typeof type === 'string' && TURN_OUTPUT.has(type)) {
        w.busy = true;
        this.cancelStop(w);
      }
      if (type === 'result') {
        w.busy = false;
        this.scheduleStop(w);
      }
      if (type === 'control_request') {
        const requestId = String(msg['request_id']);
        const subtype = field(msg['request'], 'subtype');
        if (typeof subtype === 'string' && ASKS_A_PERSON.has(subtype)) w.pending.set(requestId, line);
        else if (!client) return this.answerDetached(w, requestId, subtype, msg['request']);
        else w.forwarded.set(requestId, { subtype, request: msg['request'] });
      }
      if (type === 'control_cancel_request') {
        w.pending.delete(String(msg['request_id']));
        w.forwarded.delete(String(msg['request_id']));
      }
    }
    if (!client) return;
    send(client.socket, { o: line });
    const answered = msg?.['type'] === 'control_response' ? field(msg['response'], 'request_id') : undefined;
    if (typeof answered === 'string' && client.initializeIds.delete(answered)) {
      for (const ask of w.pending.values()) send(client.socket, { o: ask });
    }
  }

  /**
   * With no window connected, the panel's hooks (a file baseline before an edit, diagnostics after it) let the tool
   * run and its VS Code tools report that no window is there; a turn that only needs a person waits for one.
   */
  private answerDetached(w: Worker, requestId: string, subtype: unknown, request: unknown): void {
    const success = (response: Json) =>
      w.write(JSON.stringify({ type: 'control_response', response: { subtype: 'success', request_id: requestId, response } }));
    if (subtype === 'hook_callback') return success({});
    if (subtype === 'mcp_message') {
      const id = field(field(request, 'message'), 'id') ?? 0;
      return success({ mcp_response: { jsonrpc: '2.0', id, error: { code: -32000, message: DETACHED } } });
    }
    w.write(JSON.stringify({ type: 'control_response', response: { subtype: 'error', request_id: requestId, error: DETACHED } }));
  }

  private fromPanel(w: Worker, client: Client, line: string): void {
    if (w.client !== client) return;
    const msg = parse(line);
    if (msg?.['type'] === 'user') {
      w.busy = true;
      this.cancelStop(w);
    }
    if (msg?.['type'] === 'control_response') {
      const answered = field(msg['response'], 'request_id');
      if (typeof answered === 'string') {
        w.pending.delete(answered);
        w.forwarded.delete(answered);
      }
    }
    if (msg?.['type'] === 'control_request' && field(msg['request'], 'subtype') === 'initialize') {
      client.initializeIds.add(String(msg['request_id']));
    }
    w.write(line);
  }

  private detach(w: Worker, client: Client | undefined): void {
    if (client && w.client !== client) return;
    w.client = undefined;
    for (const [requestId, { subtype, request }] of w.forwarded) this.answerDetached(w, requestId, subtype, request);
    w.forwarded.clear();
    this.options.log(`${w.sessionId ?? 'new session'}: detached while ${w.state}`);
    // A process that never announced its session cannot be reopened, so keeping it idle only holds memory.
    if (!w.sessionId && w.state === 'idle') void this.stop(w);
    else this.scheduleStop(w);
  }

  private scheduleStop(w: Worker): void {
    if (w.client || w.state !== 'idle' || w.stopTimer) return;
    w.stopTimer = setTimeout(() => {
      w.stopTimer = undefined;
      if (!w.client && w.state === 'idle') void this.stop(w);
    }, this.options.idleStopMs);
    w.stopTimer.unref();
  }

  private cancelStop(w: Worker): void {
    if (w.stopTimer) clearTimeout(w.stopTimer);
    w.stopTimer = undefined;
  }

  private async stop(w: Worker): Promise<void> {
    if (w.proc.exitCode !== null || w.proc.signalCode !== null) return;
    w.proc.kill('SIGTERM');
    const killer = setTimeout(() => w.proc.kill('SIGKILL'), 5000);
    await w.exited;
    clearTimeout(killer);
  }

  private armEmptyExit(): void {
    if (this.emptyTimer || this.workers.size > 0 || this.connections > 0) return;
    this.emptyTimer = setTimeout(() => {
      if (this.workers.size > 0 || this.connections > 0) return this.disarmEmptyExit();
      this.options.log('no sessions left; exiting');
      void this.close().then(() => process.exit(0));
    }, this.options.emptyExitMs);
    this.emptyTimer.unref();
  }

  private disarmEmptyExit(): void {
    if (this.emptyTimer) clearTimeout(this.emptyTimer);
    this.emptyTimer = undefined;
  }
}

function answers(socketPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect(socketPath);
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => resolve(false));
  });
}
