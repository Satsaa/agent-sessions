import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';
import { build } from 'esbuild';

const directory = await mkdtemp(join(tmpdir(), 'handover-'));
const home = join(directory, 'codex');
process.env.CODEX_HOME = home;
await mkdir(join(home, 'app-server-control'), { recursive: true });
await mkdir(join(directory, 'bin', 'test'), { recursive: true });
await writeFile(join(directory, 'bin', 'test', 'codex'), '');
class Uri {
  constructor(parts) { Object.assign(this, { scheme: 'file', authority: '', path: '', query: '' }, parts); }
  static file(path) { return new Uri({ path }); }
  with(change) { return new Uri({ ...this, ...change }); }
}
let enabled = true;
let failure;
let openFailure = false;
const calls = [];
const rpc = [];
globalThis.__agentSessionsVSCode = {
  Uri, ViewColumn: { Active: -1 }, ProgressLocation: { Notification: 1 },
  window: { tabGroups: { all: [], activeTabGroup: { viewColumn: 1, tabs: [] } }, withProgress: async (_, fn) => fn() },
  workspace: { getConfiguration: () => ({ get: (key) => key === 'codexHome' ? home : enabled }) },
  commands: { executeCommand: async (command, ...args) => { calls.push([command, ...args]); if (openFailure) throw new Error('panel unavailable'); } },
  extensions: { getExtension: () => ({ extensionPath: directory }) },
};
const server = new WebSocketServer({ noServer: true });
const http = createServer();
http.on('upgrade', (req, socket, head) => server.handleUpgrade(req, socket, head, ws => server.emit('connection', ws)));
server.on('connection', ws => ws.on('message', data => {
  const m = JSON.parse(data.toString());
  rpc.push(m);
  if (m.id === undefined) return;
  const result = m.method === 'thread/start' ? { thread: { id: 'destination' } } : m.method === 'thread/read' ? { thread: { preview: 'Continue the task' } } : {};
  ws.send(JSON.stringify({ id: m.id, ...(m.method === failure ? { error: { message: 'turn rejected' } } : { result }) }));
}));
await new Promise(resolve => http.listen(join(home, 'app-server-control', 'app-server-control.sock'), resolve));
const bundle = join(directory, 'handover.cjs');
await build({
  stdin: { contents: `export * from './src/open.ts'; export * from './src/handover.ts';`, resolveDir: process.cwd() },
  bundle: true, platform: 'node', format: 'cjs', outfile: bundle, external: ['node:sqlite'],
  plugins: [{ name: 'vscode-stub', setup(b) {
    b.onResolve({ filter: /^vscode$/ }, () => ({ path: 'vscode', namespace: 'stub' }));
    b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: 'module.exports = globalThis.__agentSessionsVSCode;' }));
  } }],
});
const { handoverNote, handoverTarget, newSessionFrom } = createRequire(import.meta.url)(bundle);
after(async () => { for (const ws of server.clients) ws.terminate(); await new Promise(resolve => http.close(resolve)); await rm(directory, { recursive: true, force: true }); });
const session = tool => ({ tool, id: `${tool}-1`, title: 'Fix the build', cwd: '/work/repo', transcriptPath: `/transcripts/${tool}.jsonl` });

test('a moved session gets the source transcript and worktree in its handover', () => {
  assert.equal(handoverTarget(session('claude')), 'codex');
  assert.equal(handoverTarget(session('codex')), 'claude');
  assert.match(handoverNote(session('codex')), /\/transcripts\/codex\.jsonl/);
  assert.match(handoverNote(session('codex')), /\/work\/repo/);
});

test('moving to Codex submits the handover in the source worktree before opening the actual destination', async () => {
  calls.length = 0; rpc.length = 0;
  const source = session('claude');
  assert.equal(await newSessionFrom('codex', handoverNote(source), source.cwd), true, 'only a submitted turn allows archiving');
  assert.deepEqual(rpc.find(m => m.method === 'thread/start').params, { cwd: source.cwd });
  assert.equal(rpc.find(m => m.method === 'turn/start').params.input[0].text, handoverNote(source));
  assert.deepEqual(calls.map(c => c[0]), ['vscode.openWith']);
  assert.equal(calls[0][1].path, '/local/destination', 'no untitled placeholder panel or attachment command');
});

test('prefilling Claude does not claim that the destination has started', async () => {
  calls.length = 0;
  assert.equal(await newSessionFrom('claude', 'continue'), false, 'the source remains available while the prompt is unsent');
  assert.equal(calls[0][0], 'claude-vscode.editor.open');
  assert.equal(calls[0][2], 'continue');
});

test('failed starts and disabled hosting cannot be mistaken for successful moves', async () => {
  failure = 'turn/start'; calls.length = 0;
  await assert.rejects(newSessionFrom('codex', 'continue'), /turn rejected/);
  assert.equal(calls.length, 0, 'a rejected turn must not open an empty panel');
  failure = undefined; enabled = false;
  await assert.rejects(newSessionFrom('codex', 'continue'), /source session is still available/);
  enabled = true;
});

test('if opening fails after the turn starts, the error identifies the recoverable destination', async () => {
  openFailure = true;
  await assert.rejects(newSessionFrom('codex', 'continue'), /conversation destination started/);
  openFailure = false;
});
