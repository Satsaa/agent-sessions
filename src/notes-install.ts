import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * The opt-in agent side of session notes (notes.ts): the `agent-sessions` command at a fixed path, an instruction
 * block in each tool's own global instructions telling its agents when to record a task or a question, and the
 * `/question` and `/task` prompts a person can type. Everything written carries a marker, and only what carries it
 * is ever replaced or removed: a person's own file of the same name is left alone and reported.
 */
export function notesCommandPath(): string {
  return path.join(os.homedir(), '.agent-sessions', 'bin', 'agent-sessions');
}

const BLOCK_START = '<!-- agent-sessions:notes:start (written by the Agent Sessions extension; edits here are replaced) -->';
const BLOCK_END = '<!-- agent-sessions:notes:end -->';
const PROMPT_MARK = '<!-- agent-sessions:notes -->';

/** `~/…` where the path is under the home directory: the same text then serves every shell. */
const tilde = (file: string): string => (file.startsWith(os.homedir() + path.sep) ? `~${file.slice(os.homedir().length)}` : file);

/** What an agent is told. A person may record a question themselves, and the agent must not wait for that. */
export function instructionBlock(command: string): string {
  return `${BLOCK_START}
## Session tasks and questions

\`${command}\` records this session's tasks and the user's questions. The user sees them listed under the session, outside the chat, so nothing asked or agreed gets lost in a long conversation. Run \`${command} help\` for the commands.

- **A task is a deliverable the user would name**, such as "Create v2 phone engine": never a step of one, and not your own plan or todo list. Most sessions have one to three. Add it when the work is agreed (\`task add "<name>"\`), mark it when it is finished and checked (\`task done <id>\`), and \`task drop <id>\` one that was abandoned.
- **A question is something the user asked that could get lost**: asked beside other work, in the middle of a task, or not answered in the same reply. Record it in their words (\`question add "<question>"\`). A question you answer at once in a short reply needs no record.
- **Answer a recorded question in both places**: write the answer in your reply, and record the same answer with \`question answer <id> -\`, the text on standard input. The user reads recorded answers on their own, so the text must make sense without the conversation.
- The user can record a question themselves with \`/question\`. Do not expect them to: recording what they ask is your job either way.
- Before ending a turn in a session that has anything recorded, run \`list\` and answer what you can now. Leave the rest open; \`question stale <id>\` marks one that no longer matters.
${BLOCK_END}`;
}

/** The prompts a person types: `/question <text>` and `/task <text>` in Claude Code, Codex's custom prompts of the same names. */
export function prompts(command: string): Record<'question' | 'task', string> {
  return {
    question: `---
description: Ask a question that stays listed under this session until it is answered
argument-hint: <question>
---
${PROMPT_MARK}
The user asks:

$ARGUMENTS

Record it first, in their words: \`${command} question add -\` with the question on standard input. Then answer it. When you have the answer, write it in your reply and record the same answer with \`${command} question answer <id> -\`, the text on standard input; it is read outside this conversation, so it must make sense on its own. If the answer needs work you cannot finish in this turn, say so and leave the question open.
`,
    task: `---
description: Add a task that stays listed under this session until it is done
argument-hint: <task>
---
${PROMPT_MARK}
The user gives this session a task:

$ARGUMENTS

Record it first under a short name of the deliverable: \`${command} task add "<name>"\`. Then do it, and run \`${command} task done <id>\` once it is finished and checked.
`,
  };
}

export interface NotesInstallPaths {
  /** Claude Code's home (`~/.claude`) and Codex's (`~/.codex`). */
  claudeHome: string;
  codexHome: string;
  command: string;
}

const instructionFiles = (p: NotesInstallPaths): string[] => [path.join(p.claudeHome, 'CLAUDE.md'), path.join(p.codexHome, 'AGENTS.md')];
const promptFiles = (p: NotesInstallPaths, name: string): string[] => [path.join(p.claudeHome, 'commands', `${name}.md`), path.join(p.codexHome, 'prompts', `${name}.md`)];

function read(file: string): string | undefined {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return undefined;
  }
}

/** `text` without our block, and whether it had one. */
function withoutBlock(text: string): { rest: string; had: boolean } {
  const start = text.indexOf(BLOCK_START);
  const end = text.indexOf(BLOCK_END);
  if (start < 0 || end < start) return { rest: text, had: false };
  const before = text.slice(0, start).trimEnd();
  const after = text.slice(end + BLOCK_END.length).trim();
  return { rest: [before, after].filter(Boolean).join('\n\n') + (before || after ? '\n' : ''), had: true };
}

/** Whether the agents have been told: the block is in either tool's instructions. */
export function notesInstalled(p: NotesInstallPaths): boolean {
  return instructionFiles(p).some((file) => read(file)?.includes(BLOCK_START));
}

/**
 * Writes the instruction block and the prompts, replacing our own earlier ones. Returns the prompt files left alone
 * because a person's own file has that name.
 */
export function installNotes(p: NotesInstallPaths): { skipped: string[] } {
  const command = tilde(p.command);
  for (const file of instructionFiles(p)) {
    const { rest } = withoutBlock(read(file) ?? '');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${rest.trimEnd()}${rest.trim() ? '\n\n' : ''}${instructionBlock(command)}\n`);
  }
  const skipped: string[] = [];
  for (const [name, text] of Object.entries(prompts(command))) {
    for (const file of promptFiles(p, name)) {
      const existing = read(file);
      if (existing !== undefined && !existing.includes(PROMPT_MARK)) {
        skipped.push(file);
        continue;
      }
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, text);
    }
  }
  return { skipped };
}

/** Takes back what `installNotes` wrote. Recorded tasks and questions stay. */
export function uninstallNotes(p: NotesInstallPaths): void {
  for (const file of instructionFiles(p)) {
    const text = read(file);
    if (text === undefined) continue;
    const { rest, had } = withoutBlock(text);
    if (!had) continue;
    if (rest.trim()) fs.writeFileSync(file, rest);
    else fs.rmSync(file, { force: true });
  }
  for (const name of Object.keys(prompts(''))) {
    for (const file of promptFiles(p, name)) if (read(file)?.includes(PROMPT_MARK)) fs.rmSync(file, { force: true });
  }
  fs.rmSync(p.command, { force: true });
}
