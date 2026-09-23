#!/usr/bin/env node
// Serves the Agent Sessions view and the agent panels to a phone browser through `code serve-web`.
//
//   node bin/serve-phone.mjs [--port 8321] [--host 127.0.0.1] [--folder ~] [--vsix agent-sessions-x.y.z.vsix] [--password-file path] [--no-password]
//   node bin/serve-phone.mjs --install-service [same flags]   # a systemd user unit that runs it, now and after reboots
//
// A dedicated server data dir (~/.agent-sessions/web) keeps this window apart from the desktop's: its own settings
// (chrome hidden, phoneMode on), its own extensions (this one, Codex, Claude Code). The URL printed opens an empty
// window (`ew=true`): no folder means no Restricted Mode, so every extension activates without a trust prompt.
// The `code` CLI only downloads the web build (serve-web); the build's own `code-server` is what runs, because it
// takes --disable-workspace-trust and the CLI does not: without it every folder opens in Restricted Mode, where no
// extension activates, and trust could only be granted by hand in each browser. It is restarted if it ever exits.
//
// serve-web itself listens on loopback only, and this script proxies to it: the proxy asks for a password (HTTP basic
// auth, any user name; generated once into ~/.agent-sessions/web/password) and adds the workbench stylesheet.
//
// The URL opens a folder (--folder, the home directory by default) rather than an empty window: Claude Code resumes
// only sessions of the window's folder, so the extension moves the window to a session's folder when needed, and
// a folder is what it moves between.
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
const folder = resolve(flag('folder', homedir()));
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

const CODEX_VERSION = '26.908.40401';

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
  // The phone shows agent sessions and nothing else: no built-in chat/agent features, no
  // suggestions, no telemetry or experiments, and a fixed dark theme regardless of the browser.
  'chat.disableAIFeatures': true,
  'chat.commandCenter.enabled': false,
  'chat.agent.enabled': false,
  'workbench.colorTheme': 'Default Dark Modern',
  'window.autoDetectColorScheme': false,
  'window.autoDetectHighContrast': false,
  'workbench.editor.empty.hint': 'hidden',
  'extensions.ignoreRecommendations': true,
  'workbench.enableExperiments': false,
  'telemetry.telemetryLevel': 'off',
  'update.showReleaseNotes': false,
  'git.openRepositoryInParentFolders': 'never',
  // Toasts at the top, where a phone's keyboard and thumb are not; WORKBENCH_CSS moves them below the tabs.
  'workbench.notifications.position': 'top-right',
  // Less background work and fewer popups: no port-forwarding offers for the dev servers agents start, no Git scan
  // of the whole folder (worktree deletion opens its repository itself), no file watching of the home folder, no
  // task/npm detection. Extension versions are the launcher's (see CODEX_VERSION), not auto-updates.
  'remote.autoForwardPorts': false,
  'git.autoRepositoryDetection': false,
  'git.showProgress': false,
  'files.watcherExclude': { '**': true },
  'extensions.autoUpdate': false,
  'extensions.autoCheckUpdates': false,
  'task.autoDetect': 'off',
  'npm.autoDetect': 'off',
  'debug.showInStatusBar': 'never',
  'workbench.settings.enableNaturalLanguageSearch': false,
  'terminal.integrated.suggest.enabled': false,
};

/**
 * Built-in extensions the phone has no use for, left out of the server's built-in scan on every launch
 * (VSCODE_SKIP_BUILTIN_EXTENSIONS; `--disable-extension` does not reach the web client), so they stay off across
 * web-build updates:
 * Copilot, GitHub and account sign-in, port tunnels and the in-editor browser, the debugger, editing aids, and the
 * heavy language servers. Git stays: the Delete worktree action goes through it.
 */
const DISABLED_BUILTINS = [
  'GitHub.copilot-chat',
  'TypeScriptTeam.jsts-chat-features',
  'vscode.github',
  'vscode.github-authentication',
  'vscode.microsoft-authentication',
  'vscode.tunnel-forwarding',
  'vscode.simple-browser',
  'vscode.debug-auto-launch',
  'vscode.debug-server-ready',
  'ms-vscode.js-debug',
  'ms-vscode.js-debug-companion',
  'ms-vscode.vscode-js-profile-table',
  'vscode.merge-conflict',
  'vscode.references-view',
  'vscode.terminal-suggest',
  'vscode.npm',
  'vscode.grunt',
  'vscode.gulp',
  'vscode.jake',
  'vscode.emmet',
  'vscode.ipynb',
  'vscode.extension-editing',
  'vscode.typescript-language-features',
  'vscode.php-language-features',
];

