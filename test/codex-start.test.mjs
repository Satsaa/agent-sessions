import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import { WebSocketServer } from 'ws';

const require = createRequire(import.meta.url);
const dir = await mkdtemp(join(tmpdir(), 'agent-sessions-codex-start-test-'));
const bundle = join(dir, 'daemon.cjs');
await build({ entryPoints: ['src/host/codex-daemon.ts'], bundle: true, platform: 'node', format: 'cjs', outfile: bundle, external: ['bufferutil', 'utf-8-validate'] });
const { startDaemonThread } = require(bundle);
after(() => rm(dir, { recursive: true, force: true }));

test('a first message starts a VS Code thread on the daemon and sends it as the first turn', async () => {
  const home = join(dir, 'codex');
  await mkdir(join(home, 'app-server-control'), { recursive: true });
  const server = new WebSocketServer({ noServer: true });
  const http = createServer();
  http.on('upgrade', (req, socket, head) => server.handleUpgrade(req, socket, head, (ws) => server.emit('connection', ws)));
  const calls = [];
  server.on('connection', (ws) => ws.on('message', (data) => {
    const m = JSON.parse(data.toString());
    calls.push([m.method, m.params]);
    if (m.id === undefined) return;
    ws.send(JSON.stringify({ id: m.id, result: m.method === 'thread/start' ? { thread: { id: 'new-thread' } } : {} }));
  }));
  await new Promise((resolve) => http.listen(join(home, 'app-server-control', 'app-server-control.sock'), resolve));
  try {
    assert.equal(await startDaemonThread('/work', 'Fix the flaky test', home), 'new-thread');
    assert.equal(calls[0][1].clientInfo.name, 'codex_vscode', 'Codex records a thread by its client, so it must start as the panel’s own would');
    assert.deepEqual(calls.slice(2), [
      ['thread/start', { cwd: '/work' }],
      ['turn/start', { threadId: 'new-thread', input: [{ type: 'text', text: 'Fix the flaky test', text_elements: [] }] }],
    ], 'the thread starts in the window’s folder and its first turn is the message');
  } finally {
    await new Promise((resolve) => http.close(resolve));
  }
});

test('without a daemon no thread is started', async () => {
  assert.equal(await startDaemonThread('/work', 'hello', join(dir, 'none')), undefined);
});
