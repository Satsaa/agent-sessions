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
const { runCommand, sessionOf, readNotes, notesFile, noteCounts, updateNotes, setQuestionStale, markAnswerRead, NoteError, installNotes, uninstallNotes, notesInstalled } = createRequire(import.meta.url)(bundle);
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

  runCommand(file, ['task', 'done', 't1'], noStdin);
  assert.match(runCommand(file, ['list'], noStdin), /t1 \[done\] Create v2 phone engine\nQuestions\n {2}q2 \[answered\]/);
  assert.throws(() => runCommand(file, ['task', 'done', 't9'], noStdin), /no task t9 in this session \(it has t1\)/);
  assert.throws(() => runCommand(file, ['question', 'add'], noStdin), NoteError);
  assert.throws(() => runCommand(file, ['tasks'], noStdin), /agent-sessions task add/, 'an unknown command prints the usage');
});

test('a removed note’s id is not given to the next one, and an emptied file goes', () => {
  const file = notesFile(join(directory, 'b'), 'codex', 's2');
  runCommand(file, ['task', 'add', 'one'], noStdin);
  runCommand(file, ['task', 'add', 'two'], noStdin);
  runCommand(file, ['task', 'drop', 't2'], noStdin);
  assert.match(runCommand(file, ['task', 'add', 'three'], noStdin), /^t3 /, 'an agent holding t2 must not close another task with it');
  runCommand(file, ['task', 'drop', 't1'], noStdin);
  runCommand(file, ['task', 'drop', 't3'], noStdin);
  assert.equal(existsSync(file), false);
});

test('installing tells both tools’ agents and adds the prompts; removing takes back only what it wrote', async () => {
  const claudeHome = join(directory, 'claude');
  const codexHome = join(directory, 'codex');
  const paths = { claudeHome, codexHome, command: join(directory, 'bin', 'agent-sessions') };
  await mkdir(join(claudeHome, 'commands'), { recursive: true });
  await writeFile(join(claudeHome, 'CLAUDE.md'), '# Mine\n\nKeep this.\n');
  await writeFile(join(claudeHome, 'commands', 'task.md'), 'my own /task\n');
  assert.equal(notesInstalled(paths), false);

  assert.deepEqual(installNotes(paths).skipped, [join(claudeHome, 'commands', 'task.md')], 'a person’s own prompt of that name is left alone and reported');
  installNotes(paths);
  const claude = await readFile(join(claudeHome, 'CLAUDE.md'), 'utf8');
  assert.ok(claude.startsWith('# Mine\n\nKeep this.\n\n<!-- agent-sessions:notes:start'), 'the block follows what was there');
  assert.equal(claude.split('agent-sessions:notes:start').length, 2, 'installing again replaces the block rather than adding another');
  assert.match(claude, /Do not expect them to/, 'the agent records questions whether or not the person types /question');
  assert.match(await readFile(join(codexHome, 'AGENTS.md'), 'utf8'), /Session tasks and questions/);
  assert.match(await readFile(join(claudeHome, 'commands', 'question.md'), 'utf8'), /\$ARGUMENTS/);
  assert.ok(existsSync(join(codexHome, 'prompts', 'task.md')));
  assert.equal(notesInstalled(paths), true);

  uninstallNotes(paths);
  assert.equal(await readFile(join(claudeHome, 'CLAUDE.md'), 'utf8'), '# Mine\n\nKeep this.\n');
  assert.equal(existsSync(join(codexHome, 'AGENTS.md')), false, 'a file that held nothing else goes');
  assert.equal(await readFile(join(claudeHome, 'commands', 'task.md'), 'utf8'), 'my own /task\n');
  assert.equal(existsSync(join(claudeHome, 'commands', 'question.md')), false);
  assert.equal(notesInstalled(paths), false);
});
