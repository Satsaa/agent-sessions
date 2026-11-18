import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import {
  DONE_PARTS, NoteError, addAnswer, addTags, removeTags, addQuestion, addTask, answerQuestion, emptyNotes, kindOf, markSessionDone, notesDir, notesFile, readNotes, reopenSession, setStale, setTaskState,
  updateNotes, writeAnswer, type DonePart, type SessionNotes,
} from './notes.js';
import type { Tool } from './types.js';

/**
 * The `agent-sessions` command an agent runs in its own shell to record its session's tasks, answers and questions
 * (notes.ts). It finds its session from the variables both tools give their shell commands, so an agent never names it.
 */
const USAGE = `Records this session's tasks, answers and questions; the user sees them listed under the session.

  agent-sessions task add <text>          a deliverable, e.g. "Create v2 phone engine"
  agent-sessions task done <id> <what was delivered>
  agent-sessions task drop <id> <why it was abandoned>
  agent-sessions ask add <question>       a question the user asked you
  agent-sessions ask write <id> <answer>
  agent-sessions ask-user add <question>  a question you asked the user, waiting for them
  agent-sessions ask-user answered <id> <what the user answered>
  agent-sessions ask stale <id>, ask-user stale <id>
                                          no longer needed
  agent-sessions tag add <tag>...         what the session is about: tenant:<company>, area:<product area>
  agent-sessions tag remove <tag>...
  agent-sessions list
  agent-sessions done --features <what was delivered and where> --tickets <each ticket and its status now> --cleanup <worktrees, branches and processes removed or left>
                                          closes the session; every part is said, "none" with the reason included
  agent-sessions reopen                   the session is not done after all

A text given as - is read from standard input, for anything with quotes or several lines:
  agent-sessions ask write a1 - <<'END'
  …
  END
--session <claude|codex>:<id> names another session than the one running the command.`;

type Env = Record<string, string | undefined>;

const COMMAND = '~/.agent-sessions/bin/agent-sessions';

/** What every session of an agent with the plugin is told when it starts (the plugin's SessionStart hook prints it). */
export const INSTRUCTIONS = `## Session tasks, answers and questions (Agent Sessions)

\`${COMMAND}\` records this session's tasks, the answers to the user's questions, and the questions you ask the user. The user sees them listed under the session, outside the chat, so nothing asked or agreed gets lost in a long conversation. \`${COMMAND} help\` lists the commands.

This applies to every session and is not optional: a task, an answer or a question left unrecorded is one the user loses track of. Record every time, in the same turn, before starting the work; when in doubt, record it.

- **Every deliverable the user asks for is a task**, recorded the moment it is asked: a plan, a doc, a skill change, a code change, a fix, small ones and ones delegated to a subagent included. Name the deliverable, such as "Create v2 phone engine", never a step of one or your own todo list (\`task add "<name>"\`). Close it when it is finished and checked, saying in a line or two what was delivered and where (\`task done <id> "<what was delivered>"\`), or when it is abandoned, saying why (\`task drop <id> "<why>"\`).
- **Every question the user asks is recorded as an answer to give**, in their words (\`ask add "<their question>"\`), unless your same short reply answers it fully.
- **Answer it in both places**: write the answer in your reply, and record the same answer with \`ask write <id> -\`, the text on standard input. The user reads recorded answers on their own, so the text must make sense without the conversation. **A recorded answer, and a task's done or drop summary, is terse and specific**: only what answers it, with no hedging, no restating of the question, and no filler or obvious context; a short header per point with bullets under it, never paragraphs of prose.
- **A recorded answer always matches the latest answer in the conversation**: when a later reply changes, corrects or extends it, such as after a follow-up like "are you sure?", record it again with \`ask write <id> -\` in the same turn, before ending it. A stale recorded answer is wrong.
- **Every question you ask the user is recorded**, the moment you ask it (\`ask-user add "<question>"\`): a decision only they can make, something you need from them, a choice you offer. It stays listed as waiting for them. When they answer, record what they answered in the same turn (\`ask-user answered <id> "<their answer>"\`); \`ask-user stale <id>\` marks one that no longer needs them.
- The user can record these themselves with the plugin's commands: /task, /ask for a question of theirs to you, /ask-user to see what waits for them. A question the user writes is theirs, whichever command they wrote it with. Do not expect them to record anything: recording is your job either way.
- Before ending a turn in a session that has anything recorded, run \`list\` and answer what you can now. Leave the rest open; \`ask stale <id>\` marks a question of theirs that no longer matters.
- **Tag the session with what it is about**, as soon as you know it (\`tag add "<key>:<value>"\`): \`tenant:<company>\` when the work is for one customer company, named as its tenant is, and \`area:<product area>\` for the part of the product it changes. The user's list groups sessions by them. Add a tag when the work reaches another one; remove one that turned out wrong (\`tag remove\`).
- **When the session's work is all delivered, or the user says it is done, close it with the plugin's done skill**: it checks the features, the tickets and the cleanup, then records them with \`done\`. A session is never marked done with a task open, a question of the user's unanswered, or a question to the user waiting for them.`;

