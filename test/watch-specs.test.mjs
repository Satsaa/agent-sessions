import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { build } from 'esbuild';

const require = createRequire(import.meta.url);
const directory = await mkdtemp(join(tmpdir(), 'agent-sessions-watch-test-'));
process.env.HOME = directory;
const bundle = join(directory, 'lists.cjs');
await build({ stdin: { contents: `export { claudeWatchPaths } from './src/claude.ts'; export { codexWatchPaths } from './src/codex.ts';`, resolveDir: process.cwd() }, bundle: true, platform: 'node', format: 'cjs', outfile: bundle, external: ['vscode', 'node:sqlite'] });
const { claudeWatchPaths, codexWatchPaths } = require(bundle);
after(() => rm(directory, { recursive: true, force: true }));

/** Whether a change to `relative` (under `home`) wakes the list, as extension.ts applies the specs. */
function wakes(specs, home, relative) {
  const file = join(home, relative);
  return specs.some((s) => {
    const inside = s.recursive ? file.startsWith(s.path + '/') : file.slice(0, file.lastIndexOf('/')) === s.path;
    return inside && (!s.accept || s.accept(file.slice(file.lastIndexOf('/') + 1)));
  });
}

test('Codex’s busy databases do not wake the list; what it reads does', () => {
  const home = '/h/.codex';
  const specs = codexWatchPaths(home);
  for (const quiet of ['logs_2.sqlite-wal', 'thread_history_1.sqlite-shm', 'models_cache.json', 'packages/standalone/current/bin/codex', 'log/codex-tui.log']) {
    assert.equal(wakes(specs, home, quiet), false, `${quiet} changes without changing any thread`);
  }
  for (const read of ['session_index.jsonl', 'state_5.sqlite-wal', 'sessions/2026/09/25/rollout-x.jsonl', 'archived_sessions/rollout-y.jsonl', 'thread-writer-locks/abc.lock']) {
    assert.equal(wakes(specs, home, read), true, `${read} is what the Codex list is built from`);
  }
});

test('Claude’s key files and tool results do not wake the list; transcripts and live files do', () => {
  const home = '/h/.claude';
  const specs = claudeWatchPaths(home);
  for (const quiet of ['sessions/123.abc.key', 'sessions/123.abc.key.tmp.1', 'projects/p/id/tool-results/out.txt']) {
    assert.equal(wakes(specs, home, quiet), false, `${quiet} says nothing about a session`);
  }
  for (const read of ['sessions/123.json', 'projects/p/id.jsonl', 'projects/p/id/subagents/agent-a.jsonl', 'projects/p/id/subagents/agent-a.meta.json', 'projects/p/id/custom-title.json']) {
    assert.equal(wakes(specs, home, read), true, `${read} is what the Claude list is built from`);
  }
});
