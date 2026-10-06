import { spawn } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';
import { lock } from 'proper-lockfile';
import { decodeCodexAuth, type CodexCredentials } from './codex-identity.js';
export type { CodexCredentials } from './codex-identity.js';
import { readJsonFile } from './util.js';

export interface ClaudeCredentials {
  claudeAiOauth?: {
    accessToken?: string;
    refreshToken?: string;
    expiresAt?: number;
    refreshTokenExpiresAt?: number;
    clientId?: string;
    scopes?: string[];
    subscriptionType?: string;
    rateLimitTier?: string;
  };
}

/** Replace complete credentials privately, preserving fields we do not interpret. */
export async function writeCredentials(file: string, credentials: object): Promise<void> {
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, JSON.stringify(credentials, null, 2) + '\n', { mode: 0o600 });
    await fs.rename(temporary, file);
  } finally {
    await fs.rm(temporary, { force: true });
  }
}

export function tokenExpiresSoon(token: string | undefined): boolean {
  try {
    const claims: unknown = JSON.parse(Buffer.from(token?.split('.')[1] ?? '', 'base64url').toString());
    return !!claims && typeof claims === 'object' && 'exp' in claims && typeof claims.exp === 'number' && claims.exp * 1000 <= Date.now() + 60_000;
  } catch {
    return false;
  }
}

const retries = { retries: 25, minTimeout: 100, maxTimeout: 1000 };

/** Shares Claude Code's current and legacy refresh locks, then re-reads before rotating its token. */
export async function refreshClaudeCredentials(home: string, rejectedToken?: string) {
  const file = path.join(home, '.credentials.json');
  const abort = new AbortController();
  const options = { realpath: false, stale: 60_000, update: 5000, retries, onCompromised: () => abort.abort() };
  const release = await lock(home, { ...options, lockfilePath: path.join(home, '.oauth_refresh.lock') });
  try {
    const legacy = `${await fs.realpath(home)}.lock`;
    const releaseLegacy = await lock(legacy, { ...options, lockfilePath: legacy });
    try {
      const before = await readJsonFile<ClaudeCredentials>(file);
      const oauth = before?.claudeAiOauth;
      if (!before || !oauth?.accessToken) throw new Error('Sign in again to Claude Code from the Usage view.');
      if (rejectedToken ? oauth.accessToken !== rejectedToken : !oauth.expiresAt || oauth.expiresAt > Date.now() + 60_000) return { ...before, claudeAiOauth: oauth };
      if (!oauth.refreshToken) throw new Error('Claude login cannot be refreshed. Choose Sign in again in the Usage view.');
      const response = await fetch('https://platform.claude.com/v1/oauth/token', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, redirect: 'error', signal: AbortSignal.any([abort.signal, AbortSignal.timeout(30_000)]),
        body: JSON.stringify({ grant_type: 'refresh_token', refresh_token: oauth.refreshToken, client_id: oauth.clientId ?? '9d1c250a-e61b-44d9-88ed-5944d1962f5e', ...(oauth.scopes?.length ? { scope: oauth.scopes.join(' ') } : {}) }),
      });
      if (!response.ok) throw new Error(`Claude login refresh failed (HTTP ${response.status}). Choose Sign in again in the Usage view.`);
      const data: unknown = await response.json();
      if (!data || typeof data !== 'object' || !('access_token' in data) || typeof data.access_token !== 'string' || !data.access_token
        || !('expires_in' in data) || typeof data.expires_in !== 'number' || !Number.isFinite(data.expires_in) || data.expires_in <= 0) throw new Error('Claude returned an invalid login refresh response.');
      const latest = await readJsonFile<ClaudeCredentials>(file);
      if (latest?.claudeAiOauth?.accessToken !== oauth.accessToken || latest.claudeAiOauth.refreshToken !== oauth.refreshToken) {
        if (!latest?.claudeAiOauth?.accessToken) throw new Error('Claude login changed during refresh.');
        return { ...latest, claudeAiOauth: latest.claudeAiOauth };
      }
      const updated = { ...latest, claudeAiOauth: {
        ...latest.claudeAiOauth, accessToken: data.access_token, expiresAt: Date.now() + data.expires_in * 1000,
        ...('refresh_token' in data && typeof data.refresh_token === 'string' && data.refresh_token ? { refreshToken: data.refresh_token } : {}),
        ...('scope' in data && typeof data.scope === 'string' ? { scopes: data.scope.split(' ') } : {}),
        ...('refresh_token_expires_in' in data && typeof data.refresh_token_expires_in === 'number' ? { refreshTokenExpiresAt: Date.now() + data.refresh_token_expires_in * 1000 } : {}),
      } };
      if (abort.signal.aborted) throw new Error('Claude login refresh lost its credential lock; retry later.');
      await writeCredentials(file, updated);
      return updated;
    } finally {
      await releaseLegacy();
    }
  } finally {
    await release();
  }
}

