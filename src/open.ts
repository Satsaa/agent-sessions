import * as vscode from 'vscode';
import type { Session, Tool } from './types.js';

const CLAUDE_EXTENSION = 'anthropic.claude-code';
const CODEX_EXTENSION = 'openai.chatgpt';
const CODEX_EDITOR_VIEW_TYPE = 'chatgpt.conversationEditor';

function extensionInstalled(id: string): boolean {
  return vscode.extensions.getExtension(id) !== undefined;
}

/** The URI the Codex extension's custom editor resolves to a thread route. */
function codexRouteUri(routePath: string): vscode.Uri {
  return vscode.Uri.file(routePath).with({ scheme: 'openai-codex', authority: 'route', query: '' });
}

/**
 * Claude Code's `editor.open` signature (session id, initial prompt, view column, group, full editor, options).
 * `programmatic: true` makes it honour the given column as a tab instead of the user's sidebar preference,
 * and an explicit column keeps it from opening a new locked editor group.
 */
/**
 * Claude Code's `editor.open` signature (session id, initial prompt, view column, group, full editor, options).
 * The extension reveals the existing panel when the session already has one in this window. Otherwise it creates
 * a panel — and without an explicit column it picks a Claude-only column and locks that group, so the active
 * group's concrete column is passed to land the tab beside the ordinary editors.
 */
async function openClaude(sessionId: string | undefined): Promise<void> {
  const column = vscode.window.tabGroups.activeTabGroup.viewColumn;
  await vscode.commands.executeCommand('claude-vscode.editor.open', sessionId, undefined, column, undefined, true, {
    programmatic: 'honor-preferred-location',
  });
}

/**
 * The Codex tab for a thread: VS Code dedupes custom editors by URI, so opening the tab's own URI reveals it.
 * A thread opened by id sits at `/local/<id>`; one started fresh in a panel keeps `/extension/panel/new` and is
 * only recognisable by its title, which the extension sets to the thread's preview.
 */
function existingCodexTab(threadId: string, title: string): vscode.Uri | undefined {
  let byTitle: vscode.Uri | undefined;
  for (const group of vscode.window.tabGroups.all) {
    for (const tab of group.tabs) {
      if (!(tab.input instanceof vscode.TabInputCustom) || tab.input.uri.scheme !== 'openai-codex') continue;
      if (tab.input.uri.path.includes(threadId)) return tab.input.uri;
      if (tab.label === title) byTitle ??= tab.input.uri;
    }
  }
  return byTitle;
}

async function openCodex(uri: vscode.Uri): Promise<void> {
  await vscode.commands.executeCommand('vscode.openWith', uri, CODEX_EDITOR_VIEW_TYPE, {
    viewColumn: vscode.ViewColumn.Active,
    preserveFocus: false,
    preview: false,
  });
}

export function resumeCommand(session: Session): string {
  return session.tool === 'claude' ? `claude --resume ${session.id}` : `codex resume ${session.id}`;
}

export function openInTerminal(session: Session): void {
  const options: vscode.TerminalOptions = { name: `${session.tool === 'claude' ? 'Claude' : 'Codex'}: ${session.title}` };
  if (session.cwd) options.cwd = session.cwd;
  const terminal = vscode.window.createTerminal(options);
  terminal.show();
  terminal.sendText(resumeCommand(session), true);
}

export async function openSession(session: Session): Promise<void> {
  if (session.tool === 'claude') {
    if (!extensionInstalled(CLAUDE_EXTENSION)) {
      openInTerminal(session);
      return;
    }
    await openClaude(session.id);
    return;
  }
  if (!extensionInstalled(CODEX_EXTENSION)) {
    openInTerminal(session);
    return;
  }
  await openCodex(existingCodexTab(session.id, session.title) ?? codexRouteUri(`/local/${session.id}`));
}

export async function newSession(tool: Tool): Promise<void> {
  if (tool === 'claude') {
    if (!extensionInstalled(CLAUDE_EXTENSION)) {
      const t = vscode.window.createTerminal({ name: 'Claude' });
      t.show();
      t.sendText('claude', true);
      return;
    }
    await openClaude(undefined);
    return;
  }
  if (!extensionInstalled(CODEX_EXTENSION)) {
    const t = vscode.window.createTerminal({ name: 'Codex' });
    t.show();
    t.sendText('codex', true);
    return;
  }
  await openCodex(codexRouteUri('/extension/panel/new'));
}

/** Labels of every open tab, for matching sessions to the panels that show them (the vendor extensions title panels with the session title). */
export function openTabLabels(): Set<string> {
  const out = new Set<string>();
  for (const group of vscode.window.tabGroups.all) for (const tab of group.tabs) out.add(tab.label);
  return out;
}
