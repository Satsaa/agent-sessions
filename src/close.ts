import * as vscode from 'vscode';
import { codexOwner, stopCodexOwner } from './codex-close.js';
import { listCodexSessions } from './codex.js';
import { daemonPid, interruptDaemonThread } from './host/codex-daemon.js';
import type { Session } from './types.js';

export async function closeCodexSession(session: Session, home: string): Promise<void> {
  if (session.tool !== 'codex') return;
  const owner = await codexOwner(home, session.id);
  // Codex's daemon serves every window and the terminal; stopping it would end all of them. Its thread needs no
  // releasing, since another window rejoins it, and it unloads once no one is subscribed.
  if (owner && owner.pid === daemonPid(home)) {
    if (session.state === 'running' || session.state === 'waiting') {
      const choice = await vscode.window.showWarningMessage(
        `Close “${session.title}” and stop its current turn?`,
        { modal: true, detail: 'Codex’s app-server daemon runs this session. Closing interrupts the turn it is working on; the conversation stays available to reopen.' },
        'Stop Turn',
      );
      if (choice !== 'Stop Turn') return;
      if (!(await interruptDaemonThread(session.id, home))) throw new Error('Codex’s app-server daemon did not answer. Try again, or stop the turn from its panel.');
    }
    await closeCodexTabs(session.id);
    return;
  }
  if (owner) {
    const sessions = await listCodexSessions(home);
    const titles = new Map(sessions.map((s) => [s.id, s.title]));
    const affected = owner.threadIds.map((id) => `• ${titles.get(id) ?? id}`).join('\n');
    const choice = await vscode.window.showWarningMessage(
      `Close “${session.title}” and release its Codex session?`,
      {
        modal: true,
        detail: `This stops Codex process ${owner.pid} and interrupts any work in all ${owner.threadIds.length} session(s) it holds. Saved conversations remain available to reopen.\n\n${affected}`,
      },
      'Stop Codex Process',
    );
    if (choice !== 'Stop Codex Process') return;
    await stopCodexOwner(home, session.id, owner);
  }
  await closeCodexTabs(session.id);
  void vscode.window.showInformationMessage(owner
    ? 'Codex stopped. You can reopen the session now. If its original window reports a disconnected server, reload that window.'
    : 'No local Codex writer lock is held for this session. If another device holds it, close it there.');
}

/** Match only the thread URI: duplicate titles must not close a different conversation. */
async function closeCodexTabs(threadId: string): Promise<void> {
  const tabs = vscode.window.tabGroups.all.flatMap((g) => g.tabs).filter((tab) =>
    tab.input instanceof vscode.TabInputCustom
    && tab.input.uri.scheme === 'openai-codex'
    && tab.input.uri.path === `/local/${threadId}`,
  );
  if (tabs.length) await vscode.window.tabGroups.close(tabs, true);
}
