#!/usr/bin/env node
// Speaks enough of Claude Code's stream-json for the session host tests. A user message's text picks the turn:
// `sleep:<ms>` runs that long, `ask` waits for a permission answer, `hook` waits for a hook callback's answer.
// Each start appends `<pid> <session id> <args>` to $FAKE_CLAUDE_LOG.
import { appendFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

const args = process.argv.slice(2);
const flag = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const sessionId = flag('--resume') ?? flag('--session-id') ?? randomUUID();
appendFileSync(process.env.FAKE_CLAUDE_LOG, `${process.pid} ${sessionId} ${args.join(' ')}\n`);

const out = (m) => process.stdout.write(`${JSON.stringify(m)}\n`);
const waiting = new Map();
let next = 0;
const ask = (request) =>
  new Promise((resolve) => {
    const id = `req_${next++}`;
    waiting.set(id, resolve);
    out({ type: 'control_request', request_id: id, request });
  });

async function turn(text) {
  out({ type: 'system', subtype: 'init', session_id: sessionId });
  out({ type: 'assistant', message: { content: [{ type: 'text', text: `working on ${text}` }] } });
  let result = 'done';
  if (text.startsWith('sleep:')) await new Promise((r) => setTimeout(r, Number(text.slice(6))));
  if (text === 'ask') result = JSON.stringify(await ask({ subtype: 'can_use_tool', tool_name: 'Bash', input: {} }));
  if (text === 'hook') result = JSON.stringify(await ask({ subtype: 'hook_callback', callback_id: 'hook_0', input: {} }));
  out({ type: 'result', subtype: 'success', result, session_id: sessionId });
}

let rest = '';
process.stdin.on('data', (chunk) => {
  rest += chunk;
  let i;
  while ((i = rest.indexOf('\n')) >= 0) {
    const line = rest.slice(0, i);
    rest = rest.slice(i + 1);
    const m = JSON.parse(line);
    if (m.type === 'control_request' && m.request.subtype === 'initialize') {
      out({ type: 'control_response', response: { subtype: 'success', request_id: m.request_id, response: { pid: process.pid } } });
    } else if (m.type === 'control_response') {
      waiting.get(m.response.request_id)?.(m.response);
      waiting.delete(m.response.request_id);
    } else if (m.type === 'user') {
      void turn(m.message.content);
    }
  }
});
process.stdin.on('end', () => process.exit(0));
