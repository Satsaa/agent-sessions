import * as vscode from 'vscode';
import { codexOwner, stopCodexOwner } from './codex-close.js';
import { listCodexSessions } from './codex.js';
import type { Session } from './types.js';

export async function closeCodexSession(session: Session, home: string): Promise<void> {
  if (session.tool !== 'codex') return;
  const owner = await codexOwner(home, session.id);
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
  // Match only the thread URI: duplicate titles must not close a different conversation.
  const tabs = vscode.window.tabGroups.all.flatMap((g) => g.tabs).filter((tab) =>
    tab.input instanceof vscode.TabInputCustom
    && tab.input.uri.scheme === 'openai-codex'
    && tab.input.uri.path === `/local/${session.id}`,
  );
  if (tabs.length) await vscode.window.tabGroups.close(tabs, true);
  void vscode.window.showInformationMessage(owner
    ? 'Codex stopped. You can reopen the session now. If its original window reports a disconnected server, reload that window.'
    : 'No local Codex writer lock is held for this session. If another device holds it, close it there.');
}
