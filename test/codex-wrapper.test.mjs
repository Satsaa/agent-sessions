import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { spawn } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';

const FAKE = fileURLToPath(new URL('./fixtures/fake-codex.mjs', import.meta.url));
const PANEL_ARGS = ['-c', 'features.code_mode_host=true', 'app-server', '--analytics-default-enabled'];
let dir, wrapper, bin, log;

before(async () => {
  const { build } = await import('esbuild');
  dir = await mkdtemp(join(tmpdir(), 'agent-sessions-codex-test-'));
  await build({
    entryPoints: { 'codex-wrapper': 'src/host/codex-wrapper.ts' },
    bundle: true, platform: 'node', format: 'esm', outdir: dir, outExtension: { '.js': '.mjs' },
    external: ['bufferutil', 'utf-8-validate'],
    banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
  });
  wrapper = join(dir, 'codex-wrapper.mjs');
  // Where the extension keeps its binary; the wrapper prefers it over any other codex on PATH.
  bin = join(dir, 'openai.chatgpt-0.0.0', 'bin');
  await mkdir(bin, { recursive: true });
  await writeFile(join(bin, 'codex'), `#!/bin/sh\nexec "${process.execPath}" "${FAKE}" "$@"\n`);
  await chmod(join(bin, 'codex'), 0o755);
  log = join(dir, 'fake-codex.log');
});

after(() => rm(dir, { recursive: true, force: true }));

/** A Codex daemon under its own CODEX_HOME, answering each request with its name. */
async function daemon(home) {
  await mkdir(join(home, 'app-server-control'), { recursive: true });
  const server = new WebSocketServer({ noServer: true });
  const { createServer } = await import('node:http');
  const http = createServer();
  http.on('upgrade', (req, socket, head) => server.handleUpgrade(req, socket, head, (ws) => server.emit('connection', ws)));
  const clients = [];
  server.on('connection', (ws) => {
    clients.push(ws);
    ws.on('message', (data) => {
      const m = JSON.parse(data.toString());
      ws.send(JSON.stringify({ id: m.id, result: { from: 'daemon' } }));
    });
  });
  await new Promise((resolve) => http.listen(join(home, 'app-server-control', 'app-server-control.sock'), resolve));
  return { clients, close: () => new Promise((resolve) => (clients.forEach((c) => c.terminate()), http.close(resolve))) };
}

function run(home, args) {
  const child = spawn(process.execPath, [wrapper, ...args], { env: { ...process.env, CODEX_HOME: home, PATH: `${process.env.PATH}:${bin}`, FAKE_CODEX_LOG: log } });
  let out = '';
  let err = '';
  child.stdout.on('data', (c) => (out += c));
  child.stderr.on('data', (c) => (err += c));
  const exited = new Promise((resolve) => child.on('exit', resolve));
  const reply = (id) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`no reply ${id}: ${out} ${err}`)), 5000);
      const check = () => {
        const line = out.split('\n').filter(Boolean).map((l) => JSON.parse(l)).find((m) => m.id === id);
        if (line) (clearTimeout(timer), child.stdout.off('data', check), resolve(line));
      };
      child.stdout.on('data', check);
      check();
    });
  return { child, exited, reply, stderr: () => err, send: (m) => child.stdin.write(`${JSON.stringify(m)}\n`) };
}

const calls = async () => (await readFile(log, 'utf8').catch(() => '')).split('\n').filter(Boolean);

test('the panel’s app-server talks to the Codex daemon, and the bundled binary is not started', async () => {
  const home = join(dir, 'home-daemon');
  const d = await daemon(home);
  const before = (await calls()).length;
  const w = run(home, PANEL_ARGS);
  w.send({ id: 7, method: 'initialize', params: {} });
  assert.equal((await w.reply(7)).result.from, 'daemon', 'the window’s requests reach the daemon, so its turns outlive the window');
  assert.equal((await calls()).length, before, 'no private app-server runs beside the daemon');
  w.child.stdin.end();
  assert.equal(await w.exited, 0);
  await d.close();
});

test('the daemon going away ends the panel’s connection with an error', async () => {
  const home = join(dir, 'home-restart');
  const d = await daemon(home);
  const w = run(home, PANEL_ARGS);
  w.send({ id: 1, method: 'initialize', params: {} });
  await w.reply(1);
  await d.close();
  assert.equal(await w.exited, 1, 'the extension reports a failed app-server and starts a new one');
  assert.match(w.stderr(), /daemon closed the connection/);
});

test('without a daemon that starts, the panel gets the bundled app-server with its own arguments', async () => {
  const home = join(dir, 'home-none');
  const w = run(home, PANEL_ARGS);
  w.send({ id: 1, method: 'initialize', params: {} });
  assert.equal((await w.reply(1)).result.from, 'bundled', 'the panel keeps working when the daemon cannot run');
  const log = await calls();
  assert.ok(log.includes('app-server daemon start'), 'Codex’s own start is tried first');
  assert.ok(log.includes(PANEL_ARGS.join(' ')), 'the fallback runs exactly what the extension asked for');
  w.child.stdin.end();
  await w.exited;
});

test('other commands run the bundled binary unchanged', async () => {
  const w = run(join(dir, 'home-none'), ['stdio-to-uds', '/tmp/lsp.sock']);
  assert.equal(await w.exited, 0);
  assert.ok((await calls()).includes('stdio-to-uds /tmp/lsp.sock'), 'the LSP bridge and one-off commands are not ours to route');
});
