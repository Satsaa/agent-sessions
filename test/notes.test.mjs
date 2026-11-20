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
const { runCommand, sessionOf, readNotes, notesFile, noteCounts, updateNotes, setStale, setTaskState, answerQuestion, removeNote, markAnswerRead, NoteError, installNotes, uninstallNotes, notesInstalled, notesOutdated, hookText, hookSession } = createRequire(import.meta.url)(bundle);
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

test('a question of the user’s is recorded, answered, read and marked stale, and counts on its row until it is read', () => {
  const file = notesFile(join(directory, 'a'), 'claude', 's1');
  assert.match(runCommand(file, ['task', 'add', 'Create', 'v2', 'phone', 'engine'], noStdin), /^t1 added/);
  assert.match(runCommand(file, ['ask', 'add', '-'], () => 'Does it "handle" barge-in?\n'), /^a2 added/);
  assert.deepEqual(noteCounts(readNotes(file)), { tasksOpen: 1, tasksDone: 0, answersOpen: 1, answersUnread: 0, questionsOpen: 0 });
  assert.equal(readNotes(file).answers[0].text, 'Does it "handle" barge-in?', 'a text on standard input keeps its quotes');

  runCommand(file, ['ask', 'write', 'a2', '-'], () => 'Yes.\n\nThe reply is cut like a barge-in.');
  assert.deepEqual(noteCounts(readNotes(file)), { tasksOpen: 1, tasksDone: 0, answersOpen: 0, answersUnread: 1, questionsOpen: 0 }, 'an answer nobody opened is what the row counts');
  updateNotes(file, (n) => markAnswerRead(n, 'a2'));
  assert.equal(noteCounts(readNotes(file)).answersUnread, 0);
  runCommand(file, ['ask', 'write', 'a2', 'Yes,', 'and', 'the', 'call', 'ends', 'after', 'three.'], noStdin);
  assert.equal(noteCounts(readNotes(file)).answersUnread, 1, 'a new answer is unread again');

  runCommand(file, ['ask', 'stale', 'a2'], noStdin);
  assert.deepEqual([readNotes(file).answers[0].state, noteCounts(readNotes(file)).answersUnread], ['stale', 0], 'a stale answer counts nowhere');
  updateNotes(file, (n) => setStale(n, 'answer', 'a2', false));
  assert.equal(readNotes(file).answers[0].state, 'answered', 'reopened, it is where it was: answered, with its answer');

  assert.throws(() => runCommand(file, ['task', 'done', 't1'], noStdin), /what was delivered/, 'a task is closed with what there is to say of it');
  runCommand(file, ['task', 'done', 't1', 'The', 'cascade', 'engine,', 'behind', 'the', 'phoneV2', 'switch.'], noStdin);
  assert.deepEqual([readNotes(file).tasks[0].state, readNotes(file).tasks[0].resolution], ['done', 'The cascade engine, behind the phoneV2 switch.']);
  assert.match(runCommand(file, ['list'], noStdin), /t1 \[done\] Create v2 phone engine\nAnswers \(the user's questions\)\n {2}a2 \[answered\]/);
  assert.throws(() => runCommand(file, ['task', 'done', 't9', 'x'], noStdin), /no task t9 in this session \(it has t1\)/);
  assert.throws(() => runCommand(file, ['task', 'drop', 't1'], noStdin), /why the task was abandoned/);
  runCommand(file, ['task', 'drop', 't1', '-'], () => 'Replaced by the vendor’s engine.');
  assert.deepEqual([readNotes(file).tasks[0].state, noteCounts(readNotes(file)).tasksDone], ['dropped', 0], 'a dropped task stays listed with why, and counts nowhere');
  updateNotes(file, (n) => setTaskState(n, 't1', 'open'));
  assert.equal(readNotes(file).tasks[0].resolution, undefined, 'reopened, it has no resolution');
  assert.throws(() => runCommand(file, ['ask', 'add'], noStdin), NoteError);
  assert.throws(() => runCommand(file, ['tasks'], noStdin), /agent-sessions task add/, 'an unknown command prints the usage');
});

test('a question asked of the user waits for them until they answer it, and counts on the row meanwhile', () => {
  const file = notesFile(join(directory, 'asked'), 'claude', 's5');
  assert.match(runCommand(file, ['ask-user', 'add', 'Keep', 'the', 'old', 'engine?'], noStdin), /^q1 added/);
  assert.equal(noteCounts(readNotes(file)).questionsOpen, 1);
  assert.match(hookText('prompt', readNotes(file)), /question q1 \(waiting for the user\): Keep the old engine\?/);
  assert.throws(() => runCommand(file, ['ask-user', 'answered', 'q1'], noStdin), /what the user answered/, 'the agent records what the user said');
  runCommand(file, ['ask-user', 'answered', 'q1', 'No,', 'remove', 'it.'], noStdin);
  assert.deepEqual([readNotes(file).questions[0].state, readNotes(file).questions[0].answer, noteCounts(readNotes(file)).questionsOpen], ['answered', 'No, remove it.', 0]);
  runCommand(file, ['ask-user', 'add', 'Which board?'], noStdin);
  updateNotes(file, (n) => answerQuestion(n, 'q2'));
  assert.deepEqual([readNotes(file).questions[1].state, readNotes(file).questions[1].answer], ['answered', undefined], 'a person marking it answered in the view says nothing');
  runCommand(file, ['ask-user', 'add', 'Ship today?'], noStdin);
  runCommand(file, ['ask-user', 'stale', 'q3'], noStdin);
  updateNotes(file, (n) => setStale(n, 'question', 'q3', false));
  assert.equal(readNotes(file).questions[2].state, 'open', 'reopened, an unanswered question waits again');
});

test('a note’s priority is set on its row, listed beside it, and normal is stored as nothing', () => {
  const file = notesFile(join(directory, 'priority'), 'claude', 's7');
  runCommand(file, ['task', 'add', 'Tidy', 'the', 'logs'], noStdin);
  runCommand(file, ['ask', 'add', 'Why', 'is', 'it', 'slow?'], noStdin);
  runCommand(file, ['ask-user', 'add', 'Ship', 'today?'], noStdin);
  assert.equal(runCommand(file, ['task', 'priority', 't1', 'low'], noStdin), 't1 priority low');
  runCommand(file, ['ask', 'priority', 'a2', 'high'], noStdin);
  runCommand(file, ['ask-user', 'priority', 'q3', 'high'], noStdin);
  const notes = readNotes(file);
  assert.deepEqual([notes.tasks[0].priority, notes.answers[0].priority, notes.questions[0].priority], ['low', 'high', 'high']);
  assert.match(runCommand(file, ['list'], noStdin), /t1 \[open\] \(low priority\) Tidy the logs/, 'the list says a priority other than normal');
  runCommand(file, ['task', 'priority', 't1', 'normal'], noStdin);
  assert.equal('priority' in readNotes(file).tasks[0], false, 'normal is the default and is not stored');
  assert.throws(() => runCommand(file, ['task', 'priority', 't1', 'urgent'], noStdin), /one of low, normal, high/);
  assert.throws(() => runCommand(file, ['ask', 'priority', 't1', 'low'], noStdin), /no answer t1/, 'an id of another kind is refused');
});

test('a file from before answers had their name keeps the user’s questions as answers, and earlier sessions’ commands still land', async () => {
  const dir = join(directory, 'legacy');
  const file = notesFile(dir, 'claude', 's6');
  await mkdir(dir, { recursive: true });
  await writeFile(file, JSON.stringify({ seq: 2, tasks: [{ id: 't1', text: 'Port it', state: 'open', at: 1 }], questions: [{ id: 'q2', text: 'Is it fast?', state: 'open', at: 2 }] }));
  assert.deepEqual([readNotes(file).answers.map((a) => a.id), readNotes(file).questions.length], [['q2'], 0], 'the stored questions are the user’s own');
  runCommand(file, ['question', 'answer', 'q2', 'Yes.'], noStdin);
  assert.equal(readNotes(file).answers[0].answer, 'Yes.', 'a session told to answer with `question answer` still answers');
  runCommand(file, ['question', 'stale', 'q2'], noStdin);
  assert.equal(readNotes(file).answers[0].state, 'stale', '`question stale` finds the answer by its id');
  runCommand(file, ['question', 'add', 'Merge now?'], noStdin);
  const raw = JSON.parse(await readFile(file, 'utf8'));
  assert.deepEqual([raw.questions.map((x) => x.id), raw.asked.map((x) => x.id)], [['q2'], ['q3']], 'a window still running an earlier version finds the user’s questions where they were');
  runCommand(file, ['answer', 'add', 'Old name?'], noStdin);
  runCommand(file, ['answer', 'write', 'a4', 'Yes.'], noStdin);
  runCommand(file, ['question', 'answered', 'q3', 'No.'], noStdin);
  assert.deepEqual([readNotes(file).answers[1].answer, readNotes(file).questions[0].answer], ['Yes.', 'No.'], 'a session told `answer` and `question` before they became `ask` and `ask-user` still records');
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
  runCommand(file, ['ask', 'add', 'Does it record calls?'], noStdin);
  runCommand(file, ['ask-user', 'add', 'Remove the old engine?'], noStdin);
  assert.throws(() => runCommand(file, done, noStdin), /t1 "Create v2 phone engine", a2 "Does it record calls\?", q3 "Remove the old engine\?" are still open/, 'an open task, an unanswered question and one waiting for the user all hold it');
  runCommand(file, ['task', 'done', 't1', 'merged'], noStdin);
  runCommand(file, ['ask', 'stale', 'a2'], noStdin);
  runCommand(file, ['ask-user', 'answered', 'q3', 'yes'], noStdin);
  assert.throws(() => runCommand(file, ['done', '--features', 'x', '--tickets', 'none'], noStdin), /--cleanup is missing/, 'every part is said, none included');
  assert.equal(runCommand(file, done, noStdin), 'session marked done');
  assert.deepEqual({ ...readNotes(file).done, at: 0 }, { at: 0, features: 'v2 engine merged to dev', tickets: '#12 implemented', cleanup: 'worktree removed' });
  assert.match(runCommand(file, ['list'], noStdin), /Session done\n  features: v2 engine merged to dev/);
  runCommand(file, ['task', 'add', 'One more thing'], noStdin);
  assert.equal(readNotes(file).done, undefined, 'a new task reopens the session');
  runCommand(file, ['task', 'drop', 't4', 'not needed'], noStdin);
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
  runCommand(file, ['ask', 'add', 'Does it record calls?'], noStdin);
  runCommand(file, ['ask', 'write', 'a2', 'Yes.'], noStdin);
  const prompt = hookText('prompt', readNotes(file));
  assert.match(prompt, /task t1: Create v2 phone engine/);
  assert.doesNotMatch(prompt, /a2/, 'an answered question is no longer owed');
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
  for (const skill of ['ask', 'ask-user', 'task', 'done']) assert.match(await readFile(`plugin/skills/${skill}/SKILL.md`, 'utf8'), new RegExp(`^---\\nname: ${skill}\\n[\\s\\S]*~/\\.agent-sessions/bin/agent-sessions`));
});

test('a session is tagged with what it is about, one tag per key and value whatever its case', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'notes-tags-'));
  const file = notesFile(dir, 'claude', 'tagged');
  assert.equal(runCommand(file, ['tag', 'add', 'Tenant:', 'Kouvolan', 'Lakritsi'], noStdin), 'tagged tenant:Kouvolan Lakritsi', 'the key is lower-cased and the value keeps its case');
  assert.equal(runCommand(file, ['tag', 'add', 'tenant:kouvolan lakritsi'], noStdin), 'already tagged', 'the same tag in another case is not added twice');
  runCommand(file, ['tag', 'add', 'area:widget'], noStdin);
  assert.deepEqual(readNotes(file).tags, ['tenant:Kouvolan Lakritsi', 'area:widget']);
  assert.match(runCommand(file, ['list'], noStdin), /^Tags: tenant:Kouvolan Lakritsi, area:widget/, 'list shows the tags first');
  assert.throws(() => runCommand(file, ['tag', 'remove', 'area:phone'], noStdin), /no tag area:phone \(it has tenant:Kouvolan Lakritsi, area:widget\)/);
  runCommand(file, ['tag', 'remove', 'area:widget'], noStdin);
  runCommand(file, ['tag', 'remove', 'tenant:Kouvolan Lakritsi'], noStdin);
  assert.equal(existsSync(file), false, 'a file left with nothing in it is removed');
});

