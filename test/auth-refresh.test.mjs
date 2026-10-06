import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import { mkdtemp, mkdir, writeFile, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { build } from 'esbuild';

const dir = await mkdtemp(join(tmpdir(), 'auth-refresh-'));
const bundle = join(dir, 'auth.cjs');
await build({ stdin: { contents: `export * from './src/auth-refresh.ts'; export * from './src/usage.ts'; export * from './src/codex-accounts.ts';`, resolveDir: process.cwd() }, bundle: true, platform: 'node', format: 'cjs', outfile: bundle });
const { refreshClaudeCredentials, refreshCodexCredentials, fetchClaudeUsage, readCodexUsage, readInactiveCodexUsage, importCodexLogin } = createRequire(import.meta.url)(bundle);
after(() => rm(dir, { recursive: true, force: true }));
const json = async file => JSON.parse(await readFile(file, 'utf8'));
const auth = id => ({ auth_mode: 'chatgpt', tokens: { access_token: 'old', refresh_token: 'refresh', account_id: id }, metadata: { keep: true } });
async function fixture() { return mkdtemp(join(dir, 'case-')); }
const cli = join(dir, 'codex');
await writeFile(cli, `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const file = path.join(process.env.CODEX_HOME, 'auth.json');
require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
 const m = JSON.parse(line);
 if (m.method === 'initialized') return;
 if (m.method === 'initialize') { process.stdout.write(JSON.stringify({ id: m.id, result: {} })+'\\n'); return; }
 if (m.method !== 'account/read' || !m.params.refreshToken) process.exit(3);
 const auth = JSON.parse(fs.readFileSync(file));
 if (auth.tokens.access_token === 'new') process.exit(7);
 auth.tokens.access_token = 'new'; auth.tokens.refresh_token = 'rotated'; auth.last_refresh = new Date().toISOString();
 fs.writeFileSync(file, JSON.stringify(auth));
 process.stdout.write(JSON.stringify({ id: m.id, result: { account: { type: 'chatgpt' } } })+'\\n');
});
`, { mode: 0o700 });

test('Claude refresh is serialized, preserves unrelated credentials, and saves rotated tokens privately', async t => {
  const home = await fixture(); const file = join(home, '.credentials.json');
  await writeFile(file, JSON.stringify({ other: { keep: true }, claudeAiOauth: { accessToken: 'old', refreshToken: 'refresh', expiresAt: 1, subscriptionType: 'max', clientId: 'saved-client', scopes: ['user:profile'] } }));
  let requests = 0;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    requests++;
    assert.equal(JSON.parse(options.body).client_id, 'saved-client');
    await new Promise(resolve => setTimeout(resolve, 30));
    return Response.json({ access_token: 'new', refresh_token: 'rotated', expires_in: 3600 });
  });
  const results = await Promise.all([refreshClaudeCredentials(home), refreshClaudeCredentials(home)]);
  assert.equal(requests, 1, 'concurrent windows must not spend the same refresh token twice');
  assert.ok(results.every(r => r.claudeAiOauth.accessToken === 'new'));
  const saved = await json(file);
  assert.equal(saved.claudeAiOauth.refreshToken, 'rotated');
  assert.deepEqual(saved.other, { keep: true });
  assert.equal((await stat(file)).mode & 0o777, 0o600);
});

test('Claude usage refreshes on 401 and retries once with the replacement credential', async t => {
  const home = await fixture();
  await writeFile(join(home, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'old', refreshToken: 'refresh', expiresAt: Date.now() + 3600_000 } }));
  const tokens = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    if (url.includes('/v1/oauth/token')) return Response.json({ access_token: 'new', expires_in: 3600 });
    tokens.push(options.headers.Authorization);
    return tokens.length === 1 ? new Response('', { status: 401 }) : Response.json({ five_hour: { utilization: 17 } });
  });
  const result = await fetchClaudeUsage(home, true, join(home, 'cache'), 120000);
  assert.equal(result.windows[0].percent, 17);
  assert.deepEqual(tokens, ['Bearer old', 'Bearer new']);
});

test('network disabled never renews credentials; malformed or rejected refreshes preserve the old file', async t => {
  const home = await fixture(); const file = join(home, '.credentials.json');
  const bytes = JSON.stringify({ claudeAiOauth: { accessToken: 'old', refreshToken: 'refresh', expiresAt: 1 } });
  await writeFile(file, bytes);
  t.mock.method(globalThis, 'fetch', async () => { assert.fail('network disabled'); });
  await fetchClaudeUsage(home, false, join(home, 'cache'), 120000);
  t.mock.method(globalThis, 'fetch', async () => Response.json({ access_token: 'new' }));
  await assert.rejects(refreshClaudeCredentials(home), /invalid login refresh/);
  assert.equal(await readFile(file, 'utf8'), bytes);
  t.mock.method(globalThis, 'fetch', async () => new Response('secret must not be reported', { status: 400 }));
  await assert.rejects(refreshClaudeCredentials(home), error => /Sign in again/.test(error.message) && !error.message.includes('secret'));
  assert.equal(await readFile(file, 'utf8'), bytes);
});