/**
 * What a plugin hook prints into the session: the instructions and what is recorded when it starts, and with each
 * prompt only what is still open, so a long session is reminded of exactly what it owes and what waits for the user.
 */
export function hookText(event: string, notes: SessionNotes): string {
  const open = [
    ...notes.tasks.filter((t) => t.state === 'open').map((t) => `  task ${t.id}: ${t.text}`),
    ...notes.answers.filter((a) => a.state === 'open').map((a) => `  answer ${a.id} (not answered yet): ${a.text}`),
    ...notes.questions.filter((q) => q.state === 'open').map((q) => `  question ${q.id} (waiting for the user): ${q.text}`),
  ];
  if (event === 'session-start') return [INSTRUCTIONS, ...(notes.tasks.length || notes.answers.length || notes.questions.length || notes.done || notes.tags.length ? ['', 'Recorded for this session so far:', formatNotes(notes)] : [])].join('\n');
  if (event !== 'prompt') throw new NoteError('hook takes session-start or prompt');
  if (!open.length) return '';
  return [
    `Agent Sessions: this session still has open (\`${COMMAND} list\`):`,
    ...open,
    'Close a task when it is delivered, and answer a question of the user\'s in your reply and with `ask write`. If this message answers a question waiting for the user, record it with `ask-user answered`. Before working on this message, record each deliverable it asks for as a task and each question it asks as an answer to give, unless your same short reply answers it fully.',
  ].join('\n');
}

/** The session a hook runs for: both tools hand their hooks the session's id on standard input. */
export function hookSession(input: string, env: Env, nearest: () => Tool | undefined = nearestTool): { tool: Tool; id: string } | undefined {
  let payload: { session_id?: unknown; transcript_path?: unknown } = {};
  try {
    payload = JSON.parse(input) as typeof payload;
  } catch {
    // No payload: the variables below are what there is.
  }
  if (typeof payload.session_id === 'string' && payload.session_id) {
    const transcript = typeof payload.transcript_path === 'string' ? payload.transcript_path : '';
    const tool: Tool = /[\\/]\.codex[\\/]/.test(transcript) ? 'codex' : /[\\/]\.claude[\\/]/.test(transcript) ? 'claude' : (nearest() ?? (env.CODEX_THREAD_ID && !env.CLAUDE_CODE_SESSION_ID ? 'codex' : 'claude'));
    return { tool, id: payload.session_id };
  }
  try {
    return sessionOf(env, undefined, nearest);
  } catch {
    return undefined;
  }
}

/** The nearest process above this one that is Claude Code or Codex. */
function nearestTool(): Tool | undefined {
  let pid = process.ppid;
  for (let depth = 0; pid > 1 && depth < 24; depth++) {
    let line: string;
    try {
      line = execFileSync('ps', ['-o', 'ppid=,comm=', '-p', String(pid)], { encoding: 'utf8' }).trim();
    } catch {
      return undefined;
    }
    const m = /^(\d+)\s+(.*)$/.exec(line);
    if (!m) return undefined;
    if (/codex/i.test(m[2]!)) return 'codex';
    if (/claude/i.test(m[2]!)) return 'claude';
    pid = Number(m[1]);
  }
  return undefined;
}