/**
 * Added to every workbench page. VS Code offsets top-right toasts and the notification centre by the title bar only
 * (inline `top`, or an `!important` rule in the modern UI), so they cover the editor tabs; push them below the tab
 * row. The repeated class outranks that rule. Internal class names: if a VS Code release renames them, toasts fall
 * back to sitting on the tabs.
 */
const WORKBENCH_CSS = `
.monaco-workbench.monaco-workbench.monaco-workbench > .notifications-toasts.top-right { top: 72px !important; }
.monaco-workbench.monaco-workbench.monaco-workbench > .notifications-center.top-right { top: 76px !important; }
`;

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

/**
 * The front: a proxy on the public address in front of serve-web on loopback, HTTP and WebSocket alike. It asks for
 * the password when there is one and adds WORKBENCH_CSS to HTML pages.
 */
function front(secret, upstreamPort) {
  const ok = (req) => {
    if (!secret) return true;
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
    // A page navigation is fetched uncompressed so the style can be spliced in; everything else streams through.
    const page = req.method === 'GET' && (req.headers.accept ?? '').includes('text/html');
    const headers = { ...req.headers };
    if (page) delete headers['accept-encoding'];
    const up = httpRequest({ host: '127.0.0.1', port: upstreamPort, method: req.method, path: req.url, headers }, (r) => {
      if (!page || !(r.headers['content-type'] ?? '').startsWith('text/html')) {
        res.writeHead(r.statusCode ?? 502, r.headers);
        r.pipe(res);
        return;
      }
      const chunks = [];
      r.on('data', (c) => chunks.push(c));
      r.on('end', () => {
        const html = Buffer.concat(chunks).toString('utf8').replace('</head>', `<style>${WORKBENCH_CSS}</style></head>`);
        const out = { ...r.headers };
        delete out['content-length'];
        res.writeHead(r.statusCode ?? 502, out);
        res.end(html);
      });
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
  const cs = webCodeServer();
  // Codex 26.917+ depends on "Codex Audio", a UI-kind extension with no browser entry, which the web
  // client cannot run, so Codex itself refuses to activate there. Installing an exact version pins it
  // (no auto-update). Bump when a Codex build works in `code serve-web` again.
  const install = ['--extensions-dir', join(serverDir, 'extensions'), '--install-extension', `openai.chatgpt@${CODEX_VERSION}`, '--install-extension', 'anthropic.claude-code'];
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

/** The web build, downloaded by the CLI's serve-web on first run (it is stopped as soon as the build is there). */
async function ensureWebBuild() {
  if (webCodeServer()) return;
  const code = findCode();
  if (!code) {
    console.error('No `code` CLI found to download the web build: put it on PATH or set AGENT_SESSIONS_CODE to it.');
    process.exit(1);
  }
  console.log('Downloading the VS Code web build…');
  const dl = spawn(code, ['serve-web', '--host', '127.0.0.1', '--port', '0', '--without-connection-token', '--accept-server-license-terms', '--server-data-dir', serverDir, '--cli-data-dir', cliDir], { stdio: ['ignore', 'ignore', 'inherit'] });
  for (let i = 0; i < 300 && !webCodeServer(); i++) await new Promise((r) => setTimeout(r, 1000));
  dl.kill();
  if (!webCodeServer()) {
    console.error('The web build did not arrive within five minutes.');
    process.exit(1);
  }
}

mkdirSync(root, { recursive: true });
writeSettings();
await ensureWebBuild();
const secret = password();
// serve-web listens on loopback behind the front, which takes the public address.
const upstreamPort = String(Number(port) + 1);
const serveArgs = ['--host', '127.0.0.1', '--port', upstreamPort, '--without-connection-token', '--accept-server-license-terms', '--server-data-dir', serverDir, '--disable-workspace-trust'];
front(secret, upstreamPort);

let stopping = false;
function serve() {
  const env = { ...process.env, VSCODE_SKIP_BUILTIN_EXTENSIONS: DISABLED_BUILTINS.join(',') };
  const child = spawn(webCodeServer(), serveArgs, { env, stdio: ['ignore', 'inherit', 'inherit'] });
  child.on('exit', (status) => {
    if (stopping) return;
    console.log(`code-server exited (${status}); restarting in 2s.`);
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
  console.log(`\nAgent Sessions on a phone: http://${shown}:${port}/?folder=${encodeURIComponent(folder)}`);
  console.log(secret ? `Password (any user name): ${secret}\n` : 'No password: the port is open to whoever reaches it.\n');
  console.log('Plain HTTP: use it on a trusted network, over an SSH tunnel, or behind a TLS proxy (see README).');
});
