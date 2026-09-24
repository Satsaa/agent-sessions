import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { spawn } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const FAKE = fileURLToPath(new URL('./fixtures/fake-claude.mjs', import.meta.url));
let dir, wrapper, log, host;

before(async () => {
  const { build } = await import('esbuild');
  dir = await mkdtemp(join(tmpdir(), 'agent-sessions-host-test-'));
  process.env.HOME = dir;
  const common = { bundle: true, platform: 'node', format: 'esm', outdir: dir, outExtension: { '.js': '.mjs' } };
  await build({ ...common, entryPoints: { 'claude-wrapper': 'src/host/wrapper.ts', host: 'src/host/host.ts' } });
  wrapper = join(dir, 'claude-wrapper.mjs');
  log = join(dir, 'fake-claude.log');
  await chmod(FAKE, 0o755);
  const { SessionHost } = await import(join(dir, 'host.mjs'));
  await mkdir(join(dir, '.agent-sessions', 'host'), { recursive: true });
  host = new SessionHost({
    socketPath: join(dir, '.agent-sessions', 'host', 'host.sock'),
    idleStopMs: 60_000,
    emptyExitMs: 3_600_000,
    takeoverMs: 5_000,
    log: () => {},
  });
  assert.ok(await host.listen());
});

after(async () => {
  await host.close();
  await rm(dir, { recursive: true, force: true });
});

const PANEL_ARGS = ['--output-format', 'stream-json', '--verbose', '--input-format', 'stream-json'];

/** A Claude panel in window `label`, started through the wrapper the way the extension starts it. */
function panel(label, extra = []) {
  const child = spawn(process.execPath, [wrapper, FAKE, ...PANEL_ARGS, ...extra], {
    env: { ...process.env, HOME: dir, AGENT_SESSIONS_CLIENT: label, FAKE_CLAUDE_LOG: log },
  });
  const messages = [];
  let stderr = '';
  let rest = '';
  const waiters = [];
  const check = () => {
    for (const w of [...waiters]) {
      const found = messages.find(w.match);
      if (found) {
        waiters.splice(waiters.indexOf(w), 1);
        w.resolve(found);
      }
    }
  };
  child.stdout.on('data', (chunk) => {
    rest += chunk;
    let i;
    while ((i = rest.indexOf('\n')) >= 0) {
      messages.push(JSON.parse(rest.slice(0, i)));
      rest = rest.slice(i + 1);
    }
    check();
  });
  child.stderr.on('data', (chunk) => (stderr += chunk));
  const exited = new Promise((resolve) => child.on('exit', (code) => resolve(code)));
  return {
    messages,
    exited,
    stderr: () => stderr,
    send: (m) => child.stdin.write(`${JSON.stringify(m)}\n`),
    say: (text) => child.stdin.write(`${JSON.stringify({ type: 'user', message: { role: 'user', content: text } })}\n`),
    initialize: (id) => child.stdin.write(`${JSON.stringify({ type: 'control_request', request_id: id, request: { subtype: 'initialize' } })}\n`),
    waitFor: (match, ms = 5000) =>
      new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`timed out; got ${JSON.stringify(messages)} ${stderr}`)), ms);
        waiters.push({ match, resolve: (m) => (clearTimeout(timer), resolve(m)) });
        check();
      }),
    close: async () => {
      child.kill('SIGTERM');
      await exited;
    },
  };
}

const starts = async (sessionId) =>
  (await readFile(log, 'utf8').catch(() => '')).split('\n').filter((l) => l.split(' ')[1] === sessionId).length;
const isResult = (m) => m.type === 'result';
const sessionOf = async (p) => (await p.waitFor((m) => m.type === 'system' && m.subtype === 'init')).session_id;
const settle = () => new Promise((r) => setTimeout(r, 300));

test('a turn keeps running when its window goes, and the next window joins it instead of starting another', async () => {
  const a = panel('the desktop');
  a.initialize('a1');
  a.say('sleep:1500');
  const id = await sessionOf(a);
  await a.close();
  const b = panel('the phone view', ['--resume', id]);
  b.initialize('b1');
  const result = await b.waitFor(isResult);
  assert.equal(result.session_id, id);
  assert.equal(await starts(id), 1, 'one process per conversation: a window reopening a running turn joins it');
  await b.close();
});

