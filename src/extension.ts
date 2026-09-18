import * as fs from 'node:fs';
import * as vscode from 'vscode';
import { claudeHome, claudeWatchPaths, listClaudeSessions } from './claude.js';
import { codexHome, codexWatchPaths, listCodexSessions } from './codex.js';
import { existingClaudeTab, newSession, openInTerminal, openSession, openTabLabels, resumeCommand, sessionOfActiveTab, reloadCodexTab } from './open.js';
import { markThisWindow } from './window.js';
import { formatTranscript, readTranscript } from './transcript.js';
import { closeCodexSession } from './close.js';
import { renameSession } from './rename.js';
import { deleteWorktree } from './delete-worktree.js';
import { SessionItem, SessionsProvider, type GroupBy, type ViewOptions } from './tree.js';
import { isLive, toolLabel, type Session, type Tool } from './types.js';
import { switchCodexAccount } from './codex-accounts-ui.js';
import { fetchClaudeUsage, readCodexUsage, type ToolUsage } from './usage.js';
import { UsageProvider, usageStatusColor, usageStatusText, usageStatusTooltip } from './usage-view.js';
import { initIcons } from './icons.js';
import { listRepoWorktrees, loadWorktreeStats, sessionWorktrees, type RepoWorktree } from './worktree.js';
import { WorktreeItem, WorktreesProvider } from './worktrees-tree.js';
import { repoRootOf } from './util.js';
import * as path from 'node:path';

const ARCHIVED_KEY = 'agentSessions.archived';
const PINNED_KEY = 'agentSessions.pinned';

interface Config {
  tools: Tool[];
  claudeHome: string;
  codexHome: string;
  pollInterval: number;
  usage: { enabled: boolean; claudeNetwork: boolean; codexNetwork: boolean; refreshInterval: number };
  view: Omit<ViewOptions, 'locallyArchived' | 'pinned'>;
}

function readConfig(): Config {
  const c = vscode.workspace.getConfiguration('agentSessions');
  return {
    tools: c.get<Tool[]>('tools', ['claude', 'codex']),
    claudeHome: claudeHome(c.get<string>('claudeHome', '')),
    codexHome: codexHome(c.get<string>('codexHome', '')),
    pollInterval: Math.max(1, c.get<number>('pollInterval', 5)),
    usage: {
      enabled: c.get<boolean>('usage.enabled', true),
      claudeNetwork: c.get<boolean>('usage.claudeNetwork', true),
      codexNetwork: c.get<boolean>('usage.codexNetwork', true),
      refreshInterval: Math.max(30, c.get<number>('usage.refreshInterval', 120)),
    },
    view: {
      groupBy: c.get<GroupBy>('groupBy', 'activity'),
      scope: c.get<'all' | 'workspace'>('scope', 'all'),
      showArchived: c.get<boolean>('showArchived', false),
      showSubagents: c.get<boolean>('showSubagents', false),
      showEmpty: c.get<boolean>('showEmpty', false),
      historyLimit: c.get<number>('historyLimit', 200),
    },
  };
}

