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

/** A question the user asked, and the agent's answer to it. */
export interface Answer {
  id: string;
  /** The user's question. */
  text: string;
  /** `stale`: no longer worth an answer. It keeps the answer it had, and reopening returns it to where it was. */
  state: 'open' | 'answered' | 'stale';
  at: number;
  answer?: string;
  answeredAt?: number;
  /** A person opened the answer; until then it counts on the session's row. */
  read?: boolean;
}

/** A question the agent asked the user, open until the user answers it. */
export interface Question {
  id: string;
  text: string;
  /** `stale`: no longer needs the user. Reopening returns it to where it was. */
  state: 'open' | 'answered' | 'stale';
  at: number;
  /** What the user answered, as the agent recorded it; a person marking it answered says nothing. */
  answer?: string;
  answeredAt?: number;
}

/** A session its agent closed: what it delivered, what became of its tickets, and what it cleaned up after itself. */
export interface SessionDone {
  at: number;
  features: string;
  tickets: string;
  cleanup: string;
}

export const DONE_PARTS = ['features', 'tickets', 'cleanup'] as const;
export type DonePart = (typeof DONE_PARTS)[number];

export interface SessionNotes {
  /** The last number an id was made from, so a removed note's id is not given to another. */
  seq: number;
  tasks: Task[];
  answers: Answer[];
  questions: Question[];
  /** Set while the session is done; a new task, answer or question takes it away. */
  done?: SessionDone;
  /**
   * What the session is about, as its agent tagged it (`tenant:Kouvolan Lakritsi`, `area:widget`): `key:value`, or a
   * bare word. Lists group and filter by them; a tag never closes or reopens anything.
   */
  tags: string[];
}

export type NoteKind = 'task' | 'answer' | 'question';

/**
 * How a file stores the notes. The user's own questions were stored as `questions` before the agent could ask any, and
 * stay there (`answers` in memory), so a window still running an earlier version reads and writes them as it did; the
 * agent's questions to the user are `asked`, which such a window leaves out.
 */
interface StoredNotes {
  seq: number;
  tasks: Task[];
  questions: Answer[];
  asked: Question[];
  done?: SessionDone;
  tags?: string[];
}

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

export const emptyNotes = (): SessionNotes => ({ seq: 0, tasks: [], answers: [], questions: [], tags: [] });

export function readNotes(file: string): SessionNotes {
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    // Missing: nothing recorded.
    return emptyNotes();
  }
  const o = raw && typeof raw === 'object' ? (raw as Partial<StoredNotes>) : {};
  const rows = <T extends { id: string; text: string }>(v: unknown): T[] =>
    Array.isArray(v) ? v.filter((x): x is T => !!x && typeof x === 'object' && typeof (x as T).id === 'string' && typeof (x as T).text === 'string') : [];
  const notes: SessionNotes = { seq: typeof o.seq === 'number' ? o.seq : 0, tasks: rows<Task>(o.tasks), answers: rows<Answer>(o.questions), questions: rows<Question>(o.asked), tags: Array.isArray(o.tags) ? o.tags.filter((t): t is string => typeof t === 'string' && !!t.trim()) : [] };
  const d = o.done as Partial<SessionDone> | undefined;
  if (d && typeof d === 'object' && typeof d.at === 'number' && DONE_PARTS.every((part) => typeof d[part] === 'string')) {
    notes.done = { at: d.at, features: d.features!, tickets: d.tickets!, cleanup: d.cleanup! };
  }
  return notes;
}

/** Whether anything is recorded: a file with nothing in it is not kept, and a session with nothing has no rows. */
export const hasNotes = (notes: SessionNotes | undefined): notes is SessionNotes => !!notes && (notes.tasks.length + notes.answers.length + notes.questions.length > 0 || !!notes.done);

function stored(notes: SessionNotes): StoredNotes {
  return { seq: notes.seq, tasks: notes.tasks, questions: notes.answers, asked: notes.questions, ...(notes.done ? { done: notes.done } : {}), ...(notes.tags.length ? { tags: notes.tags } : {}) };
}

