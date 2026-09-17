import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import { mkdtemp, rm, mkdir, writeFile, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { build } from 'esbuild';

const require = createRequire(import.meta.url);
const directory = await mkdtemp(join(tmpdir(), 'agent-sessions-accounts-test-'));
const bundle = join(directory, 'accounts.cjs');
await build({ stdin: { contents: `export * from './src/codex-accounts.ts';`, resolveDir: process.cwd() }, bundle: true, platform: 'node', format: 'cjs', outfile: bundle });
const { listCodexAccounts, activateCodexAccount, decodeCodexAuth } = require(bundle);
after(() => rm(directory, { recursive: true, force: true }));

function auth(accountId, email, lastRefresh, plan = 'pro') {
  const claims = { email, 'https://api.openai.com/auth': { chatgpt_account_id: accountId, chatgpt_plan_type: plan, chatgpt_subscription_active_until: '2026-10-07T09:09:10+00:00' } };
  const idToken = ['e30', Buffer.from(JSON.stringify(claims)).toString('base64url'), 'sig'].join('.');
  return JSON.stringify({ auth_mode: 'chatgpt', OPENAI_API_KEY: null, tokens: { id_token: idToken, access_token: 'a', refresh_token: 'r', account_id: accountId }, last_refresh: lastRefresh });
}

async function home(name) {
  const h = join(directory, name);
  await mkdir(join(h, 'auth-profiles'), { recursive: true });
  await mkdir(join(h, 'auth-backup.x'), { recursive: true });
  return h;
}

test('decodes the account from the id_token claims without verifying it', () => {
  const identity = decodeCodexAuth(JSON.parse(auth('acc-1', 'a@example.com', '2026-09-15T00:00:00Z', 'plus')));
  assert.deepEqual(identity, { accountId: 'acc-1', email: 'a@example.com', plan: 'plus', until: '2026-10-07T09:09:10+00:00' });
});

test('lists one entry per account, the active login first and stale duplicates dropped for fresher tokens', async () => {
  const h = await home('list');
  await writeFile(join(h, 'auth.json'), auth('acc-a', 'a@example.com', '2026-09-10T00:00:00Z'));
  await writeFile(join(h, 'auth-backup.x', 'auth.json'), auth('acc-b', 'b@example.com', '2026-09-07T00:00:00Z'));
  await writeFile(join(h, 'auth-profiles', 'acc-b.json'), auth('acc-b', 'b@example.com', '2026-09-15T00:00:00Z'));
  await writeFile(join(h, 'auth-profiles', 'acc-a.json'), auth('acc-a', 'a@example.com', '2026-09-16T00:00:00Z'));
  const accounts = await listCodexAccounts(h);
  assert.deepEqual(accounts.map((a) => [a.email, a.current, a.file.split('/').slice(-2).join('/')]), [
    ['a@example.com', true, 'list/auth.json'],
    ['b@example.com', false, 'auth-profiles/acc-b.json'],
  ], 'the active file wins for its account even when a profile is newer; the freshest copy wins otherwise');
});

test('activating a saved login profiles the current one first and writes auth.json privately', async () => {
  const h = await home('switch');
  await writeFile(join(h, 'auth.json'), auth('acc-a', 'a@example.com', '2026-09-10T00:00:00Z'));
  await writeFile(join(h, 'auth-profiles', 'acc-b.json'), auth('acc-b', 'b@example.com', '2026-09-15T00:00:00Z'));
  const b = (await listCodexAccounts(h)).find((a) => a.email === 'b@example.com');
  await activateCodexAccount(h, b);
  assert.equal(decodeCodexAuth(JSON.parse(await readFile(join(h, 'auth.json'), 'utf8'))).email, 'b@example.com');
  assert.equal(decodeCodexAuth(JSON.parse(await readFile(join(h, 'auth-profiles', 'acc-a.json'), 'utf8'))).email, 'a@example.com', 'the login switched away from is kept');
  if (process.platform !== 'win32') assert.equal((await stat(join(h, 'auth.json'))).mode & 0o777, 0o600);
  const after = await listCodexAccounts(h);
  assert.deepEqual(after.map((a) => [a.email, a.current]), [['b@example.com', true], ['a@example.com', false]]);
});
