import * as readline from 'node:readline';
import { createReadStream } from 'node:fs';
import type { Session } from './types.js';

/**
 * A session as readable text: the person's prompts and the agent's replies, nothing else.
 * Tool calls, tool results, reasoning, system and developer instructions, IDE context blocks
 * and interruption markers are left out.
 */
export interface TranscriptMessage {
  role: 'user' | 'assistant';
  text: string;
  at: number | undefined;
}

/** Strip the machinery both tools wrap around a prompt, keeping every line the person actually wrote. */
const INJECTED_TAGS = ['recommended_plugins', 'environment_context', 'user_instructions', 'permissions_instructions', 'turn_aborted', 'user_action', 'skills_instructions', 'multi_agent_role', 'multi_agent_mode', 'INSTRUCTIONS'];

export function cleanMessageText(raw: string): string {
  // A slash command and its local output are not a message to the agent.
  if (/<command-name>|<local-command-stdout>|<local-command-caveat>/.test(raw)) return '';
  let text = raw;
  for (const tag of INJECTED_TAGS) text = text.replace(new RegExp(`<${tag}(?:\\s[^>]*)?>[\\s\\S]*?</${tag}>`, 'g'), '');
  // Codex sends AGENTS.md as a user message: a heading naming the file, then the <INSTRUCTIONS> block removed above.
  text = text.replace(/^#{1,6}\s+AGENTS\.md instructions for .*$/gm, '');
  text = text
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
    .replace(/<ide_opened_file>[\s\S]*?<\/ide_opened_file>/g, '')
    .replace(/<ide_selection>[\s\S]*?<\/ide_selection>/g, '')
    .replace(/<command-message>[\s\S]*?<\/command-message>/g, '');
  // Codex prefixes "# Context from my IDE setup:" paragraphs; Claude wraps its context in tags handled above.
  const paragraphs = text.split(/\n\s*\n/);
  const kept: string[] = [];
  let skippingContext = false;
  for (const p of paragraphs) {
    if (/^#{1,6}\s+Context from my IDE/i.test(p.trim())) {
      skippingContext = true;
      continue;
    }
    if (skippingContext && /^#{1,6}\s/.test(p.trim())) skippingContext = false;
    if (skippingContext) continue;
    if (/^<INSTRUCTIONS/i.test(p.trim())) continue;
    kept.push(p);
  }
  text = kept.join('\n\n').trim();
  if (/^\[Request interrupted by user[^\]]*\]$/.test(text)) return '';
  return text;
}

function textBlocks(content: unknown, kinds: ReadonlySet<string>): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const c of content) {
    if (!c || typeof c !== 'object') continue;
    const block = c as { type?: string; text?: string };
    if (block.type && kinds.has(block.type) && typeof block.text === 'string') parts.push(block.text);
  }
  return parts.join('\n');
}

const CLAUDE_TEXT = new Set(['text']);
const CODEX_TEXT = new Set(['input_text', 'output_text']);

async function* lines(file: string): AsyncGenerator<string> {
  const rl = readline.createInterface({ input: createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
  try {
    for await (const line of rl) if (line) yield line;
  } finally {
    rl.close();
  }
}

function parse(line: string): Record<string, unknown> | undefined {
  try {
    return JSON.parse(line) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function at(value: unknown): number | undefined {
  if (typeof value !== 'string') return undefined;
  const t = Date.parse(value);
  return Number.isFinite(t) ? t : undefined;
}

async function readClaude(file: string): Promise<TranscriptMessage[]> {
  const out: TranscriptMessage[] = [];
  for await (const line of lines(file)) {
    const d = parse(line) as { type?: string; isMeta?: boolean; isSidechain?: boolean; timestamp?: string; message?: { role?: string; content?: unknown } } | undefined;
    if (!d || (d.type !== 'user' && d.type !== 'assistant') || d.isMeta || d.isSidechain) continue;
    const role = d.type;
    // A user record whose content is only tool_result blocks yields no text and is skipped.
    const text = role === 'user' ? cleanMessageText(textBlocks(d.message?.content, CLAUDE_TEXT)) : textBlocks(d.message?.content, CLAUDE_TEXT).trim();
    if (!text) continue;
    out.push({ role, text, at: at(d.timestamp) });
  }
  return out;
}

async function readCodex(file: string): Promise<TranscriptMessage[]> {
  const out: TranscriptMessage[] = [];
  for await (const line of lines(file)) {
    const d = parse(line) as { type?: string; timestamp?: string; payload?: { type?: string; role?: string; content?: unknown } } | undefined;
    if (!d || d.type !== 'response_item' || d.payload?.type !== 'message') continue;
    const role = d.payload.role;
    if (role !== 'user' && role !== 'assistant') continue; // developer/system instructions are not the conversation
    const text = role === 'user' ? cleanMessageText(textBlocks(d.payload.content, CODEX_TEXT)) : textBlocks(d.payload.content, CODEX_TEXT).trim();
    if (!text) continue;
    out.push({ role, text, at: at(d.timestamp) });
  }
  return out;
}

export async function readTranscript(session: Session): Promise<TranscriptMessage[]> {
  if (!session.transcriptPath) return [];
  return session.tool === 'claude' ? readClaude(session.transcriptPath) : readCodex(session.transcriptPath);
}

/** Consecutive assistant records (one reply streamed as several messages) merge into one block. */
export function formatTranscript(session: Session, messages: TranscriptMessage[]): string {
  const merged: TranscriptMessage[] = [];
  for (const m of messages) {
    const last = merged[merged.length - 1];
    if (last && last.role === 'assistant' && m.role === 'assistant') last.text += `\n\n${m.text}`;
    else merged.push({ ...m });
  }
  const who = { user: 'User', assistant: session.tool === 'claude' ? 'Claude' : 'Codex' };
  const blocks = merged.map((m) => `## ${who[m.role]}${m.at ? ` — ${new Date(m.at).toLocaleString()}` : ''}\n\n${m.text}`);
  return [`# ${session.title}`, ...blocks].join('\n\n') + '\n';
}
