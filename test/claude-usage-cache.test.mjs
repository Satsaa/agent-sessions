import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import { mkdtemp, rm, writeFile, readdir, readFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { build } from 'esbuild';

const directory = await mkdtemp(join(tmpdir(), 'agent-sessions-cache-test-'));
const bundle = join(directory, 'cache.cjs');
await build({ stdin: { contents: `export * from './src/claude-usage-cache.ts'; export * from './src/usage.ts';`, resolveDir: process.cwd() }, bundle: true, platform: 'node', format: 'cjs', outfile: bundle });
const { cachedClaudeUsage, fetchClaudeUsage } = createRequire(import.meta.url)(bundle);
after(() => rm(directory, { recursive: true, force: true }));
const interval = 120_000;
const payload = { five_hour: { utilization: 40 } };
const success = () => Promise.resolve(Response.json(payload));

async function fixture(t) {
  const folder = await mkdtemp(join(directory, 'case-'));
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  return { folder, advance: (ms) => { now += ms; } };
}

test('simultaneous refreshes share one request and subsequent reads reuse it', async (t) => {
  const { folder } = await fixture(t);
  let calls = 0;
  const request = async () => { calls++; await new Promise(resolve => setTimeout(resolve, 40)); return Response.json(payload); };
  const results = await Promise.all(Array.from({ length: 4 }, () => cachedClaudeUsage(folder, 'account', interval, request)));
  assert.equal(calls, 1);
  for (const result of results) assert.deepEqual(result.data, payload);
  await cachedClaudeUsage(folder, 'account', interval, request);
  assert.equal(calls, 1);
});

test('separate extension processes share the request lock', async () => {
  const folder = await mkdtemp(join(directory, 'processes-'));
  const log = join(directory, 'requests.log');
  const script = `
    const { cachedClaudeUsage } = require(process.argv[1]);
    const { appendFile } = require('node:fs/promises');
    cachedClaudeUsage(process.argv[2], 'account', 120000, async () => {
      await appendFile(process.argv[3], 'request\\n');
      await new Promise(resolve => setTimeout(resolve, 200));
      return Response.json({ five_hour: { utilization: 40 } });
    }).catch(error => { console.error(error); process.exitCode = 1; });
  `;
  const run = () => promisify(execFile)(process.execPath, ['-e', script, bundle, folder, log]);
  await Promise.all([run(), run()]);
  assert.equal(await readFile(log, 'utf8'), 'request\n');
});

test('429 preserves the last reading and prevents requests until Retry-After', async (t) => {
  const { folder, advance } = await fixture(t);
  const first = await cachedClaudeUsage(folder, 'account', interval, success);
  advance(interval);
  const limited = await cachedClaudeUsage(folder, 'account', interval, async () => new Response('', { status: 429, headers: { 'Retry-After': '900' } }));
  assert.deepEqual(limited.data, payload);
  assert.equal(limited.asOf, first.asOf);
  assert.equal(limited.nextFetchAt, Date.now() + 900_000);
  advance(899_999);
  const cached = await cachedClaudeUsage(folder, 'account', interval, () => { assert.fail('cooldown must suppress requests'); });
  assert.match(cached.error, /429/);
  advance(1);
  const recovered = await cachedClaudeUsage(folder, 'account', interval, success);
  assert.equal(recovered.error, undefined);
  assert.equal(recovered.failures, 0);
});

test('repeated 429s without Retry-After progressively back off', async (t) => {
  const { folder, advance } = await fixture(t);
  for (const delay of [300_000, 600_000, 1_200_000, 2_400_000, 3_600_000]) {
    const result = await cachedClaudeUsage(folder, 'account', interval, async () => new Response('', { status: 429 }));
    assert.equal(result.nextFetchAt - Date.now(), delay);
    advance(delay);
  }
});

test('HTTP-date Retry-After is respected', async (t) => {
  const { folder } = await fixture(t);
  const date = new Date(Date.now() + 1_800_000).toUTCString();
  const result = await cachedClaudeUsage(folder, 'account', interval, async () => new Response('', { status: 429, headers: { 'Retry-After': date } }));
  assert.equal(result.nextFetchAt, Date.parse(date));
});

test('network failures preserve usage and suppress immediate retries', async (t) => {
  const { folder, advance } = await fixture(t);
  await cachedClaudeUsage(folder, 'account', interval, success);
  advance(interval);
  const result = await cachedClaudeUsage(folder, 'account', interval, async () => { throw new Error('offline'); });
  assert.deepEqual(result.data, payload);
  assert.match(result.error, /offline/);
  await cachedClaudeUsage(folder, 'account', interval, () => { assert.fail('failure cooldown must suppress requests'); });
});

test('account changes cannot reuse another account’s cached usage', async (t) => {
  const { folder } = await fixture(t);
  await cachedClaudeUsage(folder, 'account-a', interval, success);
  const second = { five_hour: { utilization: 90 } };
  const result = await cachedClaudeUsage(folder, 'account-b', interval, async () => Response.json(second));
  assert.deepEqual(result.data, second);
});

test('malformed cached metadata is discarded', async (t) => {
  const { folder } = await fixture(t);
  await cachedClaudeUsage(folder, 'account', interval, success);
  const [file] = await readdir(folder);
  await writeFile(join(folder, file), JSON.stringify({ nextFetchAt: 'forever' }));
  let calls = 0;
  await cachedClaudeUsage(folder, 'account', interval, () => { calls++; return success(); });
  assert.equal(calls, 1);
});


test('token rotation retains usage and cooldown for the same account, but never another account', async (t) => {
  const { folder, advance } = await fixture(t);
  const first = await cachedClaudeUsage(folder, 'old-token', interval, success, 'account-a');
  advance(interval);
  const limited = await cachedClaudeUsage(folder, 'refreshed-token', interval, async () => new Response('', { status: 429 }), 'account-a');
  assert.deepEqual(limited.data, payload);
  assert.equal(limited.asOf, first.asOf);
  await cachedClaudeUsage(folder, 'yet-another-token', interval, () => assert.fail('rotation must respect the account cooldown'), 'account-a');
  const other = await cachedClaudeUsage(folder, 'other-token', interval, async () => new Response('', { status: 429 }), 'account-b');
  assert.equal(other.data, undefined);
});

test('the first account-keyed refresh preserves an existing token-keyed reading on a 429', async (t) => {
  const { folder, advance } = await fixture(t);
  await cachedClaudeUsage(folder, 'token', interval, success);
  advance(interval);
  const limited = await cachedClaudeUsage(folder, 'token', interval, async () => new Response('', { status: 429 }), 'account-a');
  assert.deepEqual(limited.data, payload);
});


test('fresh legacy readings migrate before the access token can rotate', async (t) => {
  const { folder, advance } = await fixture(t);
  await cachedClaudeUsage(folder, 'token', interval, success);
  await cachedClaudeUsage(folder, 'token', interval, () => assert.fail('fresh legacy reading should avoid fetch'), 'account-a');
  advance(interval);
  const limited = await cachedClaudeUsage(folder, 'rotated', interval, async () => new Response('', { status: 429 }), 'account-a');
  assert.deepEqual(limited.data, payload);
});

test('usage refresh retains counts across credential rotation and updates only after success', async (t) => {
  const { folder, advance } = await fixture(t);
  const home = join(folder, 'claude');
  await mkdir(home);
  await writeFile(`${home}.json`, JSON.stringify({ oauthAccount: { accountUuid: 'user-a', organizationUuid: 'org-a' } }));
  const credentials = token => writeFile(join(home, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: token } }));
  await credentials('old');
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    calls++;
    return calls === 2 ? new Response('', { status: 429 }) : Response.json({ five_hour: { utilization: calls === 1 ? 40 : 50 } });
  });
  const refresh = () => fetchClaudeUsage(home, true, join(folder, 'cache'), interval);
  const first = await refresh();
  await credentials('rotated');
  advance(interval);
  const limited = await refresh();
  assert.deepEqual(limited.windows, first.windows);
  assert.equal(limited.asOf, first.asOf);
  await refresh();
  assert.equal(calls, 2);
  advance(300_000);
  const next = await refresh();
  assert.equal(next.windows[0].percent, 50);
  assert.equal(next.error, undefined);
  assert.ok(next.asOf > first.asOf);
});
