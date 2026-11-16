import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Tool } from './types.js';

/**
 * A session's tasks and questions: what an agent records about its own session through the `agent-sessions` command
 * (notes-cli.ts), and a person reads under the session's row. One file per session under the user's home, like the
 * marks (marks.ts), so every window and the command itself share it. A tool's own transcript is never written.
 */
export interface Task {
  id: string;
  text: string;
  /** `dropped`: abandoned. It stays listed, with why. */
  state: 'open' | 'done' | 'dropped';
  at: number;
  /** When it was done or dropped, and what the agent said of it: what was delivered, or why it was abandoned. */
  closedAt?: number;
  resolution?: string;
}

export interface Question {
  id: string;
  text: string;
  /** `stale`: no longer worth an answer. It keeps the answer it had, and reopening returns it to where it was. */
  state: 'open' | 'answered' | 'stale';
  at: number;
  answer?: string;
  answeredAt?: number;
  /** A person opened the answer; until then it counts on the session's row. */
  read?: boolean;
}

export interface SessionNotes {
  /** The last number an id was made from, so a removed note's id is not given to another. */
  seq: number;
  tasks: Task[];
  questions: Question[];
}

export type NoteKind = 'task' | 'question';

export function notesDir(): string {
  return path.join(os.homedir(), '.agent-sessions', 'notes');
}

/** `<tool>-<id>.json`; an id is a tool's own, a UUID in both, and anything else in it is not a file name's business. */
export function notesFile(dir: string, tool: Tool, id: string): string {
  return path.join(dir, `${tool}-${id.replace(/[^\w.-]/g, '_')}.json`);
}

/** The session (`tool:id`) a notes file name belongs to. */
export function sessionKeyOfNotesFile(name: string): string | undefined {
  const m = /^(claude|codex)-(.+)\.json$/.exec(name);
  return m ? `${m[1]}:${m[2]}` : undefined;
}

export const emptyNotes = (): SessionNotes => ({ seq: 0, tasks: [], questions: [] });

export function readNotes(file: string): SessionNotes {
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    // Missing: nothing recorded.
    return emptyNotes();
  }
  const o = raw && typeof raw === 'object' ? (raw as Partial<SessionNotes>) : {};
  const rows = <T extends { id: string; text: string }>(v: unknown): T[] =>
    Array.isArray(v) ? v.filter((x): x is T => !!x && typeof x === 'object' && typeof (x as T).id === 'string' && typeof (x as T).text === 'string') : [];
  return { seq: typeof o.seq === 'number' ? o.seq : 0, tasks: rows<Task>(o.tasks), questions: rows<Question>(o.questions) };
}

/** Apply one change to a session's file as it is now. A file left with nothing in it is removed. */
export function updateNotes(file: string, change: (notes: SessionNotes) => void): SessionNotes {
  const notes = readNotes(file);
  change(notes);
  if (!notes.tasks.length && !notes.questions.length) {
    fs.rmSync(file, { force: true });
    return notes;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // Written beside and renamed over, so a reader never sees half a file.
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(notes, null, 2) + '\n');
  fs.renameSync(tmp, file);
  return notes;
}

/** Thrown for what the caller got wrong (an unknown id, an empty text); the command prints its message. */
export class NoteError extends Error {}

function clean(text: string, what: string): string {
  const t = text.trim();
  if (!t) throw new NoteError(`${what} is empty`);
  return t;
}

function find<T extends { id: string }>(list: T[], id: string, what: string): T {
  const row = list.find((x) => x.id === id);
  if (!row) throw new NoteError(`no ${what} ${id} in this session${list.length ? ` (it has ${list.map((x) => x.id).join(', ')})` : ''}`);
  return row;
}

export function addTask(notes: SessionNotes, text: string, now = Date.now()): Task {
  const task: Task = { id: `t${++notes.seq}`, text: clean(text, 'the task'), state: 'open', at: now };
  notes.tasks.push(task);
  return task;
}

