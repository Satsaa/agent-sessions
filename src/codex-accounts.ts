import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { readJsonFile } from './util.js';
import { holdersOfFilesIn, startTimeOf } from './window.js';

/** The parts of `~/.codex/auth.json` this module reads; the file is otherwise copied byte for byte. */
interface CodexAuthFile {
  auth_mode?: string;
  last_refresh?: string;
  tokens?: { id_token?: string; account_id?: string };
}

interface CodexAuthClaims {
  chatgpt_account_id?: string;
  chatgpt_plan_type?: string;
  chatgpt_subscription_active_until?: string;
}

export interface CodexIdentity {
  accountId: string | undefined;
  email: string | undefined;
  plan: string | undefined;
  until: string | undefined;
}

export interface CodexAccount extends CodexIdentity {
  /** Where the credentials live: `auth.json` itself, a profile this extension saved, or a `auth-backup.*` copy. */
  file: string;
  /** ISO `last_refresh` of the tokens; newer wins when one account was found in several files. */
  refreshedAt: number;
  current: boolean;
}

/** Decode the ChatGPT id_token without verifying it: only the login owner reads this file, so the claims name the account. */
export function decodeCodexAuth(auth: CodexAuthFile | undefined): CodexIdentity {
  const none: CodexIdentity = { accountId: auth?.tokens?.account_id, email: undefined, plan: undefined, until: undefined };
  const payload = auth?.tokens?.id_token?.split('.')[1];
  if (!payload) return none;
  try {
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Record<string, unknown>;
    const openai = claims['https://api.openai.com/auth'] as CodexAuthClaims | undefined;
    return {
      accountId: openai?.chatgpt_account_id ?? none.accountId,
      email: typeof claims.email === 'string' ? claims.email : undefined,
      plan: openai?.chatgpt_plan_type,
      until: openai?.chatgpt_subscription_active_until,
    };
  } catch {
    return none;
  }
}

export function profilesDir(home: string): string {
  return path.join(home, 'auth-profiles');
}

async function readAccount(file: string, current: boolean): Promise<CodexAccount | undefined> {
  const auth = await readJsonFile<CodexAuthFile>(file);
  if (!auth?.tokens?.id_token) return undefined;
  const refreshedAt = auth.last_refresh ? Date.parse(auth.last_refresh) : NaN;
  return { ...decodeCodexAuth(auth), file, refreshedAt: Number.isFinite(refreshedAt) ? refreshedAt : 0, current };
}

/**
 * Every ChatGPT login found under the Codex home: the active `auth.json`, the profiles this extension saved and any
 * `auth-backup.*` copy left by a manual swap. One entry per account, the freshest tokens winning — except the active
 * login, which always represents its account, because Codex refreshes only that copy.
 */
export async function listCodexAccounts(home: string): Promise<CodexAccount[]> {
  const candidates: Promise<CodexAccount | undefined>[] = [readAccount(path.join(home, 'auth.json'), true)];
  for (const entry of await fsp.readdir(home, { withFileTypes: true }).catch(() => [])) {
    if (entry.isDirectory() && entry.name.startsWith('auth-backup.')) candidates.push(readAccount(path.join(home, entry.name, 'auth.json'), false));
  }
  for (const entry of await fsp.readdir(profilesDir(home), { withFileTypes: true }).catch(() => [])) {
    if (entry.isFile() && entry.name.endsWith('.json')) candidates.push(readAccount(path.join(profilesDir(home), entry.name), false));
  }
  const byAccount = new Map<string, CodexAccount>();
  for (const account of await Promise.all(candidates)) {
    if (!account) continue;
    const key = account.accountId ?? account.file;
    const seen = byAccount.get(key);
    if (!seen || account.current || (!seen.current && account.refreshedAt > seen.refreshedAt)) byAccount.set(key, account);
  }
  return [...byAccount.values()].sort((a, b) => Number(b.current) - Number(a.current) || (a.email ?? '').localeCompare(b.email ?? ''));
}

async function writePrivate(file: string, bytes: Buffer): Promise<void> {
  await fsp.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  await fsp.writeFile(tmp, bytes, { mode: 0o600 });
  await fsp.rename(tmp, file);
}

/** Keep the active login's (refreshed) tokens as a profile, so switching away never loses an account. */
export async function saveCurrentCodexAccount(home: string): Promise<CodexAccount | undefined> {
  const file = path.join(home, 'auth.json');
  const current = await readAccount(file, true);
  if (!current?.accountId) return undefined;
  await writePrivate(path.join(profilesDir(home), `${current.accountId}.json`), await fsp.readFile(file));
  return current;
}

/** Make `account` the active login. The current login is profiled first; tested in codex-accounts.test.mjs. */
export async function activateCodexAccount(home: string, account: CodexAccount): Promise<void> {
  if (account.current) return;
  const bytes = await fsp.readFile(account.file);
  const incoming = decodeCodexAuth(JSON.parse(bytes.toString('utf8')) as CodexAuthFile);
  if (!incoming.accountId) throw new Error(`${account.file} does not hold a ChatGPT login.`);
  await saveCurrentCodexAccount(home);
  await writePrivate(path.join(home, 'auth.json'), bytes);
}

export interface CodexProcess {
  pid: number;
  start: string;
  threadIds: string[];
}

/** Codex processes currently writing threads — each holds the login it started with and locks its threads until it exits. */
export async function runningCodexProcesses(home: string): Promise<CodexProcess[]> {
  if (process.platform !== 'linux') return [];
  const holders = await holdersOfFilesIn(path.join(home, 'thread-writer-locks'), 'codex');
  const byPid = new Map<number, string[]>();
  for (const [name, pid] of holders) {
    if (!name.endsWith('.lock')) continue;
    byPid.set(pid, [...(byPid.get(pid) ?? []), name.slice(0, -5)]);
  }
  const out: CodexProcess[] = [];
  for (const [pid, threadIds] of byPid) {
    const start = await startTimeOf(pid);
    if (start) out.push({ pid, start, threadIds: threadIds.sort() });
  }
  return out.sort((a, b) => a.pid - b.pid);
}

/** SIGTERM each approved process (re-checked by start time so a reused pid is never signalled) and wait for its locks to go. */
export async function stopCodexProcesses(home: string, approved: CodexProcess[]): Promise<void> {
  for (const p of approved) {
    if ((await startTimeOf(p.pid)) !== p.start) continue;
    try {
      process.kill(p.pid, 'SIGTERM');
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH')) throw error;
    }
  }
  const approvedPids = new Set(approved.map((p) => p.pid));
  for (let attempt = 0; attempt < 50; attempt++) {
    const remaining = (await runningCodexProcesses(home)).filter((p) => approvedPids.has(p.pid) && approved.some((a) => a.pid === p.pid && a.start === p.start));
    if (!remaining.length) return;
    await delay(100);
  }
  throw new Error('Codex did not release its sessions after being asked to stop; they may still be shutting down.');
}