/** Native app-server owns the token exchange and its credential locks. This never starts a conversation. */
export function refreshNativeCodex(home: string, executable = 'codex'): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, ['app-server', '-c', 'cli_auth_credentials_store="file"'], {
      env: { ...process.env, CODEX_HOME: home }, stdio: ['pipe', 'pipe', 'ignore'],
    });
    const lines = createInterface({ input: child.stdout });
    let done = false;
    const finish = (error?: Error) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      lines.close();
      child.stdin.end();
      child.kill();
      if (error) reject(error); else resolve();
    };
    const timer = setTimeout(() => finish(new Error('Codex login refresh timed out.')), 45_000);
    child.on('error', () => finish(new Error('Could not start Codex to refresh its login.')));
    child.on('exit', () => finish(new Error('Codex exited before refreshing its login.')));
    child.stdin.on('error', () => finish(new Error('Codex closed the login refresh connection.')));
    const send = (message: object) => child.stdin.write(JSON.stringify(message) + '\n');
    lines.on('line', (line) => {
      let reply: { id?: number; error?: unknown; result?: { account?: { type?: string } | null } };
      try { reply = JSON.parse(line) as typeof reply; } catch { return; }
      if (reply.id !== 1 && reply.id !== 2) return;
      // Do not expose a provider error body: it can include credential material.
      if (reply.error) { finish(new Error('Codex could not refresh this login. Choose Sign in again in the Usage view.')); return; }
      if (reply.id === 1) {
        send({ method: 'initialized' });
        send({ id: 2, method: 'account/read', params: { refreshToken: true } });
      } else {
        finish(reply.result?.account?.type === 'chatgpt' ? undefined : new Error('Sign in again to this ChatGPT account from the Usage view.'));
      }
    });
    send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'agent_sessions_auth', version: '1' }, capabilities: null } });
  });
}

/** All extension account writers share one lock, including saved-profile refresh and switching. */
export async function withCodexAccountLock<T>(home: string, work: (assertHeld: () => void) => Promise<T>): Promise<T> {
  await fs.mkdir(home, { recursive: true, mode: 0o700 });
  let compromised: Error | undefined;
  const release = await lock(home, { realpath: false, lockfilePath: path.join(home, '.agent-sessions-auth.lock'), stale: 60_000, retries, onCompromised: error => { compromised = error; } });
  try {
    return await work(() => { if (compromised) throw new Error('The account lock was lost. Try again.'); });
  } finally {
    await release();
  }
}

function codexAccountHome(file: string): string {
  const directory = path.dirname(file);
  const name = path.basename(directory);
  return name === 'auth-profiles' || name.startsWith('auth-backup.') ? path.dirname(directory) : directory;
}

/** Saved profiles refresh in an isolated home; the active account is never swapped to do it. */
export async function refreshCodexCredentials(file: string, rejectedToken: string, executable = 'codex'): Promise<CodexCredentials> {
  const home = codexAccountHome(file);
  return withCodexAccountLock(home, async (assertHeld) => {
    const before = await readJsonFile<CodexCredentials>(file);
    if (!before?.tokens?.access_token) throw new Error('Sign in again to ChatGPT from the Usage view.');
    const activeFile = path.join(home, 'auth.json');
    const active = file !== activeFile ? await readJsonFile<CodexCredentials>(activeFile) : undefined;
    const identity = decodeCodexAuth(before).accountId;
    // The usage list may have called this account inactive before the user switched to it.
    // Recheck under the same lock as switching: never rotate a now-active profile in isolation.
    if (identity && active?.tokens?.access_token && decodeCodexAuth(active).accountId === identity) {
      const token = active.tokens.access_token;
      let renewed = active;
      if (token === rejectedToken || tokenExpiresSoon(token)) {
        await refreshNativeCodex(home, executable);
        const result = await readJsonFile<CodexCredentials>(activeFile);
        if (!result?.tokens?.access_token || result.tokens.access_token === token) throw new Error('Codex did not renew this login. Choose Sign in again in the Usage view.');
        renewed = result;
      }
      assertHeld();
      await writeCredentials(file, renewed);
      return renewed;
    }
    if (before.tokens.access_token !== rejectedToken) return before;
    if (!before.tokens.refresh_token) throw new Error('This ChatGPT login cannot be refreshed. Choose Sign in again in the Usage view.');
    if (path.basename(file) === 'auth.json') {
      await refreshNativeCodex(path.dirname(file), executable);
      const refreshed = await readJsonFile<CodexCredentials>(file);
      if (!refreshed?.tokens?.access_token || refreshed.tokens.access_token === rejectedToken) throw new Error('Codex did not renew this login. Choose Sign in again in the Usage view.');
      return refreshed;
    }
    const refreshHome = await fs.mkdtemp(path.join(path.dirname(file), '.refresh-'));
    await fs.chmod(refreshHome, 0o700);
    try {
      await writeCredentials(path.join(refreshHome, 'auth.json'), before);
      await refreshNativeCodex(refreshHome, executable);
      const updated = await readJsonFile<CodexCredentials>(path.join(refreshHome, 'auth.json'));
      if (!updated?.tokens?.access_token || updated.tokens.access_token === rejectedToken) throw new Error('Codex did not renew this saved login. Choose Sign in again in the Usage view.');
      const latest = await readJsonFile<CodexCredentials>(file);
      if (latest?.tokens?.access_token !== rejectedToken || latest.tokens.refresh_token !== before.tokens.refresh_token) {
        if (!latest?.tokens?.access_token) throw new Error('Saved login changed during refresh.');
        return latest;
      }
      const merged = { ...latest, ...updated, tokens: { ...latest.tokens, ...updated.tokens } };
      assertHeld();
      await writeCredentials(file, merged);
      return merged;
    } finally {
      await fs.rm(refreshHome, { recursive: true, force: true });
    }
  });
}
