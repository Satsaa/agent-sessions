import * as vscode from 'vscode';
import { toolLabel } from './types.js';
import { relativeTime } from './util.js';
import type { ToolUsage, UsageWindow } from './usage.js';

class ToolUsageItem extends vscode.TreeItem {
  constructor(public readonly usage: ToolUsage) {
    super(toolLabel(usage.tool), vscode.TreeItemCollapsibleState.Expanded);
    this.id = `usage:${usage.tool}`;
    this.description = usage.error ? 'unavailable' : usage.plan ?? '';
    this.iconPath = usage.error
      ? new vscode.ThemeIcon('warning', new vscode.ThemeColor('charts.orange'))
      : new vscode.ThemeIcon(usage.tool === 'claude' ? 'sparkle' : 'hubot');
    const md = new vscode.MarkdownString(undefined, true);
    md.appendMarkdown(`**${toolLabel(usage.tool)}**${usage.plan ? ` · ${usage.plan}` : ''}\n\n`);
    if (usage.error) md.appendMarkdown(`$(warning) ${usage.error}\n\n`);
    else md.appendMarkdown(`As of ${relativeTime(usage.asOf)} (${new Date(usage.asOf).toLocaleString()})\n\n`);
    md.appendMarkdown(`Source: ${usage.source}`);
    this.tooltip = md;
    this.contextValue = 'usage-tool';
  }
}

class WindowItem extends vscode.TreeItem {
  constructor(tool: string, w: UsageWindow) {
    super(w.label, vscode.TreeItemCollapsibleState.None);
    this.id = `usage:${tool}:${w.label}`;
    const bar = progressBar(w.percent);
    const reset = w.resetsAt ? `resets ${resetText(w.resetsAt)}` : '';
    this.description = [w.detail ? `${w.detail}` : `${bar} ${w.percent}%`, reset].filter(Boolean).join(' · ');
    this.iconPath = iconFor(w);
    const md = new vscode.MarkdownString(undefined, true);
    md.appendMarkdown(`**${w.label}** — ${w.percent}% used\n\n`);
    if (w.resetsAt) md.appendMarkdown(`Resets ${new Date(w.resetsAt).toLocaleString()} (${resetText(w.resetsAt)})\n\n`);
    if (w.detail) md.appendMarkdown(`${w.detail}\n\n`);
    if (w.severity && w.severity !== 'normal') md.appendMarkdown(`Severity: ${w.severity}`);
    this.tooltip = md;
    this.contextValue = 'usage-window';
  }
}

class MessageItem extends vscode.TreeItem {
  constructor(id: string, text: string) {
    super(text, vscode.TreeItemCollapsibleState.None);
    this.id = id;
    this.iconPath = new vscode.ThemeIcon('info');
  }
}

type Node = ToolUsageItem | WindowItem | MessageItem;

function progressBar(percent: number, cells = 10): string {
  const filled = Math.round((percent / 100) * cells);
  return '▰'.repeat(filled) + '▱'.repeat(cells - filled);
}

function resetText(at: number): string {
  const ms = at - Date.now();
  if (ms <= 0) return 'now';
  const m = Math.round(ms / 60000);
  if (m < 60) return `in ${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `in ${h}h ${m % 60}m`;
  const d = Math.floor(h / 24);
  return `in ${d}d ${h % 24}h`;
}

function iconFor(w: UsageWindow): vscode.ThemeIcon {
  if (w.severity === 'locked' || w.percent >= 100) return new vscode.ThemeIcon('lock', new vscode.ThemeColor('charts.red'));
  if (w.severity === 'critical' || w.percent >= 90) return new vscode.ThemeIcon('flame', new vscode.ThemeColor('charts.red'));
  if (w.severity === 'warning' || w.percent >= 70) return new vscode.ThemeIcon('warning', new vscode.ThemeColor('charts.orange'));
  return new vscode.ThemeIcon('pie-chart', new vscode.ThemeColor('charts.green'));
}

export class UsageProvider implements vscode.TreeDataProvider<Node> {
  private readonly changed = new vscode.EventEmitter<Node | undefined>();
  readonly onDidChangeTreeData = this.changed.event;
  private usages: ToolUsage[] = [];

  set(usages: ToolUsage[]): void {
    this.usages = usages;
    this.changed.fire(undefined);
  }

  getTreeItem(element: Node): vscode.TreeItem {
    return element;
  }

  getChildren(element?: Node): Node[] {
    if (!element) return this.usages.map((u) => new ToolUsageItem(u));
    if (element instanceof ToolUsageItem) {
      const u = element.usage;
      if (u.error) return [new MessageItem(`usage:${u.tool}:error`, u.error)];
      if (!u.windows.length) return [new MessageItem(`usage:${u.tool}:none`, 'No limits reported')];
      return u.windows.map((w) => new WindowItem(u.tool, w));
    }
    return [];
  }
}

/** Compact status-bar text like `Claude 49% · 13%  Codex 88%`. */
export function usageStatusText(usages: ToolUsage[]): string {
  return usages
    .filter((u) => !u.error && u.windows.length)
    .map((u) => `${toolLabel(u.tool)} ${u.windows.filter((w) => !w.detail || w.percent > 0).map((w) => `${w.percent}%`).join('/')}`)
    .join('  ');
}

export function usageStatusTooltip(usages: ToolUsage[]): vscode.MarkdownString {
  const md = new vscode.MarkdownString(undefined, true);
  for (const u of usages) {
    md.appendMarkdown(`**${toolLabel(u.tool)}**${u.plan ? ` · ${u.plan}` : ''}\n\n`);
    if (u.error) {
      md.appendMarkdown(`$(warning) ${u.error}\n\n`);
      continue;
    }
    for (const w of u.windows) {
      md.appendMarkdown(`${progressBar(w.percent)} ${w.percent}% ${w.label}${w.resetsAt ? ` · resets ${resetText(w.resetsAt)}` : ''}\n\n`);
    }
    md.appendMarkdown(`_as of ${relativeTime(u.asOf)}_\n\n`);
  }
  return md;
}
