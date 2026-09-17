import * as vscode from 'vscode';
import { activateCodexAccount, listCodexAccounts, runningCodexProcesses, saveCurrentCodexAccount, stopCodexProcesses, type CodexAccount } from './codex-accounts.js';
import { relativeTime } from './util.js';

const ADD = Symbol('add');

interface AccountPick extends vscode.QuickPickItem {
  account: CodexAccount | typeof ADD;
}

function planText(a: CodexAccount): string {
  const name = a.plan ? a.plan.charAt(0).toUpperCase() + a.plan.slice(1) : 'unknown plan';
  const t = a.until ? Date.parse(a.until) : NaN;
  return Number.isFinite(t) ? `${name} · renews ${new Date(t).toLocaleDateString()}` : name;
}

/**
 * Pick a saved ChatGPT login and make it Codex's active one. Returns true when the login changed.
 * Codex reads `auth.json` once per process, so running Codex processes are stopped first (with consent — they hold
 * their threads locked until they exit) and the window is offered a reload for the extension's own app server.
 */
export async function switchCodexAccount(home: string): Promise<boolean> {
  const accounts = await listCodexAccounts(home);
  const picks: AccountPick[] = accounts.map((a) => ({
    label: a.email ?? a.accountId ?? a.file,
    description: planText(a),
    detail: a.current ? 'Signed in now' : `Saved login · tokens refreshed ${a.refreshedAt ? relativeTime(a.refreshedAt) : 'at an unknown time'}`,
    picked: a.current,
    account: a,
  }));
  picks.push({ label: '$(add) Add another account…', detail: 'Keeps the current login as a saved profile, then runs `codex login` in a terminal', account: ADD });
  const chosen = await vscode.window.showQuickPick(picks, { placeHolder: 'Switch the ChatGPT account Codex uses', matchOnDescription: true });
  if (!chosen) return false;

  if (chosen.account === ADD) {
    const saved = await saveCurrentCodexAccount(home);
    const terminal = vscode.window.createTerminal({ name: 'codex login' });
    terminal.show();
    terminal.sendText('codex logout; codex login', true);
    void vscode.window.showInformationMessage(
      `${saved?.email ? `Saved ${saved.email} as a profile. ` : ''}Sign in to the other account in the terminal, then use Switch Codex Account to move between them.`,
    );
    return false;
  }
  if (chosen.account.current) return false;

  const running = await runningCodexProcesses(home);
  if (running.length) {
    const threads = running.reduce((n, p) => n + p.threadIds.length, 0);
    const answer = await vscode.window.showWarningMessage(
      `${running.length} Codex process${running.length === 1 ? ' is' : 'es are'} running with the current login, holding ${threads} session${threads === 1 ? '' : 's'}. They keep the old account until they stop, and their sessions stay locked. Stop them and switch?`,
      { modal: true },
      'Stop and switch',
    );
    if (answer !== 'Stop and switch') return false;
    await stopCodexProcesses(home, running);
  }
  await activateCodexAccount(home, chosen.account);

  const label = chosen.account.email ?? chosen.account.accountId ?? 'the selected account';
  const reload = await vscode.window.showInformationMessage(`Codex now uses ${label}. The Codex extension reads the login when the window starts, so reload to apply it there.`, 'Reload Window', 'Later');
  if (reload === 'Reload Window') await vscode.commands.executeCommand('workbench.action.reloadWindow');
  return true;
}
