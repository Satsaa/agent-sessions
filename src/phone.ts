import * as vscode from 'vscode';
import { isAgentPanelTab } from './open.js';

/** A blank read-only document, opened only to force the editor area visible before it is hidden deterministically. */
export const BLANK_DOC_PATH = '/blank';

/** The views of the Sessions container, moved into the phone container for the maximized secondary side bar. */
const VIEW_IDS = ['agentSessions.list', 'agentSessions.usage', 'agentSessions.worktrees'];
const PHONE_CONTAINER = 'workbench.view.extension.agentSessionsPhone';

export function windowFolder(): string | undefined {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

/**
 * Phone mode: one part of the workbench on screen at a time, for `code serve-web` viewed on a phone.
 *
 * - List mode: our views live in the secondary side bar, which is maximized (the workbench's own full-window layout
 *   for chat sessions), so the Sessions view is the whole window. Open tabs stay open behind it: closing a Claude Code
 *   or Codex panel ends that session's process, so leaving a session must not close it.
 * - Session mode: the side bars are closed, the editor area (a Codex or Claude panel) is the window.
 *
 * Opening or switching to a tab enters session mode; Back, or closing the last tab, returns to the list. The editor
 * area cannot be hidden alone (the workbench shows the bottom panel instead), hence the maximized side bar.
 */
export class PhoneLayout implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];
  private busy = false;
  private enabled = false;
  private mode: 'list' | 'session' = 'list';

  constructor() {
    this.disposables.push(vscode.window.tabGroups.onDidChangeTabs((e) => void this.follow(e)));
  }

  setEnabled(enabled: boolean): void {
    if (enabled === this.enabled) return;
    this.enabled = enabled;
    if (enabled) void this.start();
  }

  /** The Back action: leave the session for the full-window list, its tab (and so its process) left running. */
  async back(): Promise<void> {
    await this.run(() => this.enterListMode());
  }

  /** A session was opened from the list: show it even when its tab was already the active one (no tab event then). */
  async showSession(): Promise<void> {
    if (this.enabled && this.tabCount() > 0) await this.run(() => this.enterSessionMode());
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
  }

  private tabCount(): number {
    return vscode.window.tabGroups.all.reduce((n, g) => n + g.tabs.length, 0);
  }

  /** Startup: whatever the workbench restored besides agent panels (a Welcome page, an editor) goes; the list shows. */
  private async start(): Promise<void> {
    await this.run(async () => {
      const stray = vscode.window.tabGroups.all.flatMap((g) => g.tabs).filter((t) => !isAgentPanelTab(t));
      if (stray.length) await vscode.window.tabGroups.close(stray, true);
      await vscode.commands.executeCommand('vscode.moveViews', { viewIds: VIEW_IDS, destinationId: PHONE_CONTAINER });
      await this.enterListMode();
    });
    // The workbench restores its parts on its own schedule around activation, so a second pass settles the layout.
    setTimeout(() => void this.run(() => (this.mode === 'session' ? this.enterSessionMode() : this.enterListMode())), 3000);
  }

  private async follow(e: vscode.TabChangeEvent): Promise<void> {
    if (!this.enabled || this.busy) return;
    if (this.tabCount() === 0) {
      if (this.mode === 'session') await this.run(() => this.enterListMode());
      return;
    }
    // A session was opened, or an open one brought forward (opening a session whose tab exists reveals that tab).
    const shown = e.opened.length > 0 || e.changed.some((t) => t.isActive);
    if (shown && this.mode === 'list') await this.run(() => this.enterSessionMode());
  }

  private async enterSessionMode(): Promise<void> {
    await vscode.commands.executeCommand('workbench.action.restoreAuxiliaryBar');
    await vscode.commands.executeCommand('workbench.action.closeAuxiliaryBar');
    await vscode.commands.executeCommand('workbench.action.closeSidebar');
    await vscode.commands.executeCommand('workbench.action.closePanel');
    this.mode = 'session';
  }

  private async enterListMode(): Promise<void> {
    await vscode.commands.executeCommand('workbench.action.closeSidebar');
    await vscode.commands.executeCommand('workbench.action.closePanel');
    await vscode.commands.executeCommand('agentSessions.list.focus');
    await vscode.commands.executeCommand('workbench.action.maximizeAuxiliaryBar');
    this.mode = 'list';
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
