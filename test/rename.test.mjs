import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import { mkdtemp, rm, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import { DatabaseSync } from 'node:sqlite';

const require = createRequire(import.meta.url);
const directory = await mkdtemp(join(tmpdir(), 'agent-sessions-rename-test-'));
const bundle = join(directory, 'rename.cjs');
await build({ stdin: { contents: `export * from './src/rename.ts'; export * from './src/claude.ts'; export { titleMatchesLabel } from './src/util.ts';`, resolveDir: process.cwd() }, bundle: true, platform: 'node', format: 'cjs', outfile: bundle, external: ['vscode', 'node:sqlite'] });
const { renameSession, listClaudeSessions } = require(bundle);
after(() => rm(directory, { recursive: true, force: true }));

test('renaming a Claude session writes the sidecar and the transcript record, and the listing reads the sidecar first', async () => {
  const home = join(directory, 'claude');
  const project = join(home, 'projects', '-tmp-work');
  await mkdir(project, { recursive: true });
  const id = '11111111-2222-4333-8444-555555555555';
  const transcript = join(project, `${id}.jsonl`);
  // No trailing newline: a rename must not glue its record onto the last line.
  await writeFile(transcript, [
    JSON.stringify({ type: 'user', uuid: 'u1', timestamp: '2026-09-01T10:00:00Z', cwd: '/tmp/work', message: { role: 'user', content: 'first prompt here' } }),
    JSON.stringify({ type: 'ai-title', aiTitle: 'AI picked title', sessionId: id }),
  ].join('\n'));
  const session = { tool: 'claude', id, title: 'AI picked title', transcriptPath: transcript };
  await renameSession(session, join(directory, 'unused-codex'), '  Renamed by hand  ');
  assert.deepEqual(JSON.parse(await readFile(join(project, id, 'custom-title.json'), 'utf8')), { customTitle: 'Renamed by hand' });
  const lines = (await readFile(transcript, 'utf8')).split('\n').filter(Boolean);
  assert.equal(lines.length, 3, 'one record appended on its own line');
  assert.deepEqual(JSON.parse(lines[2]), { type: 'custom-title', customTitle: 'Renamed by hand', sessionId: id });
  const listed = (await listClaudeSessions(home)).find((s) => s.id === id);
  assert.equal(listed?.title, 'Renamed by hand');
});

test('renaming a Codex thread updates the state database title and appends to the name index', async () => {
  const home = join(directory, 'codex');
  await mkdir(home, { recursive: true });
  const db = new DatabaseSync(join(home, 'state_5.sqlite'));
  db.exec('CREATE TABLE threads (id TEXT PRIMARY KEY, title TEXT NOT NULL, name TEXT)');
  // A thread renamed once inside Codex carries `name`, which Codex shows over `title`: both must move or the rename is invisible there.
  db.prepare('INSERT INTO threads VALUES (?, ?, ?)').run('thread-1', 'old title', 'old name');
  db.close();
  await renameSession({ tool: 'codex', id: 'thread-1', title: 'old title', transcriptPath: join(home, 'r.jsonl') }, home, 'New thread name');
  const check = new DatabaseSync(join(home, 'state_5.sqlite'), { readOnly: true });
  assert.deepEqual({ ...check.prepare('SELECT title, name FROM threads WHERE id = ?').all('thread-1')[0] }, { title: 'New thread name', name: 'New thread name' });
  check.close();
  const index = (await readFile(join(home, 'session_index.jsonl'), 'utf8')).trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(index.length, 1);
  assert.equal(index[0].id, 'thread-1');
  assert.equal(index[0].thread_name, 'New thread name');
  await assert.rejects(renameSession({ tool: 'codex', id: 'thread-1', title: 'x', transcriptPath: '' }, home, '   '), /empty/);
});

test('renaming a Codex thread in a state database without a name column still sets the title', async () => {
  const home = join(directory, 'codex-legacy');
  await mkdir(home, { recursive: true });
  const db = new DatabaseSync(join(home, 'state_5.sqlite'));
  db.exec('CREATE TABLE threads (id TEXT PRIMARY KEY, title TEXT NOT NULL)');
  db.prepare('INSERT INTO threads VALUES (?, ?)').run('thread-1', 'old title');
  db.close();
  await renameSession({ tool: 'codex', id: 'thread-1', title: 'old title', transcriptPath: join(home, 'r.jsonl') }, home, 'Legacy rename');
  const check = new DatabaseSync(join(home, 'state_5.sqlite'), { readOnly: true });
  assert.equal(check.prepare('SELECT title FROM threads WHERE id = ?').all('thread-1')[0].title, 'Legacy rename');
  check.close();
});

test('tab labels match titles across the vendors’ truncation and whitespace differences', async () => {
  const { titleMatchesLabel } = require(bundle);
  assert.ok(titleMatchesLabel('Fix the deploy pipeline for staging', 'Fix the deploy pipeline…'), 'Codex ellipsis truncation');
  assert.ok(titleMatchesLabel('Fix  the deploy\npipeline', 'fix the deploy pipeline'), 'whitespace and case');
  assert.ok(!titleMatchesLabel('Fix', 'Fix the deploy'), 'a short prefix is not evidence');
  assert.ok(titleMatchesLabel('Fix the deploy pipeline', 'Fix the deploy pipeline for prod, then dev'), 'our cleaned title may be the shorter side');
  assert.ok(!titleMatchesLabel('Fix the deploy pipeline', 'Fix the deployment now'), 'sharing a prefix is not a match');
});
