import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import { mkdtemp, rm, readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { build } from 'esbuild';

const directory = await mkdtemp(join(tmpdir(), 'agent-sessions-notes-test-'));
const bundle = join(directory, 'notes.cjs');
await build({
  stdin: { contents: `export * from './src/notes.ts'; export * from './src/notes-cli.ts'; export * from './src/notes-install.ts';`, resolveDir: process.cwd() },
  bundle: true, platform: 'node', format: 'cjs', outfile: bundle,
});
const { runCommand, sessionOf, readNotes, notesFile, noteCounts, updateNotes, setQuestionStale, setTaskState, removeNote, markAnswerRead, NoteError, installNotes, uninstallNotes, notesInstalled, notesOutdated, hookText, hookSession } = createRequire(import.meta.url)(bundle);
after(() => rm(directory, { recursive: true, force: true }));
const noStdin = () => { throw new Error('standard input was not expected'); };

test('the command names its session from the variables each tool gives its shell', () => {
  assert.deepEqual(sessionOf({ CLAUDE_CODE_SESSION_ID: 'c1' }, undefined), { tool: 'claude', id: 'c1' });
  assert.deepEqual(sessionOf({ CODEX_THREAD_ID: 'x1' }, undefined), { tool: 'codex', id: 'x1' });
  const both = { CLAUDE_CODE_SESSION_ID: 'c1', CODEX_THREAD_ID: 'x1' };
  assert.deepEqual(sessionOf(both, undefined, () => 'codex'), { tool: 'codex', id: 'x1' }, 'an agent started from the other tool’s shell inherits both: the nearer tool is the one asking');
  assert.deepEqual(sessionOf(both, undefined, () => 'claude'), { tool: 'claude', id: 'c1' });
  assert.throws(() => sessionOf(both, undefined, () => undefined), NoteError, 'a session is never guessed');
  assert.throws(() => sessionOf({}, undefined), NoteError);
  assert.deepEqual(sessionOf(both, 'codex:other'), { tool: 'codex', id: 'other' }, '--session wins');
});

test('a question is asked, answered, read and marked stale, and counts on its row until it is read', () => {
  const file = notesFile(join(directory, 'a'), 'claude', 's1');
  assert.match(runCommand(file, ['task', 'add', 'Create', 'v2', 'phone', 'engine'], noStdin), /^t1 added/);
  assert.match(runCommand(file, ['question', 'add', '-'], () => 'Does it "handle" barge-in?\n'), /^q2 added/);
  assert.deepEqual(noteCounts(readNotes(file)), { tasksOpen: 1, tasksDone: 0, questionsOpen: 1, answersUnread: 0 });
  assert.equal(readNotes(file).questions[0].text, 'Does it "handle" barge-in?', 'a text on standard input keeps its quotes');

  runCommand(file, ['question', 'answer', 'q2', '-'], () => 'Yes.\n\nThe reply is cut like a barge-in.');
  assert.deepEqual(noteCounts(readNotes(file)), { tasksOpen: 1, tasksDone: 0, questionsOpen: 0, answersUnread: 1 }, 'an answer nobody opened is what the row counts');
  updateNotes(file, (n) => markAnswerRead(n, 'q2'));
  assert.equal(noteCounts(readNotes(file)).answersUnread, 0);
  runCommand(file, ['question', 'answer', 'q2', 'Yes,', 'and', 'the', 'call', 'ends', 'after', 'three.'], noStdin);
  assert.equal(noteCounts(readNotes(file)).answersUnread, 1, 'a new answer is unread again');

  runCommand(file, ['question', 'stale', 'q2'], noStdin);
  assert.deepEqual([readNotes(file).questions[0].state, noteCounts(readNotes(file)).answersUnread], ['stale', 0], 'a stale question counts nowhere');
  updateNotes(file, (n) => setQuestionStale(n, 'q2', false));
  assert.equal(readNotes(file).questions[0].state, 'answered', 'reopened, it is where it was: answered, with its answer');

  assert.throws(() => runCommand(file, ['task', 'done', 't1'], noStdin), /what was delivered/, 'a task is closed with what there is to say of it');
  runCommand(file, ['task', 'done', 't1', 'The', 'cascade', 'engine,', 'behind', 'the', 'phoneV2', 'switch.'], noStdin);
  assert.deepEqual([readNotes(file).tasks[0].state, readNotes(file).tasks[0].resolution], ['done', 'The cascade engine, behind the phoneV2 switch.']);
  assert.match(runCommand(file, ['list'], noStdin), /t1 \[done\] Create v2 phone engine\nQuestions\n {2}q2 \[answered\]/);
  assert.throws(() => runCommand(file, ['task', 'done', 't9', 'x'], noStdin), /no task t9 in this session \(it has t1\)/);
  assert.throws(() => runCommand(file, ['task', 'drop', 't1'], noStdin), /why the task was abandoned/);
  runCommand(file, ['task', 'drop', 't1', '-'], () => 'Replaced by the vendor’s engine.');
  assert.deepEqual([readNotes(file).tasks[0].state, noteCounts(readNotes(file)).tasksDone], ['dropped', 0], 'a dropped task stays listed with why, and counts nowhere');
  updateNotes(file, (n) => setTaskState(n, 't1', 'open'));
  assert.equal(readNotes(file).tasks[0].resolution, undefined, 'reopened, it has no resolution');
  assert.throws(() => runCommand(file, ['question', 'add'], noStdin), NoteError);
  assert.throws(() => runCommand(file, ['tasks'], noStdin), /agent-sessions task add/, 'an unknown command prints the usage');
});

test('a removed note’s id is not given to the next one, and an emptied file goes', () => {
  const file = notesFile(join(directory, 'b'), 'codex', 's2');
  runCommand(file, ['task', 'add', 'one'], noStdin);
  runCommand(file, ['task', 'add', 'two'], noStdin);
  updateNotes(file, (n) => removeNote(n, 'task', 't2'));
  assert.match(runCommand(file, ['task', 'add', 'three'], noStdin), /^t3 /, 'an agent holding t2 must not close another task with it');
  updateNotes(file, (n) => removeNote(n, 'task', 't1'));
  updateNotes(file, (n) => removeNote(n, 'task', 't3'));
  assert.equal(existsSync(file), false);
});

test('a session is marked done with its features, tickets and cleanup, never with anything open', () => {
  const file = notesFile(join(directory, 'done'), 'claude', 's3');
  const done = ['done', '--features', 'v2 engine merged to dev', '--tickets', '#12 implemented', '--cleanup', 'worktree', 'removed'];
  runCommand(file, ['task', 'add', 'Create v2 phone engine'], noStdin);
  runCommand(file, ['question', 'add', 'Does it record calls?'], noStdin);
  assert.throws(() => runCommand(file, done, noStdin), /t1 "Create v2 phone engine", q2 "Does it record calls\?" are still open/, 'an open task and an unanswered question both hold it');
  runCommand(file, ['task', 'done', 't1', 'merged'], noStdin);
  runCommand(file, ['question', 'stale', 'q2'], noStdin);
  assert.throws(() => runCommand(file, ['done', '--features', 'x', '--tickets', 'none'], noStdin), /--cleanup is missing/, 'every part is said, none included');
  assert.equal(runCommand(file, done, noStdin), 'session marked done');
  assert.deepEqual({ ...readNotes(file).done, at: 0 }, { at: 0, features: 'v2 engine merged to dev', tickets: '#12 implemented', cleanup: 'worktree removed' });
  assert.match(runCommand(file, ['list'], noStdin), /Session done\n  features: v2 engine merged to dev/);
  runCommand(file, ['task', 'add', 'One more thing'], noStdin);
  assert.equal(readNotes(file).done, undefined, 'a new task reopens the session');
  runCommand(file, ['task', 'drop', 't3', 'not needed'], noStdin);
  runCommand(file, done, noStdin);
  assert.equal(runCommand(file, ['reopen'], noStdin), 'session reopened');
  assert.equal(readNotes(file).done, undefined);
});

test('the hooks tell a session the rules when it starts and afterwards only what it still owes', () => {
  const file = notesFile(join(directory, 'hook'), 'claude', 's4');
  assert.match(hookText('session-start', readNotes(file)), /not optional/, 'the instructions are assertive: recording is not left to the agent’s mood');
  assert.doesNotMatch(hookText('session-start', readNotes(file)), /Recorded for this session/);
  assert.equal(hookText('prompt', readNotes(file)), '', 'a session with nothing open is told nothing more with each prompt');
  runCommand(file, ['task', 'add', 'Create v2 phone engine'], noStdin);
  runCommand(file, ['question', 'add', 'Does it record calls?'], noStdin);
  runCommand(file, ['question', 'answer', 'q2', 'Yes.'], noStdin);
  const prompt = hookText('prompt', readNotes(file));
  assert.match(prompt, /task t1: Create v2 phone engine/);
  assert.doesNotMatch(prompt, /q2/, 'an answered question is no longer owed');
  assert.match(hookText('session-start', readNotes(file)), /Recorded for this session so far:\nTasks\n  t1 \[open\]/, 'a resumed or compacted session gets back what it recorded');

  assert.deepEqual(hookSession(JSON.stringify({ session_id: 'abc', transcript_path: '/home/x/.codex/sessions/r.jsonl' }), {}, () => undefined), { tool: 'codex', id: 'abc' });
  assert.deepEqual(hookSession(JSON.stringify({ session_id: 'abc', transcript_path: '/home/x/.claude/projects/p/abc.jsonl' }), {}, () => undefined), { tool: 'claude', id: 'abc' });
  assert.deepEqual(hookSession('', { CODEX_THREAD_ID: 't' }, () => undefined), { tool: 'codex', id: 't' });
  assert.equal(hookSession('', {}, () => undefined), undefined, 'a hook with no session says nothing rather than failing it');
});

test('the plugin is installed through each tool’s own commands, and what earlier versions wrote is taken back', async () => {
  const claudeHome = join(directory, 'claude');
  const codexHome = join(directory, 'codex');
  const paths = { claudeHome, codexHome, shipped: process.cwd(), marketplace: join(directory, 'marketplace') };
  await mkdir(join(claudeHome, 'commands'), { recursive: true });
  await mkdir(codexHome, { recursive: true });
  await writeFile(join(claudeHome, 'CLAUDE.md'), '# Mine\n\nKeep this.\n\n<!-- agent-sessions:notes:start (written by the Agent Sessions extension; edits here are replaced) -->\nold\n<!-- agent-sessions:notes:end -->\n');
  await writeFile(join(codexHome, 'AGENTS.md'), '<!-- agent-sessions:notes:start (written by the Agent Sessions extension; edits here are replaced) -->\nold\n<!-- agent-sessions:notes:end -->\n');
  await writeFile(join(claudeHome, 'commands', 'question.md'), '<!-- agent-sessions:notes -->\nold\n');
  await writeFile(join(claudeHome, 'commands', 'task.md'), 'my own /task\n');
  assert.equal(notesInstalled(paths), false);

  const ran = [];
  const run = async (tool, args) => {
    ran.push(`${tool} ${args.join(' ')}`);
    if (tool === 'codex') throw new Error('codex: not found');
    return '';
  };
  assert.deepEqual(await installNotes(paths, run), { failed: [{ tool: 'codex', reason: 'codex: not found' }] }, 'a tool that is not here is reported, and the other is still installed');
  assert.deepEqual(ran, [`claude plugin marketplace add ${paths.marketplace}`, 'claude plugin install agent-sessions@agent-sessions', `codex plugin marketplace add ${paths.marketplace}`]);
  assert.equal(notesInstalled(paths), true);
  assert.equal(notesOutdated(paths), false);
  assert.equal(await readFile(join(claudeHome, 'CLAUDE.md'), 'utf8'), '# Mine\n\nKeep this.\n', 'the instruction block of earlier versions is gone, a person’s text kept');
  assert.equal(existsSync(join(codexHome, 'AGENTS.md')), false);
  assert.equal(existsSync(join(claudeHome, 'commands', 'question.md')), false);
  assert.equal(await readFile(join(claudeHome, 'commands', 'task.md'), 'utf8'), 'my own /task\n');

  const manifest = join(paths.marketplace, 'plugin', '.claude-plugin', 'plugin.json');
  await writeFile(manifest, (await readFile(manifest, 'utf8')).replace(/"version": "[^"]+"/, '"version": "0.0.1"'));
  assert.equal(notesOutdated(paths), true, 'an extension update brings its plugin along');

  await uninstallNotes(paths, async () => '');
  assert.equal(notesInstalled(paths), false);
});

test('the plugin carries the extension’s version, names the command at its fixed path, and its hooks call it', async () => {
  const json = async (file) => JSON.parse(await readFile(file, 'utf8'));
  const version = (await json('package.json')).version;
  assert.equal((await json('plugin/.claude-plugin/plugin.json')).version, version, 'an installed plugin is refreshed when its version differs from the shipped one');
  assert.equal((await json('plugin/.codex-plugin/plugin.json')).version, version);
  for (const market of ['.claude-plugin/marketplace.json', '.agents/plugins/marketplace.json']) assert.equal((await json(market)).name, 'agent-sessions');
  const hooks = (await json('plugin/hooks/hooks.json')).hooks;
  assert.match(hooks.SessionStart[0].hooks[0].command, /\.agent-sessions\/bin\/agent-sessions.*hook session-start/);
  assert.match(hooks.UserPromptSubmit[0].hooks[0].command, /hook prompt/);
  for (const skill of ['question', 'task', 'done']) assert.match(await readFile(`plugin/skills/${skill}/SKILL.md`, 'utf8'), new RegExp(`^---\\nname: ${skill}\\n[\\s\\S]*~/\\.agent-sessions/bin/agent-sessions`));
});