test('a saved Codex profile refreshes through native auth without switching the active account', async t => {
  const home = await fixture(); const file = join(home, 'saved.json');
  const active = JSON.stringify(auth('active'));
  await writeFile(join(home, 'auth.json'), active); await writeFile(file, JSON.stringify(auth('saved')));
  const tokens = [];
  t.mock.method(globalThis, 'fetch', async (_, options) => {
    tokens.push(options.headers.Authorization);
    assert.equal(options.headers['chatgpt-account-id'], 'saved');
    return tokens.length === 1 ? new Response('', { status: 401 }) : Response.json({ rate_limit: { primary_window: { used_percent: 42 } } });
  });
  const result = await readInactiveCodexUsage({ file, accountId: 'saved' }, cli);
  assert.equal(result.windows[0].percent, 42);
  assert.deepEqual(tokens, ['Bearer old', 'Bearer new']);
  assert.equal((await json(file)).tokens.refresh_token, 'rotated');
  assert.equal(await readFile(join(home, 'auth.json'), 'utf8'), active, 'the active credential is byte-for-byte unchanged');
});

test('Codex usage automatically refreshes an expired active token before its first request', async t => {
  const home = await fixture(); const credentials = auth('active');
  credentials.tokens.access_token = 'e30.' + Buffer.from(JSON.stringify({ exp: 1 })).toString('base64url') + '.sig';
  await writeFile(join(home, 'auth.json'), JSON.stringify(credentials));
  t.mock.method(globalThis, 'fetch', async (_, options) => {
    assert.equal(options.headers.Authorization, 'Bearer new');
    return Response.json({ rate_limit: { primary_window: { used_percent: 11 } } });
  });
  assert.equal((await readCodexUsage(home, true, cli)).windows[0].percent, 11);
});

test('simultaneous saved-account refreshes reuse the credential already renewed by another window', async () => {
  const home = await fixture(); const file = join(home, 'saved.json');
  await writeFile(file, JSON.stringify(auth('saved')));
  const results = await Promise.all([refreshCodexCredentials(file, 'old', cli), refreshCodexCredentials(file, 'old', cli)]);
  assert.ok(results.every(r => r.tokens.access_token === 'new'));
});

test('interactive login renews a saved account without switching; a wrong-account login is rejected', async () => {
  const home = await fixture(); const file = join(home, 'auth.json');
  const active = JSON.stringify(auth('active')); await writeFile(file, active);
  const renewed = auth('saved'); renewed.tokens.access_token = 'signed-in';
  await importCodexLogin(home, renewed, 'saved');
  assert.equal(await readFile(file, 'utf8'), active);
  assert.equal((await json(join(home, 'auth-profiles', 'saved.json'))).tokens.access_token, 'signed-in');
  await assert.rejects(importCodexLogin(home, auth('wrong'), 'saved'), /different ChatGPT account/);
  assert.equal(await readFile(file, 'utf8'), active);
});

test('account switching waits for saved-token renewal, and sign-in rechecks the active identity under that lock', async () => {
  const { withCodexAccountLock, activateCodexAccount, writeCredentials } = createRequire(import.meta.url)(bundle);
  const home = await fixture(); const activeFile = join(home, 'auth.json');
  const profiles = join(home, 'auth-profiles'); await mkdir(profiles);
  const savedFile = join(profiles, 'saved.json');
  await writeCredentials(activeFile, auth('active')); await writeCredentials(savedFile, auth('saved'));
  let acquired; const ready = new Promise(r => { acquired = r; });
  let release; const gate = new Promise(r => { release = r; });
  const renewing = withCodexAccountLock(home, async () => {
    acquired(); await gate;
    const fresh = auth('saved'); fresh.tokens.access_token = 'renewed';
    await writeCredentials(savedFile, fresh);
  });
  await ready;
  const switching = activateCodexAccount(home, { file: savedFile, current: false });
  await new Promise(r => setTimeout(r, 20));
  assert.equal((await json(activeFile)).tokens.account_id, 'active', 'switch waits instead of copying a token about to rotate');
  release(); await Promise.all([renewing, switching]);
  assert.equal((await json(activeFile)).tokens.access_token, 'renewed');
  await importCodexLogin(home, auth('active'), 'active');
  assert.equal((await json(activeFile)).tokens.account_id, 'saved', 'finishing the old login cannot undo the new active account');
});

test('a queued saved-profile refresh rechecks an account switched active before the refresh lock was acquired', async () => {
  const { activateCodexAccount, writeCredentials } = createRequire(import.meta.url)(bundle);
  const home = await fixture(); await mkdir(join(home, 'auth-profiles'));
  const file = join(home, 'auth-profiles', 'saved.json');
  await writeCredentials(join(home, 'auth.json'), auth('active'));
  await writeCredentials(file, auth('saved'));
  await activateCodexAccount(home, { file, current: false });
  const renewed = await refreshCodexCredentials(file, 'old', cli);
  assert.equal(renewed.tokens.refresh_token, 'rotated');
  assert.deepEqual((await json(join(home, 'auth.json'))).tokens, renewed.tokens, 'a now-active account must be renewed in its native home');
  assert.deepEqual((await json(file)).tokens, renewed.tokens, 'the saved copy follows its now-active login');
});