test('a session’s status is set and cleared by its agent, and done replaces it', () => {
  const file = notesFile(directory, 'claude', 'status-session');
  assert.equal(runCommand(file, ['status', 'partial', 'the UI is in; the deploy is left'], noStdin), 'status partial');
  assert.deepEqual({ ...readNotes(file).status, at: 0 }, { state: 'partial', text: 'the UI is in; the deploy is left', at: 0 });
  assert.match(runCommand(file, ['list'], noStdin), /^Status: partial: the UI is in/, 'the list says the status first');
  assert.throws(() => runCommand(file, ['status', 'done'], noStdin), NoteError, 'done is the done command, which checks nothing is left open');
  runCommand(file, ['status', 'attention', 'the deploy went red'], noStdin);
  assert.equal(readNotes(file).status.state, 'attention');
  runCommand(file, ['done', '--features', 'x', '--tickets', 'none', '--cleanup', 'none'], noStdin);
  assert.equal(readNotes(file).status, undefined, 'marking the session done replaces its status');
  runCommand(file, ['status', 'partial', 'one more thing'], noStdin);
  assert.equal(readNotes(file).done, undefined, 'a status takes done away');
  runCommand(file, ['status', 'clear'], noStdin);
  assert.equal(existsSync(file), false, 'a file with nothing left in it goes');
});