/** Apply one change to a session's file as it is now. A file left with nothing in it is removed. */
export function updateNotes(file: string, change: (notes: SessionNotes) => void): SessionNotes {
  const notes = readNotes(file);
  change(notes);
  const kept = notes.tags.length > 0 || hasNotes(notes);
  if (!kept) {
    fs.rmSync(file, { force: true });
    return notes;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // Written beside and renamed over, so a reader never sees half a file.
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(stored(notes), null, 2) + '\n');
  fs.renameSync(tmp, file);
  return notes;
}

/** Thrown for what the caller got wrong (an unknown id, an empty text); the command prints its message. */
export class NoteError extends Error {}

/**
 * A tag as stored: spaces collapsed, and a `key:value` tag's key lower-cased and trimmed, so `Tenant: Acme` and
 * `tenant:Acme` are one tag. The value keeps its case: it is a name a person reads.
 */
export function normalizeTag(raw: string): string {
  const text = raw.replace(/\s+/g, ' ').trim();
  const m = /^([A-Za-z][\w-]*)\s*:\s*(.+)$/.exec(text);
  return m ? `${m[1]!.toLowerCase()}:${m[2]}` : text;
}

/** Adds tags not already there (compared without case); returns the ones added. */
export function addTags(notes: SessionNotes, raw: readonly string[]): string[] {
  const added: string[] = [];
  for (const tag of raw.map(normalizeTag)) {
    if (!tag) throw new NoteError('the tag is missing');
    if (notes.tags.some((t) => t.toLowerCase() === tag.toLowerCase())) continue;
    notes.tags.push(tag);
    added.push(tag);
  }
  return added;
}

/** Removes tags (compared without case); a tag the session does not have is an error naming the ones it has. */
export function removeTags(notes: SessionNotes, raw: readonly string[]): void {
  for (const tag of raw.map(normalizeTag)) {
    const i = notes.tags.findIndex((t) => t.toLowerCase() === tag.toLowerCase());
    if (i < 0) throw new NoteError(`this session has no tag ${tag}${notes.tags.length ? ` (it has ${notes.tags.join(', ')})` : ''}`);
    notes.tags.splice(i, 1);
  }
}

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
  delete notes.done;
  return task;
}

/** Close a task as done or dropped, with what there is to say of it, or reopen it, which forgets that. */
export function setTaskState(notes: SessionNotes, id: string, state: Task['state'], resolution?: string, now = Date.now()): Task {
  const task = find(notes.tasks, id, 'task');
  task.state = state;
  if (state === 'open') delete notes.done;
  delete task.closedAt;
  delete task.resolution;
  if (state !== 'open') {
    task.closedAt = now;
    if (resolution?.trim()) task.resolution = resolution.trim();
  }
  return task;
}

/** The user asked a question; the agent owes it an answer. */
export function addAnswer(notes: SessionNotes, question: string, now = Date.now()): Answer {
  const answer: Answer = { id: `a${++notes.seq}`, text: clean(question, 'the question'), state: 'open', at: now };
  notes.answers.push(answer);
  delete notes.done;
  return answer;
}

/** A new answer replaces the old one and is unread again; answering a stale question brings it back. */
export function writeAnswer(notes: SessionNotes, id: string, text: string, now = Date.now()): Answer {
  const answer = find(notes.answers, id, 'answer');
  answer.answer = clean(text, 'the answer');
  answer.answeredAt = now;
  answer.state = 'answered';
  delete answer.read;
  return answer;
}

/** The agent asked the user a question; it waits for the user. */
export function addQuestion(notes: SessionNotes, text: string, now = Date.now()): Question {
  const question: Question = { id: `q${++notes.seq}`, text: clean(text, 'the question'), state: 'open', at: now };
  notes.questions.push(question);
  delete notes.done;
  return question;
}