test('an idle session reopened starts afresh with the new window’s command line', async () => {
  const a = panel('the desktop');
  a.say('sleep:0');
  const id = await sessionOf(a);
  await a.waitFor(isResult);
  await a.close();
  const b = panel('the desktop', ['--resume', id, '--model', 'other']);
  b.say('sleep:0');
  await b.waitFor(isResult);
  const lines = (await readFile(log, 'utf8')).split('\n').filter((l) => l.split(' ')[1] === id);
  assert.equal(lines.length, 2);
  assert.match(lines[1], /--model other/, 'an idle reopen restarts with the arguments the new panel asked for');
  assert.equal(host.sessions().filter((s) => s.sessionId === id).length, 1, 'the old process is gone before the new one starts');
  await b.close();
});

test('a window cannot open a session another window holds until the person moves it', async () => {
  const a = panel('the desktop');
  a.say('sleep:0');
  const id = await sessionOf(a);
  await a.waitFor(isResult);

  const refused = panel('the phone view', ['--resume', id]);
  assert.equal(await refused.exited, 1);
  assert.match(refused.stderr(), /running in the desktop/, 'the refusal names where the session is');
  assert.equal(await starts(id), 1, 'a refused window starts nothing');

  const { connect } = await import('node:net');
  await new Promise((resolve) => {
    const s = connect(join(dir, '.agent-sessions', 'host', 'host.sock'));
    s.on('connect', () => s.write(`${JSON.stringify({ op: 'allow-takeover', protocol: 1, sessionId: id })}\n`));
    s.on('data', () => (s.destroy(), resolve()));
  });
  const moved = panel('the phone view', ['--resume', id]);
  assert.equal(await a.exited, 0, 'the window that lost the session ends quietly');
  assert.match(a.stderr(), /moved to the phone view/, 'and its log says where the session went');
  moved.say('sleep:0');
  await moved.waitFor(isResult);
  await moved.close();
});

test('with no window connected, hooks are answered so the turn finishes', async () => {
  const a = panel('the desktop');
  a.say('sleep:0');
  const id = await sessionOf(a);
  await a.waitFor(isResult);
  // Idle sessions restart on reopen; start the hook turn in a fresh process and leave straight away.
  const b = panel('the desktop', ['--resume', id]);
  b.say('hook');
  await b.waitFor((m) => m.type === 'control_request');
  await b.close();
  await settle();
  const hosted = host.sessions().find((s) => s.sessionId === id);
  assert.equal(hosted?.state, 'idle', 'the hook the panel would have answered got an empty answer and the turn ended');
});

test('a permission question asked while no window is connected is asked again in the next one', async () => {
  const a = panel('the desktop');
  a.initialize('a1');
  a.say('ask');
  const id = await sessionOf(a);
  const asked = await a.waitFor((m) => m.type === 'control_request' && m.request.subtype === 'can_use_tool');
  await a.close();
  await settle();
  assert.equal(host.sessions().find((s) => s.sessionId === id)?.state, 'waiting');

  const b = panel('the phone view', ['--resume', id]);
  b.initialize('b1');
  const again = await b.waitFor((m) => m.type === 'control_request' && m.request.subtype === 'can_use_tool');
  assert.equal(again.request_id, asked.request_id, 'the same question, so the answer reaches the waiting turn');
  const order = b.messages.map((m) => m.type);
  assert.ok(order.indexOf('control_response') < order.indexOf('control_request'), 'asked only after the panel is initialized');
  b.send({ type: 'control_response', response: { subtype: 'success', request_id: again.request_id, response: { behavior: 'allow' } } });
  const result = await b.waitFor(isResult);
  assert.match(result.result, /allow/);
  assert.equal(await starts(id), 1, 'the waiting turn was joined, not restarted');
  await b.close();
});

test('two windows opening the same session at once start one process', async () => {
  const a = panel('the desktop');
  a.say('sleep:0');
  const id = await sessionOf(a);
  await a.waitFor(isResult);
  await a.close();
  const before = await starts(id);
  const x = panel('the desktop', ['--resume', id]);
  const y = panel('the phone view', ['--resume', id]);
  const codes = await Promise.race([Promise.any([x.exited, y.exited]), settle().then(settle).then(() => 'none')]);
  assert.equal(codes, 1, 'the second is refused');
  await settle();
  assert.equal((await starts(id)) - before, 1, 'one process for both');
  await x.close();
  await y.close();
});

test('a panel closed before its first message leaves no process behind', async () => {
  const count = () => host.sessions().filter((s) => !s.sessionId).length;
  const before = count();
  const a = panel('the desktop');
  a.initialize('a1');
  await a.waitFor((m) => m.type === 'control_response');
  assert.equal(count(), before + 1);
  await a.close();
  await settle();
  assert.equal(count(), before, 'nothing can reopen a session that never announced its id, so it stops at once');
});
