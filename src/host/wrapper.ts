import { spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CLIENT_LABEL_ENV,
  DEFAULT_CLIENT_LABEL,
  PROTOCOL,
  hostDir,
  isPanelSession,
  lineReader,
  socketPath,
  type AttachRequest,
  type HostMessage,
} from './protocol.js';

/**
 * Started by the Claude extension in place of `claude` (`claudeCode.claudeProcessWrapper`), with the real binary as
 * the first argument. A panel conversation is handed to the session host; anything else, and every case where the
 * host cannot be reached, runs the binary directly so the panel never breaks because of us.
 */
const argv = process.argv.slice(2);
const HOST_SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'session-host.mjs');
const START_TIMEOUT_MS = 5000;

function runDirect(prefix: Buffer[] = []): void {
  const [command, ...args] = argv;
  const child = spawn(command!, args, { stdio: ['pipe', 'inherit', 'inherit'] });
  for (const chunk of prefix) child.stdin.write(chunk);
  process.stdin.pipe(child.stdin);
  child.stdin.on('error', () => {});
  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) process.on(signal, () => child.kill(signal));
  child.on('exit', (code, signal) => process.exit(code ?? (signal ? 128 : 1)));
}

function connect(file: string): Promise<net.Socket | undefined> {
  return new Promise((resolve) => {
    const socket = net.connect(file);
    socket.once('connect', () => resolve(socket));
    socket.once('error', () => resolve(undefined));
  });
}

/**
 * The host must outlive the VS Code server that starts it, and a systemd service stops its whole cgroup, so it runs
 * as its own transient user unit where systemd is there, and as a detached session leader elsewhere.
 */
function startHost(): void {
  fs.mkdirSync(hostDir(), { recursive: true, mode: 0o700 });
  const viaSystemd = spawnSync(
    'systemd-run',
    ['--user', '--unit=agent-sessions-host', '--collect', '--quiet', process.execPath, HOST_SCRIPT],
    { stdio: 'ignore', timeout: 3000 },
  );
  if (viaSystemd.status === 0) return;
  const child = spawn(process.execPath, [HOST_SCRIPT], { detached: true, stdio: 'ignore', env: process.env });
  child.unref();
}

async function reachHost(): Promise<net.Socket | undefined> {
  const file = socketPath();
  const existing = await connect(file);
  if (existing) return existing;
  startHost();
  const deadline = Date.now() + START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    const socket = await connect(file);
    if (socket) return socket;
  }
  return undefined;
}

async function main(): Promise<void> {
  if (!isPanelSession(argv)) return runDirect();
  const socket = await reachHost();
  if (!socket) {
    process.stderr.write('Agent Sessions: the session host did not start; this session ends with its window.\n');
    return runDirect();
  }
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
  const request: AttachRequest = {
    op: 'attach',
    protocol: PROTOCOL,
    argv,
    cwd: process.cwd(),
    env,
    client: { label: process.env[CLIENT_LABEL_ENV] || DEFAULT_CLIENT_LABEL, ownerPid: process.ppid },
  };
  socket.write(`${JSON.stringify(request)}\n`);

  // Kept until the host accepts, so a host that refuses our protocol still gets the whole input replayed to `claude`.
  let unconfirmed: Buffer[] | undefined = [];
  let finished = false;
  process.stdin.on('data', (chunk: Buffer) => {
    unconfirmed?.push(chunk);
    socket.write(chunk);
  });
  process.stdin.on('end', () => socket.end());
  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) process.on(signal, () => socket.destroy());

  const finish = (code: number, message?: string) => {
    finished = true;
    if (message) process.stderr.write(`${message}\n`);
    socket.destroy();
    process.stdout.write('', () => process.exit(code));
  };
  socket.on('data', lineReader((line) => {
    let message: HostMessage;
    try {
      message = JSON.parse(line) as HostMessage;
    } catch {
      return;
    }
    if ('o' in message) process.stdout.write(`${message.o}\n`);
    else if ('e' in message) process.stderr.write(message.e);
    else if (message.ev === 'attached') unconfirmed = undefined;
    else if (message.ev === 'refused') finish(1, message.message);
    // A clean exit: the panel shows a failed process's whole stderr, debug log included, which would bury the reason.
    // Its next message starts a new wrapper, and that refusal says where the session went.
    else if (message.ev === 'moved') finish(0, `This session moved to ${message.to}.`);
    else if (message.ev === 'exit') finish(message.code ?? (message.signal ? 128 : 1));
    else if (message.ev === 'error' && unconfirmed) {
      finished = true;
      const replay = unconfirmed;
      unconfirmed = undefined;
      process.stdin.removeAllListeners('data');
      process.stdin.removeAllListeners('end');
      socket.destroy();
      process.stderr.write(`Agent Sessions: ${message.message}; this session ends with its window.\n`);
      runDirect(replay);
    }
  }));
  socket.on('close', () => {
    if (!finished) finish(1, 'Agent Sessions: the session host went away.');
  });
  socket.on('error', () => {});
}

void main();
