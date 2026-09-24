import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { build } from 'esbuild';

const require = createRequire(import.meta.url);
const directory = await mkdtemp(join(tmpdir(), 'agent-sessions-subagents-test-'));
// The session listings cache what they read under the home folder (file-cache.ts); a test's own stays in its directory.
process.env.HOME = directory;
const bundle = join(directory, 'claude.cjs');
await build({ stdin: { contents: `export * from './src/claude.ts';`, resolveDir: process.cwd() }, bundle: true, platform: 'node', format: 'cjs', outfile: bundle, external: ['vscode', 'node:sqlite'] });
const { listClaudeSessions } = require(bundle);
after(() => rm(directory, { recursive: true, force: true }));

const record = (role, text, at) => JSON.stringify({ type: role, uuid: `${role}-${at}`, isSidechain: true, timestamp: at, cwd: '/tmp/work', message: { role, content: text } });

test('a session’s subagents and teammates are listed under it, named from their meta files', async () => {
  const home = join(directory, 'claude');
  const project = join(home, 'projects', '-tmp-work');
  const id = '11111111-2222-4333-8444-555555555555';
  const subagents = join(project, id, 'subagents');
  await mkdir(subagents, { recursive: true });
  await writeFile(join(project, `${id}.jsonl`), JSON.stringify({ type: 'user', uuid: 'u1', timestamp: '2026-09-01T10:00:00Z', cwd: '/tmp/work', message: { role: 'user', content: 'main prompt' } }) + '\n');
  await writeFile(join(subagents, 'agent-abc.jsonl'), [record('user', 'find the thing', '2026-09-01T10:01:00Z'), record('assistant', 'found it', '2026-09-01T10:02:00Z')].join('\n') + '\n');
  await writeFile(join(subagents, 'agent-abc.meta.json'), JSON.stringify({ agentType: 'Explore', description: 'Find the thing', spawnDepth: 1 }));
  await writeFile(join(subagents, 'agent-deploy-1.jsonl'), record('user', 'you are a teammate', '2026-09-01T10:03:00Z') + '\n');
  await writeFile(join(subagents, 'agent-deploy-1.meta.json'), JSON.stringify({ agentType: 'general-purpose', description: 'Deployment speedups', name: 'deploy-speedups', taskKind: 'in_process_teammate' }));

  const sessions = await listClaudeSessions(home);
  const parent = sessions.find((s) => s.id === id);
  assert.ok(parent && !parent.subagent && parent.parentId === undefined, 'the spawning session is a row of its own');
  assert.equal(parent.title, 'main prompt', 'sidechain records do not leak into the parent');

  const sub = sessions.find((s) => s.id === 'abc');
  assert.ok(sub, 'the subagent transcript is listed');
  assert.equal(sub.parentId, id, 'a subagent points at the session whose folder holds it');
  assert.equal(sub.subagent, true);
  assert.equal(sub.title, 'Find the thing', 'a subagent is named by its task description');
  assert.equal(sub.agentRole, 'Explore', 'its agent type is its role');
  assert.equal(sub.state, 'stopped', 'a subagent of a stopped session is stopped');

  const mate = sessions.find((s) => s.id === 'deploy-1');
  assert.equal(mate?.title, 'deploy-speedups', 'a teammate is named by its team name, not its description');
  assert.equal(mate?.agentRole, 'teammate');
  assert.equal(mate?.parentId, id);
});
