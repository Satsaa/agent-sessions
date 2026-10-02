import * as vscode from 'vscode';
import { toolLabel, type Session, type Tool } from './types.js';
import { titleMatchesLabel } from './util.js';
import { moveHereIfHeldElsewhere } from './session-host.js';
import { seedSessionMode } from './claude-modes.js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { ensureDaemon, startDaemonThread } from './host/codex-daemon.js';

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
async function openClaude(sessionId: string | undefined, initialPrompt?: string): Promise<void> {
  const column = vscode.window.tabGroups.activeTabGroup.viewColumn;
  await vscode.commands.executeCommand('claude-vscode.editor.open', sessionId, initialPrompt, column, undefined, true, {
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

function existingCodexTabEntry(threadId: string, title: string): { tab: vscode.Tab; uri: vscode.Uri; group: vscode.TabGroup } | undefined {
  let byTitle: { tab: vscode.Tab; uri: vscode.Uri; group: vscode.TabGroup } | undefined;
  for (const group of vscode.window.tabGroups.all) {
    for (const tab of group.tabs) {
      if (!(tab.input instanceof vscode.TabInputCustom) || tab.input.uri.scheme !== 'openai-codex') continue;
      const entry = { tab, uri: tab.input.uri, group };
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
 * Replace a Codex tab with `uri` in the same slot. VS Code has no per-webview reload and swapping the editor in place
 * keeps Codex's retained webview alive, so the tab is closed and the route opened in its group, then moved back to
 * the slot it had.
 */
async function replaceCodexTab(tab: vscode.Tab, group: vscode.TabGroup, uri: vscode.Uri): Promise<void> {
  const index = group.tabs.indexOf(tab);
  const wasActive = tab.isActive;
  await vscode.window.tabGroups.close(tab);
  await vscode.commands.executeCommand('vscode.openWith', uri, CODEX_EDITOR_VIEW_TYPE, {
    viewColumn: group.viewColumn,
    preserveFocus: !wasActive,
    preview: false,
  });
  // The reopened tab lands at the end of the group; `moveActiveEditor` positions are 1-based.
  if (index >= 0) await vscode.commands.executeCommand('moveActiveEditor', { to: 'position', by: 'tab', value: index + 1 });
}

/** Reload the open Codex tab showing this session. Returns false when no tab shows the session. */
export async function reloadCodexTab(session: Session): Promise<boolean> {
  const entry = existingCodexTabEntry(session.id, session.title);
  if (!entry) return false;
  await replaceCodexTab(entry.tab, entry.group, entry.uri);
  return true;
}

/**
 * A Codex tab started fresh ("New Codex Agent") keeps `/extension/panel/new` after its thread exists, and Codex
 * rebuilds a restored tab from its URI alone, so a reload brings it back as a blank new thread. Which thread each such
 * tab showed is remembered by its slot, and after a reload the tab in that slot is reopened on the thread.
 */
export interface FreshCodexTab {
  column: number;
  index: number;
  threadId: string;
}

function isFreshCodexTab(tab: vscode.Tab): boolean {
  return tab.input instanceof vscode.TabInputCustom && tab.input.uri.scheme === 'openai-codex' && !/^\/(local|remote)\//.test(tab.input.uri.path);
}

/** The fresh Codex tabs whose thread is known, by the title Codex gave the tab. */
export function freshCodexTabs(sessions: readonly Session[]): FreshCodexTab[] {
  const out: FreshCodexTab[] = [];
  for (const group of vscode.window.tabGroups.all) {
    group.tabs.forEach((tab, index) => {
      if (!isFreshCodexTab(tab)) return;
      const s = sessions.find((x) => x.tool === 'codex' && titleMatchesLabel(x.title, tab.label));
      if (s) out.push({ column: group.viewColumn, index, threadId: s.id });
    });
  }
  return out;
}

/** Reopens each remembered fresh tab that came back from a reload in its slot on its thread. */
export async function restoreFreshCodexTabs(saved: readonly FreshCodexTab[]): Promise<void> {
  for (const entry of saved) {
    const group = vscode.window.tabGroups.all.find((g) => g.viewColumn === entry.column);
    const tab = group?.tabs[entry.index];
    if (!group || !tab || !isFreshCodexTab(tab)) continue;
    await replaceCodexTab(tab, group, codexRouteUri(`/local/${entry.threadId}`));
  }
}

async function openCodex(uri: vscode.Uri): Promise<void> {
  await vscode.commands.executeCommand('vscode.openWith', uri, CODEX_EDITOR_VIEW_TYPE, {
    viewColumn: vscode.ViewColumn.Active,
    preserveFocus: false,
    preview: false,
  });
}

/** Close the tab showing this session, if one is open. Only the tab goes: the agent's process is left alone. */
export async function closeSessionTab(session: Session): Promise<boolean> {
  const tab = session.tool === 'claude' ? existingClaudeTab(session) : existingCodexTabEntry(session.id, session.title)?.tab;
  if (!tab) return false;
  await vscode.window.tabGroups.close(tab, true);
  return true;
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

/** `claudeModeStore` is this install's Claude Code session mode store (see claude-modes.ts). */
export async function openSession(session: Session, claudeModeStore: string): Promise<void> {
  if (session.tool === 'claude') {
    if (!extensionInstalled(CLAUDE_EXTENSION)) {
      openInTerminal(session);
      return;
    }
    if (!(await moveHereIfHeldElsewhere(session.id, session.title))) return;
    // Best effort: without it the panel opens the session in its own default mode, as it always did.
    if (session.permissionMode) await seedSessionMode(claudeModeStore, session.id, session.permissionMode).catch(() => false);
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
  const first = await askFirstCodexMessage();
  if (first === undefined) return;
  if (first && (await startCodexWith(first))) return;
  await openCodex(newCodexPanelUri());
}

/**
 * How a new Codex session starts: from a first message typed here, or empty. A panel opened empty shows Codex's
 * onboarding and stays untitled until its first turn; one opened on a thread already running its first turn has
 * neither. The message is one line (Enter sends); undefined when the picker is dismissed, '' for an empty session.
 */
async function askFirstCodexMessage(): Promise<string | undefined> {
  type Pick = vscode.QuickPickItem & { send: boolean };
  // Fixed items: rewriting them per keystroke to echo the text made the picker flicker.
  const send: Pick = { label: '$(send) Start with this message', alwaysShow: true, send: true };
  const empty: Pick = { label: '$(add) Empty session', description: 'Codex’s own new panel', alwaysShow: true, send: false };
  const picker = vscode.window.createQuickPick<Pick>();
  picker.title = 'New Codex session';
  picker.placeholder = 'Type the first message and press Enter, or pick Empty session';
  picker.items = [send, empty];
  return new Promise((resolve) => {
    let chosen: string | undefined;
    picker.onDidAccept(() => {
      const message = picker.value.trim();
      if (picker.selectedItems[0]?.send !== false && !message) return;
      chosen = picker.selectedItems[0]?.send === false ? '' : message;
      picker.hide();
    });
    picker.onDidHide(() => {
      picker.dispose();
      resolve(chosen);
    });
    picker.show();
  });
}

/**
 * Starts a thread on Codex's app-server daemon with `message` as its first turn and opens the panel on it. Only with
 * Keep Sessions Running: without it each panel runs a private app-server, which cannot join a thread the daemon
 * holds. False when the thread could not be started, after saying why; the caller then opens an empty panel.
 */
async function startCodexWith(message: string): Promise<boolean> {
  if (!vscode.workspace.getConfiguration('agentSessions').get<boolean>('keepSessionsRunning', false)) {
    void vscode.window.showWarningMessage('Starting Codex with a message needs Agent Sessions: Keep Sessions Running; opened an empty session instead.');
    return false;
  }
  const codex = bundledCodex();
  const id = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Starting Codex session…' }, async () =>
    codex && (await ensureDaemon(codex)) ? startDaemonThread(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath, message).catch(() => undefined) : undefined);
  if (!id) {
    void vscode.window.showWarningMessage('Codex’s app-server daemon did not start the thread; opened an empty session instead.');
    return false;
  }
  await openCodex(codexRouteUri(`/local/${id}`));
  return true;
}

/** The `codex` the Codex extension ships, the version its panel was built against. */
function bundledCodex(): string | undefined {
  const root = vscode.extensions.getExtension(CODEX_EXTENSION)?.extensionPath;
  if (!root) return undefined;
  try {
    for (const dir of fs.readdirSync(path.join(root, 'bin'))) {
      const file = path.join(root, 'bin', dir, 'codex');
      if (fs.existsSync(file)) return file;
    }
  } catch {
    // No bin folder: an install without a bundled CLI.
  }
  return undefined;
}

/**
 * A new session in `tool` that starts from `note`: Claude Code takes it as the first prompt, ready to send. Codex's
 * panel takes no text from outside, so a new one is opened and `noteFile` attached to it with Codex's own "Add File
 * to Codex Thread" command, which adds to the focused panel. Without either extension the CLI gets it as its prompt.
 */
export async function newSessionFrom(tool: Tool, note: string, noteFile: string): Promise<void> {
  const installed = extensionInstalled(tool === 'claude' ? CLAUDE_EXTENSION : CODEX_EXTENSION);
  if (!installed) {
    const t = vscode.window.createTerminal({ name: toolLabel(tool) });
    t.show();
    t.sendText(`${tool} '${note.replace(/'/g, `'\\''`)}'`, true);
    return;
  }
  if (tool === 'claude') {
    await openClaude(undefined, note);
    return;
  }
  await openCodex(newCodexPanelUri());
  // Codex learns which panel has focus from the panel's view-state event, which follows the tab opening.
  await new Promise((resolve) => setTimeout(resolve, 500));
  await vscode.commands.executeCommand('chatgpt.addFileToThread', vscode.Uri.file(noteFile));
}

let newPanels = 0;

/**
 * The route of Codex's "New Codex Agent" panel, made unique. Codex's own command opens `/extension/panel/new` itself,
 * and VS Code dedupes custom editors by URI, so it reveals a fresh tab already open instead of starting another. Codex
 * passes the query on to its router as part of the route, where it is ignored.
 */
export function newCodexPanelUri(): vscode.Uri {
  return codexRouteUri('/extension/panel/new').with({ query: `tab=${Date.now()}-${++newPanels}` });
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
  const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
  return !!tab && isAgentPanelTab(tab);
}

/** A Codex or Claude Code panel tab. */
export function isAgentPanelTab(tab: vscode.Tab): boolean {
  const input = tab.input;
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
