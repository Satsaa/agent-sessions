import * as vscode from 'vscode';
import { isAgentPanelTab } from './open.js';

/** A blank read-only document, opened only to force the editor area visible before it is hidden deterministically. */
export const BLANK_DOC_PATH = '/blank';

/** The views of the Sessions container, moved into the phone container for the maximized secondary side bar. */
const VIEW_IDS = ['agentSessions.list', 'agentSessions.usage', 'agentSessions.worktrees'];
const PHONE_CONTAINER = 'workbench.view.extension.agentSessionsPhone';
const PENDING_KEY = 'agentSessions.phone.pendingOpen';

/** A session to open right after the window has reopened on its folder. */
export interface PendingOpen {
  tool: string;
  id: string;
}

/**
 * Claude Code runs `claude` in the window's first folder and lists only that folder's sessions, so a Claude session
 * from elsewhere would start a new chat. In phone mode the window follows the session: the id is remembered, the
 * window reopens on the session's folder, and activation finishes the open. Codex resumes by thread id anywhere.
 */
export async function reopenOnFolder(context: vscode.ExtensionContext, pending: PendingOpen, folder: string): Promise<void> {
  await context.globalState.update(PENDING_KEY, pending);
  await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(folder), { forceReuseWindow: true });
}

export function windowFolder(): string | undefined {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

export async function takePendingOpen(context: vscode.ExtensionContext): Promise<PendingOpen | undefined> {
  const pending = context.globalState.get<PendingOpen>(PENDING_KEY);
  if (pending) await context.globalState.update(PENDING_KEY, undefined);
  return pending;
}

/**
 * Phone mode: one part of the workbench on screen at a time, for `code serve-web` viewed on a phone.
 *
 * - List mode: no editor tabs; our views live in the secondary side bar, which is maximized (the workbench's own
 *   full-window layout for chat sessions), so the Sessions view is the whole window.
 * - Session mode: at least one tab; the side bars are closed, the editor area (a Codex or Claude panel) is the window.
 *
 * The mode follows the tab count: opening a tab leaves the list, closing the last one (or the Back action) returns.
 * The editor area cannot be hidden alone (the workbench shows the bottom panel instead), hence the maximized side bar.
 */
export class PhoneLayout implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];
  private busy = false;
  private enabled = false;
  private hadTabs: boolean | undefined;

  constructor() {
    this.disposables.push(vscode.window.tabGroups.onDidChangeTabs(() => void this.follow()));
  }

  setEnabled(enabled: boolean): void {
    if (enabled === this.enabled) return;
    this.enabled = enabled;
    this.hadTabs = undefined;
    if (enabled) void this.start();
  }

  /** The Back action: leave the session, return to the full-window list. */
  async back(): Promise<void> {
    await this.run(async () => {
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
      await this.enterListMode();
    });
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
  }

  private tabCount(): number {
    return vscode.window.tabGroups.all.reduce((n, g) => n + g.tabs.length, 0);
  }

  /** Startup: whatever the workbench restored besides agent panels (a Welcome page, an editor) goes; then the tabs decide. */
  private async start(): Promise<void> {
    await this.run(async () => {
      const stray = vscode.window.tabGroups.all.flatMap((g) => g.tabs).filter((t) => !isAgentPanelTab(t));
      if (stray.length) await vscode.window.tabGroups.close(stray, true);
      await vscode.commands.executeCommand('vscode.moveViews', { viewIds: VIEW_IDS, destinationId: PHONE_CONTAINER });
    });
    await this.follow();
    // The workbench restores its parts on its own schedule around activation, so a second pass settles the layout.
    setTimeout(() => void this.run(() => (this.tabCount() > 0 ? this.enterSessionMode() : this.enterListMode())), 3000);
  }

  private async follow(): Promise<void> {
    if (!this.enabled || this.busy) return;
    const hasTabs = this.tabCount() > 0;
    if (hasTabs === this.hadTabs) return;
    this.hadTabs = hasTabs;
    await this.run(() => (hasTabs ? this.enterSessionMode() : this.enterListMode()));
  }

  private async enterSessionMode(): Promise<void> {
    await vscode.commands.executeCommand('workbench.action.restoreAuxiliaryBar');
    await vscode.commands.executeCommand('workbench.action.closeAuxiliaryBar');
    await vscode.commands.executeCommand('workbench.action.closeSidebar');
    await vscode.commands.executeCommand('workbench.action.closePanel');
  }

  private async enterListMode(): Promise<void> {
    await vscode.commands.executeCommand('workbench.action.closeSidebar');
    await vscode.commands.executeCommand('workbench.action.closePanel');
    await vscode.commands.executeCommand('agentSessions.list.focus');
    await vscode.commands.executeCommand('workbench.action.maximizeAuxiliaryBar');
    this.hadTabs = false;
  }

  private async run(fn: () => Promise<void>): Promise<void> {
    this.busy = true;
    try {
      await fn();
    } catch {
      // Layout commands are best effort: a missing command in some client leaves the layout as it is.
    } finally {
      this.busy = false;
    }
  }
}
