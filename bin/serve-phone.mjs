#!/usr/bin/env node
// Serves the Agent Sessions view and the agent panels to a phone browser through `code serve-web`.
//
//   node bin/serve-phone.mjs [--port 8321] [--host 127.0.0.1] [--vsix agent-sessions-x.y.z.vsix] [--password-file path] [--no-password]
//   node bin/serve-phone.mjs --install-service [same flags]   # a systemd user unit that runs it, now and after reboots
//
// A dedicated server data dir (~/.agent-sessions/web) keeps this window apart from the desktop's: its own settings
// (chrome hidden, phoneMode on), its own extensions (this one, Codex, Claude Code). The URL printed opens an empty
// window (`ew=true`): no folder means no Restricted Mode, so every extension activates without a trust prompt.
// The CLI exits after a while without clients, so it is restarted for as long as this script runs.
//
// The port asks for a password (HTTP basic auth, any user name): serve-web itself listens on loopback only, and this
// script proxies to it. The password is generated once into ~/.agent-sessions/web/password.
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createServer, request as httpRequest } from 'node:http';
import { connect } from 'node:net';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const port = flag('port', '8321');
const host = flag('host', '127.0.0.1');
const withPassword = !args.includes('--no-password');
const root = join(homedir(), '.agent-sessions', 'web');
const serverDir = join(root, 'server');
const cliDir = join(root, 'cli');
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * The `code` CLI that has `serve-web`: the standalone CLI the VS Code server keeps under ~/.vscode-server first, then
 * whatever is on PATH, which inside a remote window is the server's shim that only opens files.
 */
function findCode() {
  const env = process.env.AGENT_SESSIONS_CODE;
  if (env) return env;
  const dir = join(homedir(), '.vscode-server');
  const found = existsSync(dir)
    ? readdirSync(dir)
        .filter((n) => /^code-[0-9a-f]{40}$/.test(n))
        .map((n) => join(dir, n))
        .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)
    : [];
  const onPath = spawnSync('sh', ['-c', 'command -v code'], { encoding: 'utf8' }).stdout.trim();
  for (const c of [...found, onPath].filter(Boolean)) {
    const probe = spawnSync(c, ['serve-web', '--help'], { encoding: 'utf8' });
    if (probe.status === 0 && /--server-data-dir/.test(probe.stdout)) return c;
  }
  return undefined;
}

function ourVsix() {
  const given = flag('vsix');
  if (given) return resolve(given);
  const version = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8')).version;
  const candidate = join(repo, `agent-sessions-${version}.vsix`);
  return existsSync(candidate) ? candidate : undefined;
}

const MACHINE_SETTINGS = {
  'workbench.activityBar.location': 'hidden',
  'workbench.statusBar.visible': false,
  'window.commandCenter': false,
  'workbench.layoutControl.enabled': false,
  'workbench.editor.showTabs': 'multiple',
  'workbench.editor.editorActionsLocation': 'titleBar',
  'breadcrumbs.enabled': false,
  'editor.minimap.enabled': false,
  'workbench.startupEditor': 'none',
  'workbench.tips.enabled': false,
  'workbench.welcomePage.walkthroughs.openOnInstall': false,
  'workbench.panel.defaultLocation': 'bottom',
  'terminal.integrated.enablePersistentSessions': false,
  'agentSessions.phoneMode': true,
};

function writeSettings() {
  const dir = join(serverDir, 'data', 'Machine');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'settings.json');
  let current = {};
  try {
    current = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    // First run, or hand-edited into something unreadable: start from the defaults.
  }
  writeFileSync(file, JSON.stringify({ ...current, ...MACHINE_SETTINGS }, null, 2) + '\n');
}

function password() {
  if (!withPassword) return undefined;
  const file = flag('password-file', join(root, 'password'));
  if (!existsSync(file)) writeFileSync(file, randomBytes(15).toString('base64url'), { mode: 0o600 });
  return readFileSync(file, 'utf8').trim();
}