export function activate(context: vscode.ExtensionContext): void {
  initIcons(context);
  const output = vscode.window.createOutputChannel('Agent Sessions');
  let config = readConfig();
  const archived = new Set<string>(context.globalState.get<string[]>(ARCHIVED_KEY, []));
  const pinned = new Set<string>(context.globalState.get<string[]>(PINNED_KEY, []));
  const options = (): ViewOptions => ({ ...config.view, locallyArchived: archived, pinned });

  const provider = new SessionsProvider(options());
  const view = vscode.window.createTreeView('agentSessions.list', { treeDataProvider: provider, showCollapseAll: true });
  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  statusBar.command = 'agentSessions.list.focus';
  const usageProvider = new UsageProvider(context.extensionUri);
  const usageView = vscode.window.registerWebviewViewProvider('agentSessions.usage', usageProvider);
  const usageBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  usageBar.command = 'agentSessions.usage.focus';
  const worktreesProvider = new WorktreesProvider();
  const worktreesView = vscode.window.createTreeView('agentSessions.worktrees', { treeDataProvider: worktreesProvider, showCollapseAll: true });
  context.subscriptions.push(output, view, statusBar, usageView, usageBar, worktreesView);

  // The row of the chat in the active editor tab is kept selected, the way the Explorer follows the active file.
  let latestSessions: Session[] = [];
  const selectActiveTabSession = (): void => {
    if (!view.visible) return;
    const s = sessionOfActiveTab(latestSessions);
    const item = s && provider.itemFor(s.tool, s.id);
    if (!item) return;
    if (view.selection.some((sel) => sel === item)) return;
    void view.reveal(item, { select: true, focus: false, expand: false }).then(undefined, () => undefined);
  };
  context.subscriptions.push(
    vscode.window.tabGroups.onDidChangeTabs(() => selectActiveTabSession()),
    vscode.window.tabGroups.onDidChangeTabGroups(() => selectActiveTabSession()),
    view.onDidChangeVisibility((e) => e.visible && selectActiveTabSession()),
  );

  // ---- Usage ----

  let usageTimer: NodeJS.Timeout | undefined;
  let usageRunning = false;
  const refreshUsage = async (): Promise<void> => {
    if (usageTimer) clearTimeout(usageTimer);
    if (!config.usage.enabled) {
      usageProvider.set([], 'disabled in settings');
      usageBar.hide();
      return;
    }
    if (usageRunning) return;
    usageRunning = true;
    try {
      const results = await Promise.all<ToolUsage | undefined>([
        config.tools.includes('claude') ? fetchClaudeUsage(config.claudeHome, config.usage.claudeNetwork, path.join(context.globalStorageUri.fsPath, 'claude-usage'), config.usage.refreshInterval * 1000) : undefined,
        config.tools.includes('codex') ? readCodexUsage(config.codexHome, config.usage.codexNetwork) : undefined,
      ]);
      const usages = results.filter((u): u is ToolUsage => u !== undefined);
      for (const u of usages) if (u.error) output.appendLine(`[${new Date().toISOString()}] usage ${u.tool}: ${u.error}`);
      usageProvider.set(usages);
      const text = usageStatusText(usages);
      if (text) {
        usageBar.text = `$(pie-chart) ${text}`;
        usageBar.tooltip = usageStatusTooltip(usages);
        usageBar.color = usageStatusColor(usages);
        usageBar.show();
      } else {
        usageBar.hide();
      }
    } finally {
      usageRunning = false;
      usageTimer = setTimeout(() => void refreshUsage(), config.usage.refreshInterval * 1000);
    }
  };
  context.subscriptions.push({ dispose: () => usageTimer && clearTimeout(usageTimer) });

  const syncContexts = () => {
    void vscode.commands.executeCommand('setContext', 'agentSessions.showArchived', config.view.showArchived);
    void vscode.commands.executeCommand('setContext', 'agentSessions.showSubagents', config.view.showSubagents);
    void vscode.commands.executeCommand('setContext', 'agentSessions.scope', config.view.scope);
  };
  syncContexts();

  // ---- Refresh ----

  let refreshing: Promise<void> | undefined;
  let pending = false;
  const refresh = (): Promise<void> => {
    if (refreshing) {
      pending = true;
      return refreshing;
    }
    refreshing = (async () => {
      try {
        const lists = await Promise.all([
          config.tools.includes('claude') ? listClaudeSessions(config.claudeHome).catch((e) => fail('claude', e)) : [],
          config.tools.includes('codex') ? listCodexSessions(config.codexHome).catch((e) => fail('codex', e)) : [],
        ]);
        const sessions: Session[] = lists.flat();
        latestSessions = sessions;
        await markThisWindow(sessions, openTabLabels());
        provider.setSessions(sessions);
        updateIndicators(provider.visible());
        selectActiveTabSession();
        // Git is a second pass so the list itself never waits on it.
        const worktrees = await collectWorktrees(sessions);
        const mains = new Set(worktrees.filter((w) => w.isMain).map((w) => w.path));
        const stats = await loadWorktreeStats([...sessionWorktrees(provider.visible()), ...worktrees], mains);
        provider.setWorktreeStats(stats);
        worktreesProvider.set(worktrees, stats, sessions, archived, pinned);
        const linked = worktrees.filter((w) => !w.isMain).length;
        worktreesView.description = linked ? `${linked}` : '';
      } finally {
        refreshing = undefined;
        if (pending) {
          pending = false;
          void refresh();
        }
      }
    })();
    return refreshing;
  };
  /** Every worktree of every repository in play: the workspace's repos plus any repo a recent or live session ran in. */
  const collectWorktrees = async (sessions: Session[]): Promise<RepoWorktree[]> => {
    const roots = new Set<string>();
    for (const f of vscode.workspace.workspaceFolders ?? []) {
      const r = repoRootOf(f.uri.fsPath);
      if (r) roots.add(path.resolve(r));
    }
    const recent = Date.now() - 30 * 24 * 3600 * 1000;
    for (const s of sessions) {
      if (!isLive(s.state) && s.updatedAt < recent) continue;
      const r = s.worktree?.repoRoot ?? repoRootOf(s.cwd);
      if (r) roots.add(path.resolve(r));
    }
    const lists = await Promise.all([...roots].sort().map((r) => listRepoWorktrees(r)));
    return lists.flat();
  };
  const fail = (tool: Tool, e: unknown): Session[] => {
    output.appendLine(`[${new Date().toISOString()}] ${tool}: ${e instanceof Error ? e.stack ?? e.message : String(e)}`);
    return [];
  };

  const updateIndicators = (visible: Session[]) => {
    const waiting = visible.filter((s) => s.state === 'waiting').length;
    const running = visible.filter((s) => s.state === 'running').length;
    const replied = visible.filter((s) => s.state === 'replied').length;
    view.badge = waiting ? { value: waiting, tooltip: `${waiting} session${waiting > 1 ? 's' : ''} need${waiting > 1 ? '' : 's'} your input` } : undefined;
    const parts: string[] = [];
    if (running) parts.push(`$(sync~spin) ${running}`);
    if (waiting) parts.push(`$(bell-dot) ${waiting}`);
    if (replied) parts.push(`$(comment-discussion) ${replied}`);
    if (parts.length) {
      statusBar.text = parts.join('  ');
      statusBar.tooltip = `Agent sessions — ${running} working, ${waiting} need input, ${replied} replied`;
      statusBar.show();
    } else {
      statusBar.hide();
    }
    schedulePoll(visible.some((s) => isLive(s.state)));
  };

  // A live session's process can die without touching any file, so poll while one exists.
  let pollTimer: NodeJS.Timeout | undefined;
  const schedulePoll = (anyLive: boolean) => {
    if (pollTimer) clearTimeout(pollTimer);
    pollTimer = setTimeout(() => void refresh(), (anyLive ? config.pollInterval : config.pollInterval * 12) * 1000);
  };
  context.subscriptions.push({ dispose: () => pollTimer && clearTimeout(pollTimer) });

  // File watchers, debounced: transcripts are appended constantly while an agent works.
  let debounce: NodeJS.Timeout | undefined;
  const kick = () => {
    if (debounce) clearTimeout(debounce);
    debounce = setTimeout(() => void refresh(), 400);
  };
  let watchers: fs.FSWatcher[] = [];
  const rewatch = () => {
    for (const w of watchers) w.close();
    watchers = [];
    const paths = [
      ...(config.tools.includes('claude') ? claudeWatchPaths(config.claudeHome) : []),
      ...(config.tools.includes('codex') ? codexWatchPaths(config.codexHome) : []),
    ];
    for (const p of paths) {
      try {
        if (!fs.existsSync(p)) continue;
        const w = fs.watch(p, { recursive: true, persistent: false }, kick);
        w.on('error', () => undefined);
        watchers.push(w);
      } catch (e) {
        output.appendLine(`watch ${p}: ${String(e)}`);
      }
    }
  };
  rewatch();
  context.subscriptions.push({ dispose: () => watchers.forEach((w) => w.close()) });

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (!e.affectsConfiguration('agentSessions')) return;
      config = readConfig();
      syncContexts();
      provider.setOptions(options());
      rewatch();
      void refresh();
      void refreshUsage();
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => provider.setOptions(options())),
  );

  // ---- Commands ----

  const sessionOf = (arg: unknown): Session | undefined => (arg instanceof SessionItem ? arg.session : undefined);
  const worktreePathOf = (arg: unknown): string | undefined => (typeof arg === 'string' ? arg : arg instanceof WorktreeItem ? arg.worktree.path : undefined);
  const setting = async (key: string, value: unknown) => {
    await vscode.workspace.getConfiguration('agentSessions').update(key, value, vscode.ConfigurationTarget.Global);
  };
  const persistArchived = () => context.globalState.update(ARCHIVED_KEY, [...archived]);

  context.subscriptions.push(
    vscode.commands.registerCommand('agentSessions.show', () => vscode.commands.executeCommand('agentSessions.list.focus')),
    vscode.commands.registerCommand('agentSessions.showWorktrees', () => vscode.commands.executeCommand('agentSessions.worktrees.focus')),
    vscode.commands.registerCommand('agentSessions.worktree.openFolder', async (arg: unknown) => {
      const p = worktreePathOf(arg);
      if (p) await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(p), { forceNewWindow: true });
    }),
    vscode.commands.registerCommand('agentSessions.worktree.openTerminal', (arg: unknown) => {
      const p = worktreePathOf(arg);
      if (!p) return;
      vscode.window.createTerminal({ name: path.basename(p), cwd: p }).show();
    }),
    vscode.commands.registerCommand('agentSessions.worktree.delete', async (arg: unknown) => {
      if (!(arg instanceof WorktreeItem) || arg.worktree.isMain) return;
      try {
        await deleteWorktree(arg.worktree);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        output.appendLine(`delete worktree ${arg.worktree.path} failed: ${message}`);
        void vscode.window.showErrorMessage(`Could not delete worktree: ${message}`);
      } finally {
        await refresh();
      }
    }),
    vscode.commands.registerCommand('agentSessions.worktree.copyPath', async (arg: unknown) => {
      const p = worktreePathOf(arg);
      if (!p) return;
      await vscode.env.clipboard.writeText(p);
      vscode.window.setStatusBarMessage(`Copied: ${p}`, 3000);
    }),
    vscode.commands.registerCommand('agentSessions.worktree.newClaude', (arg: unknown) => {
      const p = worktreePathOf(arg);
      if (!p) return;
      const t = vscode.window.createTerminal({ name: `Claude: ${path.basename(p)}`, cwd: p });
      t.show();
      t.sendText('claude', true);
    }),
    vscode.commands.registerCommand('agentSessions.worktree.newCodex', (arg: unknown) => {
      const p = worktreePathOf(arg);
      if (!p) return;
      const t = vscode.window.createTerminal({ name: `Codex: ${path.basename(p)}`, cwd: p });
      t.show();
      t.sendText('codex', true);
    }),
    vscode.commands.registerCommand('agentSessions.refresh', () => refresh()),
    vscode.commands.registerCommand('agentSessions.refreshUsage', () => refreshUsage()),
    vscode.commands.registerCommand('agentSessions.switchCodexAccount', async () => {
      try {
        if (await switchCodexAccount(config.codexHome)) {
          await refresh();
          await refreshUsage();
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        output.appendLine(`switch codex account failed: ${message}`);
        void vscode.window.showErrorMessage(`Could not switch Codex account: ${message}`);
      }
    }),
    vscode.commands.registerCommand('agentSessions.newClaude', () => newSession('claude')),
    vscode.commands.registerCommand('agentSessions.newCodex', () => newSession('codex')),
    vscode.commands.registerCommand('agentSessions.showArchived', () => setting('showArchived', true)),
    vscode.commands.registerCommand('agentSessions.hideArchived', () => setting('showArchived', false)),
    vscode.commands.registerCommand('agentSessions.showSubagents', () => setting('showSubagents', true)),
    vscode.commands.registerCommand('agentSessions.hideSubagents', () => setting('showSubagents', false)),
    vscode.commands.registerCommand('agentSessions.scopeWorkspace', () => setting('scope', 'workspace')),
    vscode.commands.registerCommand('agentSessions.scopeAll', () => setting('scope', 'all')),
    vscode.commands.registerCommand('agentSessions.groupBy', async () => {
      const picks: { label: string; description: string; value: GroupBy }[] = [
        { label: 'Activity', description: 'Active and pinned sessions first, then history', value: 'activity' },
        { label: 'Repository', description: 'One group per repository, worktrees inside', value: 'repository' },
        { label: 'Tool', description: 'Claude and Codex as separate groups', value: 'tool' },
        { label: 'None', description: 'One flat list', value: 'none' },
      ];
      const chosen = await vscode.window.showQuickPick(picks, { placeHolder: 'Group sessions by' });
      if (chosen) await setting('groupBy', chosen.value);
    }),
    vscode.commands.registerCommand('agentSessions.open', async (arg: unknown) => {
      const s = sessionOf(arg);
      if (!s) return;
      try {
        await openSession(s);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        output.appendLine(`open ${s.tool} ${s.id} failed: ${msg}`);
        void vscode.window.showErrorMessage(`Could not open ${toolLabel(s.tool)} session: ${msg}`);
      }
    }),
    vscode.commands.registerCommand('agentSessions.openInTerminal', (arg: unknown) => {
      const s = sessionOf(arg);
      if (s) openInTerminal(s);
    }),
    vscode.commands.registerCommand('agentSessions.closeCodex', async (arg: unknown) => {
      const s = sessionOf(arg);
      if (!s || s.tool !== 'codex') return;
      try {
        await closeCodexSession(s, config.codexHome);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        output.appendLine(`close codex ${s.id} failed: ${message}`);
        void vscode.window.showErrorMessage(`Could not close Codex session: ${message}`);
      } finally {
        await refresh();
      }
    }),
    vscode.commands.registerCommand('agentSessions.reloadCodexPanel', async (arg: unknown) => {
      const s = sessionOf(arg);
      if (!s || s.tool !== 'codex') return;
      try {
        if (!(await reloadCodexTab(s))) void vscode.window.showInformationMessage('This Codex session is not open in a tab.');
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        output.appendLine(`reload codex panel ${s.id} failed: ${message}`);
        void vscode.window.showErrorMessage(`Could not reload Codex panel: ${message}`);
      }
    }),
    vscode.commands.registerCommand('agentSessions.rename', async (arg: unknown) => {
      // From the keybinding there is no argument: take the selected row of whichever tree has one.
      const s = sessionOf(arg) ?? sessionOf(view.selection[0]) ?? sessionOf(worktreesView.selection[0]);
      if (!s) return;
      // A Claude session open in a tab is renamed by Claude Code itself: it prompts, writes the title and relabels the tab
      // (which nothing outside the extension can do). Codex's tab keeps its label until the thread is reopened.
      const claudeTab = s.tool === 'claude' ? existingClaudeTab(s) : undefined;
      if (claudeTab) {
        try {
          await openSession(s);
          await vscode.commands.executeCommand('claude-vscode.renameSessionTab');
        } catch (err) {
          output.appendLine(`rename via Claude Code failed: ${err instanceof Error ? err.message : String(err)}`);
        }
        await refresh();
        return;
      }
      const title = await vscode.window.showInputBox({ prompt: `Rename ${toolLabel(s.tool)} session`, value: s.title, valueSelection: [0, s.title.length], validateInput: (v) => (v.trim() ? undefined : 'A title cannot be empty') });
      if (title === undefined || title.trim() === s.title) return;
      try {
        await renameSession(s, config.codexHome, title);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        output.appendLine(`rename ${s.tool} ${s.id} failed: ${message}`);
        void vscode.window.showErrorMessage(`Could not rename session: ${message}`);
      }
      await refresh();
    }),
    vscode.commands.registerCommand('agentSessions.copyTranscript', async (arg: unknown) => {
      const s = sessionOf(arg);
      if (!s) return;
      const messages = await readTranscript(s);
      if (!messages.length) {
        void vscode.window.showInformationMessage('This session has no messages to copy.');
        return;
      }
      await vscode.env.clipboard.writeText(formatTranscript(s, messages));
      vscode.window.setStatusBarMessage(`$(copy) Copied ${messages.length} message${messages.length === 1 ? '' : 's'} from "${s.title}"`, 3000);
    }),
    vscode.commands.registerCommand('agentSessions.copyResumeCommand', async (arg: unknown) => {
      const s = sessionOf(arg);
      if (!s) return;
      await vscode.env.clipboard.writeText(resumeCommand(s));
      vscode.window.setStatusBarMessage(`Copied: ${resumeCommand(s)}`, 3000);
    }),
    vscode.commands.registerCommand('agentSessions.revealTranscript', async (arg: unknown) => {
      const s = sessionOf(arg);
      if (!s?.transcriptPath) return;
      await vscode.window.showTextDocument(vscode.Uri.file(s.transcriptPath), { preview: true });
    }),
    vscode.commands.registerCommand('agentSessions.openFolder', async (arg: unknown) => {
      const s = sessionOf(arg);
      if (!s?.cwd) return;
      await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(s.cwd), { forceNewWindow: true });
    }),
    vscode.commands.registerCommand('agentSessions.archive', async (arg: unknown) => {
      const s = sessionOf(arg);
      if (!s) return;
      archived.add(`${s.tool}:${s.id}`);
      await persistArchived();
      provider.setOptions(options());
      updateIndicators(provider.visible());
    }),
    ...(['pin', 'unpin'] as const).map((action) => vscode.commands.registerCommand(`agentSessions.${action}`, async (arg: unknown) => {
      const s = sessionOf(arg);
      if (!s) return;
      const key = `${s.tool}:${s.id}`;
      if (action === 'pin') pinned.add(key);
      else pinned.delete(key);
      await context.globalState.update(PINNED_KEY, [...pinned]);
      provider.setOptions(options());
      await refresh();
    })),
    vscode.commands.registerCommand('agentSessions.unarchive', async (arg: unknown) => {
      const s = sessionOf(arg);
      if (!s) return;
      archived.delete(`${s.tool}:${s.id}`);
      await persistArchived();
      if (s.archived) {
        vscode.window.showInformationMessage(`This session is archived in ${s.tool === 'codex' ? 'Codex' : 'Claude Code'} itself; unarchive it there to hide the badge.`);
      }
      provider.setOptions(options());
      updateIndicators(provider.visible());
    }),
  );

  void refresh();
  void refreshUsage();
}

export function deactivate(): void {
  // Everything is disposed through context.subscriptions.
}