/**
 * The session running this command. Claude Code gives its shell `CLAUDE_CODE_SESSION_ID` and Codex `CODEX_THREAD_ID`;
 * an agent one tool started from the other's shell inherits both, and the nearer tool above it is the one asking.
 */
export function sessionOf(env: Env, named: string | undefined, nearest: () => Tool | undefined = nearestTool): { tool: Tool; id: string } {
  if (named !== undefined) {
    const m = /^(claude|codex):(.+)$/.exec(named);
    if (!m) throw new NoteError('--session takes claude:<id> or codex:<id>');
    return { tool: m[1] as Tool, id: m[2]! };
  }
  const claude = env.CLAUDE_CODE_SESSION_ID;
  const codex = env.CODEX_THREAD_ID;
  if (claude && codex) {
    const tool = nearest();
    if (!tool) throw new NoteError('this shell belongs to both a Claude and a Codex session; name one with --session <claude|codex>:<id>');
    return { tool, id: tool === 'claude' ? claude : codex };
  }
  if (claude) return { tool: 'claude', id: claude };
  if (codex) return { tool: 'codex', id: codex };
  throw new NoteError('not inside a Claude Code or Codex session (no CLAUDE_CODE_SESSION_ID or CODEX_THREAD_ID); name one with --session <claude|codex>:<id>');
}

export function formatNotes(notes: SessionNotes): string {
  if (!notes.tasks.length && !notes.answers.length && !notes.questions.length && !notes.done && !notes.tags.length) return 'Nothing recorded for this session.';
  const lines: string[] = [];
  if (notes.tags.length) lines.push(`Tags: ${notes.tags.join(', ')}`);
  if (notes.tasks.length) lines.push('Tasks', ...notes.tasks.map((t) => `  ${t.id} [${t.state}] ${t.text}`));
  if (notes.answers.length) lines.push("Answers (the user's questions)", ...notes.answers.map((a) => `  ${a.id} [${a.state}] ${a.text}`));
  if (notes.questions.length) lines.push('Questions (asked of the user)', ...notes.questions.map((q) => `  ${q.id} [${q.state === 'open' ? 'waiting for the user' : q.state}] ${q.text}`));
  if (notes.done) lines.push('Session done', ...DONE_PARTS.map((part) => `  ${part}: ${notes.done![part]}`));
  return lines.join('\n');
}

/** `--features … --tickets … --cleanup …`: each flag takes the words up to the next one. */
function doneParts(words: readonly string[]): Partial<Record<DonePart, string>> {
  const parts: Partial<Record<DonePart, string>> = {};
  let part: DonePart | undefined;
  for (const word of words) {
    const flag = DONE_PARTS.find((p) => word === `--${p}`);
    if (flag) {
      part = flag;
      parts[part] = '';
    } else if (part) parts[part] = `${parts[part]} ${word}`.trim();
    else throw new NoteError(`done takes ${DONE_PARTS.map((p) => `--${p} <text>`).join(' ')}`);
  }
  return parts;
}