/** The password gate: a proxy on the public address in front of serve-web on loopback, HTTP and WebSocket alike. */
function gate(secret, upstreamPort) {
  const ok = (req) => {
    const h = req.headers.authorization ?? '';
    if (!h.startsWith('Basic ')) return false;
    const given = Buffer.from(Buffer.from(h.slice(6), 'base64').toString('utf8').split(':').slice(1).join(':'));
    const want = Buffer.from(secret);
    return given.length === want.length && timingSafeEqual(given, want);
  };
  const refuse = (res) => {
    res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="Agent Sessions"', 'Content-Type': 'text/plain' });
    res.end('Agent Sessions: password required.');
  };
  const server = createServer((req, res) => {
    if (!ok(req)) return refuse(res);
    const up = httpRequest({ host: '127.0.0.1', port: upstreamPort, method: req.method, path: req.url, headers: req.headers }, (r) => {
      res.writeHead(r.statusCode ?? 502, r.headers);
      r.pipe(res);
    });
    up.on('error', () => {
      res.writeHead(502);
      res.end('serve-web is not up yet.');
    });
    req.pipe(up);
  });
  server.on('upgrade', (req, socket, head) => {
    if (!ok(req)) {
      socket.end('HTTP/1.1 401 Unauthorized\r\nWWW-Authenticate: Basic realm="Agent Sessions"\r\nConnection: close\r\n\r\n');
      return;
    }
    const up = connect(upstreamPort, '127.0.0.1', () => {
      const lines = [`${req.method} ${req.url} HTTP/${req.httpVersion}`];
      for (let i = 0; i < req.rawHeaders.length; i += 2) lines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`);
      up.write(lines.join('\r\n') + '\r\n\r\n');
      if (head.length) up.write(head);
      socket.pipe(up).pipe(socket);
    });
    const drop = () => {
      socket.destroy();
      up.destroy();
    };
    up.on('error', drop);
    socket.on('error', drop);
  });
  server.listen(Number(port), host);
}

/** The web build's own `code-server` appears once `serve-web` has downloaded it; extensions install through it. */
function webCodeServer() {
  const dir = join(cliDir, 'serve-web');
  if (!existsSync(dir)) return undefined;
  const builds = readdirSync(dir).map((n) => join(dir, n, 'bin', 'code-server')).filter(existsSync);
  return builds.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];
}

async function installExtensions() {
  for (let i = 0; i < 120 && !webCodeServer(); i++) await new Promise((r) => setTimeout(r, 1000));
  const cs = webCodeServer();
  if (!cs) {
    console.error('serve-web did not download its web build; extensions were not installed.');
    return;
  }
  const install = ['--extensions-dir', join(serverDir, 'extensions'), '--install-extension', 'openai.chatgpt', '--install-extension', 'anthropic.claude-code'];
  const vsix = ourVsix();
  if (vsix) install.push('--install-extension', vsix, '--force');
  else console.error('No agent-sessions vsix found next to package.json (run `pnpm package`), pass --vsix; the extension itself was not installed.');
  const r = spawnSync(cs, install, { encoding: 'utf8' });
  const lines = `${r.stdout}\n${r.stderr}`.split('\n').filter((l) => /installed|already|error|fail/i.test(l));
  for (const l of lines) console.log(l.trim());
}

if (args.includes('--install-service')) {
  installService();
  process.exit(0);
}

const code = findCode();
if (!code) {
  console.error('No `code` CLI found: put it on PATH or set AGENT_SESSIONS_CODE to it.');
  process.exit(1);
}
mkdirSync(root, { recursive: true });
writeSettings();
const secret = password();
// With a password, serve-web listens on loopback behind the gate; without one it takes the public address itself.
const upstreamPort = secret ? String(Number(port) + 1) : port;
const serveArgs = ['serve-web', '--host', secret ? '127.0.0.1' : host, '--port', upstreamPort, '--without-connection-token', '--accept-server-license-terms', '--server-data-dir', serverDir, '--cli-data-dir', cliDir];
if (secret) gate(secret, upstreamPort);

/** A systemd user unit for this script with the flags given (bar --install-service); lingering keeps it up after logout. */
function installService() {
  const unitDir = join(homedir(), '.config', 'systemd', 'user');
  mkdirSync(unitDir, { recursive: true });
  const rest = args.filter((a) => a !== '--install-service').map((a) => JSON.stringify(a)).join(' ');
  const unit = `[Unit]
Description=Agent Sessions on a phone (code serve-web)
After=network.target

[Service]
ExecStart=${process.execPath} ${fileURLToPath(import.meta.url)} ${rest}
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
`;
  writeFileSync(join(unitDir, 'agent-sessions-phone.service'), unit);
  for (const cmd of [['systemctl', ['--user', 'daemon-reload']], ['systemctl', ['--user', 'enable', '--now', 'agent-sessions-phone.service']], ['loginctl', ['enable-linger', process.env.USER ?? '']]]) {
    const r = spawnSync(cmd[0], cmd[1], { encoding: 'utf8' });
    if (r.status !== 0) console.error(`${cmd[0]} ${cmd[1].join(' ')}: ${(r.stderr || r.stdout).trim()}`);
  }
  console.log('Installed agent-sessions-phone.service; `systemctl --user status agent-sessions-phone` and `journalctl --user -u agent-sessions-phone -f` for the URL.');
}

let stopping = false;
function serve() {
  const child = spawn(code, serveArgs, { stdio: ['ignore', 'inherit', 'inherit'] });
  child.on('exit', (status) => {
    if (stopping) return;
    console.log(`serve-web exited (${status}); restarting in 2s.`);
    setTimeout(serve, 2000);
  });
  return child;
}
let child = serve();
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    stopping = true;
    child.kill();
    process.exit(0);
  });
}
void installExtensions().then(() => {
  const shown = host === '0.0.0.0' || host === '::' ? 'your-host' : host;
  console.log(`\nAgent Sessions on a phone: http://${shown}:${port}/?ew=true`);
  console.log(secret ? `Password (any user name): ${secret}\n` : 'No password: the port is open to whoever reaches it.\n');
  console.log('Plain HTTP: use it on a trusted network, over an SSH tunnel, or behind a TLS proxy (see README).');
});
