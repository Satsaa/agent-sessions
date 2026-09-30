import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import { mkdtemp, rm, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { build } from 'esbuild';

const require = createRequire(import.meta.url);
const directory = await mkdtemp(join(tmpdir(), 'agent-sessions-markers-test-'));
process.env.HOME = directory;
const bundle = join(directory, 'markers.cjs');
await build({ stdin: { contents: `export * from './src/claude.ts'; export * from './src/markers.ts';`, resolveDir: process.cwd() }, bundle: true, platform: 'node', format: 'cjs', outfile: bundle, external: ['vscode', 'node:sqlite'] });
const { listClaudeSessions, parentMarker, withMarkedParents } = require(bundle);
after(() => rm(directory, { recursive: true, force: true }));

const manifest = JSON.parse(await readFile('package.json', 'utf8'));
const defaultMarker = parentMarker(manifest.contributes.configuration.properties['agentSessions.parentSessionMarker'].default);
const CODEX_PARENT = '019a0000-1111-7222-8333-444444444444';

test('a session whose first prompt carries a marker is the named session’s subagent, across tools', async () => {
  const home = join(directory, 'claude');
  const project = join(home, 'projects', '-tmp-work');
  await mkdir(project, { recursive: true });
  const child = '11111111-2222-4333-8444-555555555555';
  const person = '66666666-7777-4888-8999-000000000000';
  const prompt = (id, text) => JSON.stringify({ type: 'user', uuid: `u-${id}`, timestamp: '2026-09-30T10:00:00Z', cwd: '/tmp/work', message: { role: 'user', content: text } }) + '\n';
  await writeFile(join(project, `${child}.jsonl`), prompt(child, `<parent-session>codex:${CODEX_PARENT}</parent-session>\n\nFix the flaky test`));
  await writeFile(join(project, `${person}.jsonl`), prompt(person, 'Fix the flaky test'));

  const sessions = withMarkedParents(await listClaudeSessions(home), defaultMarker);
  const delegated = sessions.find((s) => s.id === child);
  assert.equal(delegated.subagent, true, 'the default pattern recognises the documented marker form');
  assert.equal(delegated.parentId, CODEX_PARENT);
  assert.equal(delegated.parentTool, 'codex', 'the marker’s tool group names the parent’s tool, not the child’s');
  assert.equal(delegated.title, 'Fix the flaky test', 'a tag-wrapped marker stays out of the title');
  const own = sessions.find((s) => s.id === person);
  assert.equal(own.subagent, false, 'a prompt without a marker is a person’s session');
});

test('the marker names only what the tool did not already record, and an unusable pattern turns detection off', () => {
  const base = { tool: 'claude', subagent: false, parentId: undefined, agentRole: undefined };
  const native = { ...base, id: 'a', subagent: true, parentId: 'recorded', promptHead: `<parent-session>codex:${CODEX_PARENT}</parent-session>` };
  assert.equal(withMarkedParents([native], defaultMarker)[0].parentId, 'recorded', 'a tool’s own spawn record wins over a marker');
  const untyped = withMarkedParents([{ ...base, id: 'b', promptHead: 'parent=p1 role=reviewer' }], parentMarker('parent=(?<id>\\S+) role=(?<role>\\S+)'))[0];
  assert.deepEqual([untyped.parentId, untyped.parentTool, untyped.agentRole], ['p1', 'claude', 'reviewer'], 'without a tool group the parent is the child’s own tool');
  assert.equal(parentMarker('(unclosed'), undefined, 'an invalid pattern detects nothing rather than failing the listing');
  assert.equal(parentMarker(''), undefined, 'an empty pattern turns detection off');
});