test('a note’s title is what it is about in three words at most, listed before its text', () => {
  const file = notesFile(join(directory, 'titles'), 'claude', 's8');
  assert.equal(runCommand(file, ['task', 'add', '--title', 'Agent Sessions', 'Show titles before notes'], noStdin), 't1 added');
  runCommand(file, ['ask-user', 'add', 'Which', 'colour?', '--title', 'Status bar'], noStdin);
  runCommand(file, ['ask', 'add', 'Untitled question'], noStdin);
  const notes = readNotes(file);
  assert.deepEqual([notes.tasks[0].title, notes.questions[0].title, 'title' in notes.answers[0]], ['Agent Sessions', 'Status bar', false]);
  const list = runCommand(file, ['list'], noStdin);
  assert.match(list, /t1 \[open\] Agent Sessions: Show titles before notes/, 'the list reads <title>: <text>');
  assert.match(list, /q2 \[waiting for the user\] Status bar: Which colour\?/, '--title may come after the text');
  assert.match(list, /a3 \[open\] Untitled question/, 'a note without a title reads as before');
  assert.match(hookText('prompt', notes), /task t1: Agent Sessions: Show titles before notes/, 'the prompt hook lists the title too');
  assert.throws(() => runCommand(file, ['task', 'add', '--title', 'One two three four', 'x'], noStdin), /longer than 3 words/);
  assert.throws(() => runCommand(file, ['task', 'add', '--title', 'Extraordinarily-long-hyphenated-title', 'x'], noStdin), /longer than 30 characters/);
  assert.throws(() => runCommand(file, ['task', 'done', 't1', '--title', 'X', 'done'], noStdin), /only when adding/);
});
