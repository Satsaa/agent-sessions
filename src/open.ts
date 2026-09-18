import * as vscode from 'vscode';
import type { Session, Tool } from './types.js';
import { titleMatchesLabel } from './util.js';

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
/** The open Claude Code tab showing this session, if any: the panel's label is the session title. */
export function existingClaudeTab(session: Session): vscode.Tab | undefined {
  for (const group of vscode.window.tabGroups.all) {
    for (const tab of group.tabs) {
      if (tab.input instanceof vscode.TabInputWebview && /claude/i.test(tab.input.viewType) && titleMatchesLabel(session.title, tab.label)) return tab;
    }
  }
  return undefined;
}

function existingCodexTabEntry(threadId: string, title: string): { uri: vscode.Uri; viewColumn: vscode.ViewColumn } | undefined {
  let byTitle: { uri: vscode.Uri; viewColumn: vscode.ViewColumn } | undefined;
  for (const group of vscode.window.tabGroups.all) {
    for (const tab of group.tabs) {
      if (!(tab.input instanceof vscode.TabInputCustom) || tab.input.uri.scheme !== 'openai-codex') continue;
      const entry = { uri: tab.input.uri, viewColumn: group.viewColumn };
      if (tab.input.uri.path.includes(threadId)) return entry;
      if (titleMatchesLabel(title, tab.label)) byTitle ??= entry;
    }
  }
  return byTitle;
}

function existingCodexTab(threadId: string, title: string): vscode.Uri | undefined {
  return existingCodexTabEntry(threadId, title)?.uri;
}

/**
 * Reload the open Codex tab showing this session, in place. VS Code has no per-webview reload, so the tab's editor is
 * swapped to the default editor and straight back: `openWith` on an open resource replaces the editor in the same
 * tab, and Codex's custom editor is recreated with a fresh webview at that route. Returns false when no tab shows it.
 */
export async function reloadCodexTab(session: Session): Promise<boolean> {
  const entry = existingCodexTabEntry(session.id, session.title);
  if (!entry) return false;
  const options: vscode.TextDocumentShowOptions = { viewColumn: entry.viewColumn, preserveFocus: false, preview: false };
  await vscode.commands.executeCommand('vscode.openWith', entry.uri, 'default', options);
  await vscode.commands.executeCommand('vscode.openWith', entry.uri, CODEX_EDITOR_VIEW_TYPE, options);
  return true;
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
  // The Codex extension's own "New Codex Agent" command: it owns the panel route and whatever its landing state is,
  // so our button cannot drift from the + button in its sidebar.
  await vscode.commands.executeCommand('chatgpt.newCodexPanel');
}

/** Labels of every open tab, for matching sessions to the panels that show them (the vendor extensions title panels with the session title). */
export function openTabLabels(): Set<string> {
  const out = new Set<string>();
  for (const group of vscode.window.tabGroups.all) for (const tab of group.tabs) out.add(tab.label);
  return out;
}

/**
 * The session shown by the active editor tab, if it is a Claude or Codex panel. A Codex tab opened by id carries
 * the id in its URI; a Claude panel (a webview) and a Codex panel started fresh are known only by their title.
 */
/** Whether the active editor tab is a Claude or Codex panel at all, matched session or not. */
export function activeTabIsAgentPanel(): boolean {
  const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
  if (input instanceof vscode.TabInputCustom) return input.uri.scheme === 'openai-codex';
  return input instanceof vscode.TabInputWebview && /claude/i.test(input.viewType);
}

export function sessionOfActiveTab(sessions: readonly Session[]): Session | undefined {
  const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
  if (!tab) return undefined;
  const input = tab.input;
  if (input instanceof vscode.TabInputCustom && input.uri.scheme === 'openai-codex') {
    return sessions.find((s) => s.tool === 'codex' && input.uri.path.includes(s.id)) ?? sessions.find((s) => s.tool === 'codex' && titleMatchesLabel(s.title, tab.label));
  }
  if (input instanceof vscode.TabInputWebview && /claude/i.test(input.viewType)) {
    return sessions.find((s) => s.tool === 'claude' && titleMatchesLabel(s.title, tab.label));
  }
  return undefined;
}
