import * as vscode from 'vscode';
import * as fs from 'node:fs/promises';
import { watch } from 'node:fs';
import * as path from 'node:path';
import { bundledCodex } from './open.js';
import { importCodexLogin, profilesDir, type CodexAccount } from './codex-accounts.js';
import { readJsonFile } from './util.js';
import type { CodexCredentials } from './auth-refresh.js';

const pending = new Set<string>();

/** Login runs in its own home, so even signing into the wrong account cannot replace the active one. */
export async function signInCodexAccount(home: string, account: CodexAccount | undefined, refreshed: () => Promise<void>): Promise<void> {
  const key = account?.accountId ?? home;
  if (pending.has(key)) { void vscode.window.showInformationMessage('Sign-in is already open for this account.'); return; }
  pending.add(key);
  let directory: string | undefined;
  try {
    await fs.mkdir(profilesDir(home), { recursive: true, mode: 0o700 });
    directory = await fs.mkdtemp(path.join(profilesDir(home), '.login-'));
    await fs.chmod(directory, 0o700);
    const loginHome = directory;
    const terminal = vscode.window.createTerminal({
      name: `Sign in: ${account?.email ?? 'ChatGPT'}`,
      shellPath: bundledCodex() ?? 'codex', shellArgs: ['login', '--device-auth', '-c', 'cli_auth_credentials_store="file"'],
      env: { CODEX_HOME: loginHome },
    });
    terminal.show();
    const abort = new AbortController();
    const closed = vscode.window.onDidCloseTerminal((t) => { if (t === terminal) abort.abort(); });
    const timeout = setTimeout(() => abort.abort(), 15 * 60_000);
    try {
      const file = path.join(loginHome, 'auth.json');
      const complete = async () => {
        const credentials = await readJsonFile<CodexCredentials>(file);
        if (!credentials?.tokens?.access_token) return false;
        await importCodexLogin(home, credentials, account?.accountId);
        await refreshed();
        void vscode.window.showInformationMessage(`Signed in to ${account?.email ?? 'ChatGPT'}. Usage has been refreshed.`);
        return true;
      };
      await new Promise<void>((resolve, reject) => {
        let checking = false;
        let again = false;
        let finished = false;
        const finish = (error?: unknown) => {
          if (finished) return;
          finished = true;
          watcher.close();
          abort.signal.removeEventListener('abort', cancelled);
          if (error) reject(error); else resolve();
        };
        const cancelled = () => { if (!checking) finish(); };
        const check = async () => {
          if (finished) return;
          if (checking) { again = true; return; }
          checking = true;
          try {
            do {
              again = false;
              if (abort.signal.aborted || await complete()) { finish(); return; }
            } while (again);
          } catch (error) { finish(error); }
          finally { checking = false; if (abort.signal.aborted) finish(); }
        };
        // node:fs installs this watcher eagerly, before the first credential read.
        const watcher = watch(loginHome, () => { void check(); });
        watcher.on('error', finish);
        abort.signal.addEventListener('abort', cancelled, { once: true });
        void check();
      });
    } catch (error) {
      if (!(error instanceof Error && error.name === 'AbortError')) throw error;
    } finally {
      clearTimeout(timeout);
      closed.dispose();
    }
  } finally {
    if (directory) await fs.rm(directory, { recursive: true, force: true });
    pending.delete(key);
  }
}

export function signInClaude(home: string, refreshed: () => Promise<void>): void {
  const terminal = vscode.window.createTerminal({ name: 'Sign in: Claude', shellPath: 'claude', shellArgs: ['auth', 'login'], env: { CLAUDE_CONFIG_DIR: home } });
  terminal.show();
  // Usage polling picks up the credential as soon as login writes it; closing also refreshes immediately.
  const closed = vscode.window.onDidCloseTerminal((t) => {
    if (t !== terminal) return;
    closed.dispose();
    void refreshed();
  });
}