/** Runs one command against `file` and returns what to print. `stdin` supplies a text given as `-`. */
export function runCommand(file: string, args: readonly string[], stdin: () => string): string {
  const text = (words: readonly string[], what: string): string => {
    if (!words.length) throw new NoteError(`${what} is missing`);
    return words.length === 1 && words[0] === '-' ? stdin() : words.join(' ');
  };
  const id = (word: string | undefined): string => {
    if (!word) throw new NoteError('the id is missing; `agent-sessions list` shows them');
    return word;
  };
  const [group, verb, ...rest] = args;
  let out = '';
  const change = (apply: (notes: SessionNotes) => string): void => {
    updateNotes(file, (notes) => { out = apply(notes); });
  };
  switch (group === 'done' || group === 'reopen' ? group : `${group ?? ''} ${verb ?? ''}`.trim()) {
    case 'list':
      return formatNotes(readNotes(file));
    case 'task add':
      change((n) => `${addTask(n, text(rest, 'the task')).id} added`);
      break;
    case 'task done':
      change((n) => `${setTaskState(n, id(rest[0]), 'done', text(rest.slice(1), 'what was delivered (one or two lines the user reads under the task)')).id} done`);
      break;
    case 'task drop':
      change((n) => `${setTaskState(n, id(rest[0]), 'dropped', text(rest.slice(1), 'why the task was abandoned')).id} dropped`);
      break;
    // `ask` was `answer` and `ask-user` was `question` until the names took the user's side; sessions told the old
    // names are still understood.
    case 'ask add':
    case 'answer add':
      change((n) => `${addAnswer(n, text(rest, 'the question')).id} added; answer it with: agent-sessions ask write <id> <answer>`);
      break;
    case 'ask write':
    case 'answer write':
      change((n) => `${writeAnswer(n, id(rest[0]), text(rest.slice(1), 'the answer')).id} answered`);
      break;
    case 'ask-user add':
    case 'question add':
      change((n) => `${addQuestion(n, text(rest, 'the question')).id} added; when the user answers, record it with: agent-sessions ask-user answered <id> <their answer>`);
      break;
    case 'ask-user answered':
    case 'question answered':
      change((n) => `${answerQuestion(n, id(rest[0]), text(rest.slice(1), "what the user answered")).id} answered`);
      break;
    // Before answers had their name, the user's questions were answered with `question answer`; a session told so then
    // is still understood.
    case 'question answer':
      change((n) => {
        const target = id(rest[0]);
        const answer = text(rest.slice(1), 'the answer');
        return `${(kindOf(n, target) === 'question' ? answerQuestion(n, target, answer) : writeAnswer(n, target, answer)).id} answered`;
      });
      break;
    case 'ask stale':
    case 'ask-user stale':
    case 'answer stale':
    case 'question stale':
      change((n) => {
        const target = id(rest[0]);
        const kind = kindOf(n, target);
        return `${setStale(n, kind === 'answer' || kind === 'question' ? kind : group === 'ask' || group === 'answer' ? 'answer' : 'question', target, true).id} marked stale`;
      });
      break;
    case 'tag add':
      change((n) => {
        if (!rest.length) throw new NoteError('the tag is missing');
        const added = addTags(n, rest.length === 1 && rest[0] === '-' ? stdin().split('\n') .filter((l) => l.trim()) : [rest.join(' ')]);
        return added.length ? `tagged ${added.join(', ')}` : 'already tagged';
      });
      break;
    case 'tag remove':
      change((n) => {
        if (!rest.length) throw new NoteError('the tag is missing');
        removeTags(n, [rest.join(' ')]);
        return 'tag removed';
      });
      break;
    case 'done':
      change((n) => {
        markSessionDone(n, doneParts(verb === undefined ? [] : [verb, ...rest]));
        return 'session marked done';
      });
      break;
    case 'reopen':
      change((n) => {
        reopenSession(n);
        return 'session reopened';
      });
      break;
    default:
      throw new NoteError(USAGE);
  }
  return out;
}

export function main(): void {
  const args = process.argv.slice(2);
  let named: string | undefined;
  const at = args.indexOf('--session');
  if (at >= 0) [, named] = args.splice(at, 2);
  if (!args.length || args[0] === 'help' || args.includes('--help')) {
    console.log(USAGE);
    return;
  }
  if (args[0] === 'hook') {
    // A hook never fails its session: with no session to name, or anything wrong, it says nothing.
    try {
      const session = hookSession(fs.readFileSync(0, 'utf8'), process.env);
      const text = hookText(args[1] ?? '', session ? readNotes(notesFile(notesDir(), session.tool, session.id)) : emptyNotes());
      if (text) console.log(text);
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
    }
    return;
  }
  try {
    const { tool, id } = sessionOf(process.env, named);
    console.log(runCommand(notesFile(notesDir(), tool, id), args, () => fs.readFileSync(0, 'utf8')));
  } catch (err) {
    if (!(err instanceof NoteError)) throw err;
    console.error(err.message);
    process.exitCode = 1;
  }
}