/** Close a task as done or dropped, with what there is to say of it, or reopen it, which forgets that. */
export function setTaskState(notes: SessionNotes, id: string, state: Task['state'], resolution?: string, now = Date.now()): Task {
  const task = find(notes.tasks, id, 'task');
  task.state = state;
  delete task.closedAt;
  delete task.resolution;
  if (state !== 'open') {
    task.closedAt = now;
    if (resolution?.trim()) task.resolution = resolution.trim();
  }
  return task;
}

export function addQuestion(notes: SessionNotes, text: string, now = Date.now()): Question {
  const question: Question = { id: `q${++notes.seq}`, text: clean(text, 'the question'), state: 'open', at: now };
  notes.questions.push(question);
  return question;
}

/** A new answer replaces the old one and is unread again; answering a stale question brings it back. */
export function answerQuestion(notes: SessionNotes, id: string, answer: string, now = Date.now()): Question {
  const question = find(notes.questions, id, 'question');
  question.answer = clean(answer, 'the answer');
  question.answeredAt = now;
  question.state = 'answered';
  delete question.read;
  return question;
}

export function setQuestionStale(notes: SessionNotes, id: string, stale: boolean): Question {
  const question = find(notes.questions, id, 'question');
  question.state = stale ? 'stale' : question.answer === undefined ? 'open' : 'answered';
  return question;
}

export function markAnswerRead(notes: SessionNotes, id: string): Question {
  const question = find(notes.questions, id, 'question');
  if (question.answer !== undefined) question.read = true;
  return question;
}

export function removeNote(notes: SessionNotes, kind: NoteKind, id: string): void {
  if (kind === 'task') notes.tasks.splice(notes.tasks.indexOf(find(notes.tasks, id, 'task')), 1);
  else notes.questions.splice(notes.questions.indexOf(find(notes.questions, id, 'question')), 1);
}

export interface NoteCounts {
  tasksOpen: number;
  tasksDone: number;
  /** Questions with no answer yet. */
  questionsOpen: number;
  /** Answers nobody has opened. */
  answersUnread: number;
}

export function noteCounts(notes: SessionNotes | undefined): NoteCounts {
  const tasks = notes?.tasks ?? [];
  const questions = notes?.questions ?? [];
  return {
    tasksOpen: tasks.filter((t) => t.state === 'open').length,
    tasksDone: tasks.filter((t) => t.state === 'done').length,
    questionsOpen: questions.filter((q) => q.state === 'open').length,
    answersUnread: questions.filter((q) => q.state === 'answered' && !q.read).length,
  };
}

/** Every session's notes, by `tool:id`. */
export function readAllNotes(dir: string): Map<string, SessionNotes> {
  const all = new Map<string, SessionNotes>();
  let names: string[] = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    // No session has recorded anything.
  }
  for (const name of names) {
    const key = sessionKeyOfNotesFile(name);
    if (key) all.set(key, readNotes(path.join(dir, name)));
  }
  return all;
}

/** Keeps `all` current with the folder, and calls `onChange` after each session's file changes. */
export function watchNotes(dir: string, all: Map<string, SessionNotes>, onChange: () => void): { dispose(): void } {
  fs.mkdirSync(dir, { recursive: true });
  const changed = new Set<string>();
  let timer: NodeJS.Timeout | undefined;
  const watcher = fs.watch(dir, { persistent: false }, (_event, name) => {
    if (!name || !sessionKeyOfNotesFile(name)) return;
    changed.add(name);
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      for (const file of changed) {
        const key = sessionKeyOfNotesFile(file)!;
        if (fs.existsSync(path.join(dir, file))) all.set(key, readNotes(path.join(dir, file)));
        else all.delete(key);
      }
      changed.clear();
      onChange();
    }, 100);
  });
  return {
    dispose: () => {
      if (timer) clearTimeout(timer);
      watcher.close();
    },
  };
}
