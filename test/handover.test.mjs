import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { build } from 'esbuild';

class Uri {
  constructor(parts) { Object.assign(this, { scheme: 'file', authority: '', path: '', query: '' }, parts); }
  static file(path) { return new Uri({ path }); }
  with(change) { return new Uri({ ...this, ...change }); }
}
const calls = [];
globalThis.__agentSessionsVSCode = {
  Uri,
  ViewColumn: { Active: -1 },
  window: { tabGroups: { all: [], activeTabGroup: { viewColumn: 1, tabs: [] } } },
  commands: { executeCommand: async (command, ...args) => { calls.push([command, ...args]); } },
  extensions: { getExtension: () => ({}) },
};
const directory = await mkdtemp(join(tmpdir(), 'agent-sessions-handover-test-'));
process.env.HOME = directory;
const bundle = join(directory, 'handover.cjs');
await build({
  stdin: { contents: `export * from './src/open.ts'; export * from './src/handover.ts';`, resolveDir: process.cwd() },
  bundle: true, platform: 'node', format: 'cjs', outfile: bundle, external: ['node:sqlite'],
  plugins: [{ name: 'vscode-stub', setup(b) {
    b.onResolve({ filter: /^vscode$/ }, () => ({ path: 'vscode', namespace: 'stub' }));
    b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: 'module.exports = globalThis.__agentSessionsVSCode;' }));
  } }],
});
const { handoverNote, handoverTarget, writeHandoverNote, newSessionFrom } = createRequire(import.meta.url)(bundle);
after(() => rm(directory, { recursive: true, force: true }));

const session = (tool) => ({ tool, id: `${tool}-1`, title: 'Fix the build', cwd: '/work/repo', transcriptPath: `/transcripts/${tool}.jsonl` });

test('a moved session starts in the other tool from a note naming the old transcript', () => {
  assert.equal(handoverTarget(session('claude')), 'codex');
  assert.equal(handoverTarget(session('codex')), 'claude');
  const note = handoverNote(session('codex'));
  assert.match(note, /started in Codex: "Fix the build"/, 'the note says where the session came from');
  assert.match(note, /\/transcripts\/codex\.jsonl/, 'the new agent is pointed at the old transcript to read');
  assert.match(note, /\/work\/repo/, 'and at the folder the old session worked in');
});

test('Claude Code gets the note as its first prompt; Codex gets it attached to a new panel of its own', async () => {
  const from = session('codex');
  calls.length = 0;
  await newSessionFrom('claude', handoverNote(from), await writeHandoverNote(from));
  assert.deepEqual(calls.map((c) => c[0]), ['claude-vscode.editor.open']);
  assert.equal(calls[0][1], undefined, 'a new Claude session, not a resumed one');
  assert.equal(calls[0][2], handoverNote(from), 'the note is the first prompt');

  const claudeSession = session('claude');
  const file = await writeHandoverNote(claudeSession);
  assert.equal(await readFile(file, 'utf8'), handoverNote(claudeSession) + '\n', 'the attached file is the note');
  calls.length = 0;
  await newSessionFrom('codex', handoverNote(claudeSession), file);
  assert.deepEqual(calls.map((c) => c[0]), ['vscode.openWith', 'chatgpt.addFileToThread'], 'the panel opens before the note is attached to the focused one');
  assert.equal(calls[0][1].path, '/extension/panel/new', 'a new Codex thread');
  assert.equal(calls[1][1].path, file);
});
