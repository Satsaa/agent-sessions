import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import {
  NoteError, addQuestion, addTask, answerQuestion, notesDir, notesFile, readNotes, removeNote, setQuestionStale, setTaskDone, updateNotes,
  type SessionNotes,
} from './notes.js';
import type { Tool } from './types.js';

/**
 * The `agent-sessions` command an agent runs in its own shell to record its session's tasks and questions (notes.ts).
 * It finds its session from the variables both tools give their shell commands, so an agent never names it.
 */
const USAGE = `Records this session's tasks and questions; the user sees them listed under the session.

  agent-sessions task add <text>          a deliverable, e.g. "Create v2 phone engine"
  agent-sessions task done <id>
  agent-sessions task drop <id>           abandoned: removes it
  agent-sessions question add <text>      a question the user asked
  agent-sessions question answer <id> <answer>
  agent-sessions question stale <id>      no longer worth an answer
  agent-sessions list

A text given as - is read from standard input, for anything with quotes or several lines:
  agent-sessions question answer q1 - <<'END'
  …
  END
--session <claude|codex>:<id> names another session than the one running the command.`;

type Env = Record<string, string | undefined>;

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
  if (!notes.tasks.length && !notes.questions.length) return 'Nothing recorded for this session.';
  const lines: string[] = [];
  if (notes.tasks.length) lines.push('Tasks', ...notes.tasks.map((t) => `  ${t.id} [${t.state}] ${t.text}`));
  if (notes.questions.length) lines.push('Questions', ...notes.questions.map((q) => `  ${q.id} [${q.state}] ${q.text}`));
  return lines.join('\n');
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
  switch (`${group ?? ''} ${verb ?? ''}`.trim()) {
    case 'list':
      return formatNotes(readNotes(file));
    case 'task add':
      change((n) => `${addTask(n, text(rest, 'the task')).id} added`);
      break;
    case 'task done':
      change((n) => `${setTaskDone(n, id(rest[0]), true).id} done`);
      break;
    case 'task drop':
      change((n) => (removeNote(n, 'task', id(rest[0])), `${rest[0]} dropped`));
      break;
    case 'question add':
      change((n) => `${addQuestion(n, text(rest, 'the question')).id} added; answer it with: agent-sessions question answer <id> <answer>`);
      break;
    case 'question answer':
      change((n) => `${answerQuestion(n, id(rest[0]), text(rest.slice(1), 'the answer')).id} answered`);
      break;
    case 'question stale':
      change((n) => `${setQuestionStale(n, id(rest[0]), true).id} marked stale`);
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
  try {
    const { tool, id } = sessionOf(process.env, named);
    console.log(runCommand(notesFile(notesDir(), tool, id), args, () => fs.readFileSync(0, 'utf8')));
  } catch (err) {
    if (!(err instanceof NoteError)) throw err;
    console.error(err.message);
    process.exitCode = 1;
  }
}