/** The user answered: with what they said when the agent records it, with nothing when a person marks it. */
export function answerQuestion(notes: SessionNotes, id: string, text?: string, now = Date.now()): Question {
  const question = find(notes.questions, id, 'question');
  delete question.answer;
  if (text !== undefined) question.answer = clean(text, "the user's answer");
  question.answeredAt = now;
  question.state = 'answered';
  return question;
}

/** Set an answer or a question aside, or bring it back to where it was. */
export function setStale(notes: SessionNotes, kind: 'answer' | 'question', id: string, stale: boolean): Answer | Question {
  const row = kind === 'answer' ? find(notes.answers, id, 'answer') : find(notes.questions, id, 'question');
  row.state = stale ? 'stale' : row.answeredAt === undefined && row.answer === undefined ? 'open' : 'answered';
  return row;
}

/** Which list an id is in, for a command that names only the id. */
export function kindOf(notes: SessionNotes, id: string): NoteKind | undefined {
  return notes.tasks.some((x) => x.id === id) ? 'task' : notes.answers.some((x) => x.id === id) ? 'answer' : notes.questions.some((x) => x.id === id) ? 'question' : undefined;
}

/**
 * Close the session: what it delivered, what became of its tickets, and what it cleaned up, each said even when the
 * answer is "none". Refused while a task is open, a question of the user's unanswered, or one asked of the user waiting
 * for them, since those are what a done session leaves behind.
 */
export function markSessionDone(notes: SessionNotes, parts: Partial<Record<DonePart, string>>, now = Date.now()): SessionDone {
  const open = [...notes.tasks, ...notes.answers, ...notes.questions].filter((x) => x.state === 'open');
  if (open.length) {
    throw new NoteError(`this session is not done: ${open.map((x) => `${x.id} "${x.text}"`).join(', ')} ${open.length === 1 ? 'is' : 'are'} still open. Close each task with what came of it, answer each of the user's questions, record the user's answer to each question asked of them, or mark it stale.`);
  }
  const said = (part: DonePart): string => {
    const text = parts[part]?.trim();
    if (!text) throw new NoteError(`--${part} is missing: say what there is, or that there is none and why`);
    return text;
  };
  notes.done = { at: now, features: said('features'), tickets: said('tickets'), cleanup: said('cleanup') };
  return notes.done;
}

/** A person's correction of one part of what a done session said. */
export function editSessionDone(notes: SessionNotes, part: DonePart, text: string): void {
  if (!notes.done) throw new NoteError('this session is not marked done');
  notes.done[part] = clean(text, `the ${part}`);
}

export function reopenSession(notes: SessionNotes): void {
  delete notes.done;
}

export function markAnswerRead(notes: SessionNotes, id: string): Answer {
  const answer = find(notes.answers, id, 'answer');
  if (answer.answer !== undefined) answer.read = true;
  return answer;
}

export function removeNote(notes: SessionNotes, kind: NoteKind, id: string): void {
  const remove = <T extends { id: string }>(list: T[]) => list.splice(list.indexOf(find(list, id, kind)), 1);
  if (kind === 'task') remove(notes.tasks);
  else if (kind === 'answer') remove(notes.answers);
  else remove(notes.questions);
}

export interface NoteCounts {
  tasksOpen: number;
  tasksDone: number;
  /** The user's questions with no answer yet. */
  answersOpen: number;
  /** Answers nobody has opened. */
  answersUnread: number;
  /** Questions asked of the user that wait for them. */
  questionsOpen: number;
}

export function noteCounts(notes: SessionNotes | undefined): NoteCounts {
  const tasks = notes?.tasks ?? [];
  const answers = notes?.answers ?? [];
  return {
    tasksOpen: tasks.filter((t) => t.state === 'open').length,
    tasksDone: tasks.filter((t) => t.state === 'done').length,
    answersOpen: answers.filter((a) => a.state === 'open').length,
    answersUnread: answers.filter((a) => a.state === 'answered' && !a.read).length,
    questionsOpen: (notes?.questions ?? []).filter((q) => q.state === 'open').length,
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
