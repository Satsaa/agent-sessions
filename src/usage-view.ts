import * as vscode from 'vscode';
import { randomBytes } from 'node:crypto';
import { toolLabel } from './types.js';
import { toolIcon } from './icons.js';
import { relativeTime } from './util.js';
import type { ToolUsage, UsageWindow } from './usage.js';

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function windowHtml(w: UsageWindow): string {
  const left = remaining(w);
  const reset = w.resetsAt ? ` · resets ${resetText(w.resetsAt)}` : '';
  const title = [
    `${w.label} — ${left}% left (${w.percent}% used)`,
    w.resetsAt ? `Resets ${new Date(w.resetsAt).toLocaleString()} (${resetText(w.resetsAt)})` : '',
    w.detail,
    w.severity && w.severity !== 'normal' ? `Severity: ${w.severity}` : '',
  ].filter(Boolean).join('\n');
  const value = w.detail ? escapeHtml(w.detail) : `<span class="bar ${usageTone(w)}" role="meter" aria-label="${escapeHtml(w.label)} remaining" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${left}">${progressBar(left)}</span> <span>${left}%</span>`;
  return `<li title="${escapeHtml(title)}"><span class="window-label">${escapeHtml(w.label)}</span><span class="value">${value}${escapeHtml(reset)}</span></li>`;
}

export class UsageProvider implements vscode.WebviewViewProvider {
  private view: vscode.WebviewView | undefined;
  private usages: ToolUsage[] = [];
  private description = '';

  constructor(private readonly extensionUri: vscode.Uri) {}

  set(usages: ToolUsage[], description = ''): void {
    this.usages = usages;
    this.description = description;
    if (this.view) {
      this.view.description = description;
      void this.view.webview.postMessage({ html: this.groupsHtml(this.view.webview) });
    }
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.description = this.description;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'resources', 'toolbar')],
    };
    view.onDidDispose(() => { this.view = undefined; });
    view.onDidChangeVisibility(() => {
      if (view.visible) void view.webview.postMessage({ html: this.groupsHtml(view.webview) });
    });
    view.webview.onDidReceiveMessage((message: unknown) => {
      if (message === 'ready') void view.webview.postMessage({ html: this.groupsHtml(view.webview) });
    });
    const nonce = randomBytes(16).toString('hex');
    view.webview.html = `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${view.webview.cspSource}; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
<style nonce="${nonce}">
body { padding: 0; margin: 0; color: var(--vscode-foreground); background: var(--vscode-sideBar-background); font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); }
summary { cursor: pointer; display: flex; align-items: center; gap: 6px; height: 22px; padding: 0 8px; list-style: none; }
summary::-webkit-details-marker { display: none; }
summary::before { content: ''; width: 5px; height: 5px; border-right: 1px solid; border-bottom: 1px solid; transform: rotate(-45deg); margin-right: 4px; }
details[open] > summary::before { transform: rotate(45deg); }
summary:hover { background: var(--vscode-list-hoverBackground); }
summary:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
img { width: 16px; height: 16px; }
.light { display: none; }
.vscode-light .light, .vscode-high-contrast-light .light { display: block; }
.vscode-light .dark, .vscode-high-contrast-light .dark { display: none; }
/* Secondary text is dimmed the way a tree row's description is, by colour rather than opacity so the meter inside keeps its full tone. */
.plan, .value { color: var(--vscode-descriptionForeground); font-size: .9em; }
.plan { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
ul { list-style: none; margin: 0; padding: 0; }
li { display: flex; align-items: baseline; gap: 6px; min-height: 22px; line-height: 22px; padding: 0 8px 0 28px; white-space: nowrap; }
.value { overflow: hidden; text-overflow: ellipsis; }
.bar { white-space: pre; }
.green { color: var(--vscode-charts-green); }
/* Not the theme's charts.orange: the default dark theme defines that as a burnt #d18616 that reads as brown. */
.orange { color: #e07b1a; }
.red { color: var(--vscode-charts-red); }
.stale { color: var(--vscode-editorWarning-foreground); }
.message { white-space: normal; opacity: .7; }
</style></head><body><main>${this.groupsHtml(view.webview)}</main>
<script nonce="${nonce}">
const vscode = acquireVsCodeApi();
const main = document.querySelector('main');
const collapsed = vscode.getState() || {};
function restore() {
  for (const group of main.querySelectorAll('details')) {
    group.open = !collapsed[group.dataset.tool];
    group.addEventListener('toggle', () => {
      collapsed[group.dataset.tool] = !group.open;
      vscode.setState(collapsed);
    });
  }
}
restore();
window.addEventListener('message', event => {
  const focused = document.activeElement.closest('details')?.dataset.tool;
  main.innerHTML = event.data.html;
  restore();
  if (focused) main.querySelector('details[data-tool="' + focused + '"] summary')?.focus();
});
vscode.postMessage('ready');
</script></body></html>`;
  }

  private groupsHtml(webview: vscode.Webview): string {
    return this.usages.map((u) => {
      const icons = toolIcon(u.tool);
      const title = [toolLabel(u.tool), u.account, u.plan, u.inactive ? 'Saved login, not the one Codex runs under' : '', u.error, u.asOf ? `As of ${relativeTime(u.asOf)} (${new Date(u.asOf).toLocaleString()})` : '', `Source: ${u.source}`].filter(Boolean).join('\n');
      const message = !u.windows.length ? u.error ?? 'No limits reported' : '';
      const rows = u.windows.map(windowHtml).join('') + (message ? `<li class="message">${escapeHtml(message)}</li>` : '');
      const warning = isUsageStale(u) ? '<span class="stale" role="img" aria-label="Usage is more than 10 minutes old" title="Usage is more than 10 minutes old">⚠</span>' : '';
      // With several Codex logins the account tells the groups apart; the collapsed state is remembered per login.
      const manyCodex = this.usages.filter((x) => x.tool === 'codex').length > 1;
      const plan = u.error && !u.windows.length ? 'unavailable' : u.plan ?? '';
      const sub = manyCodex && u.tool === 'codex' ? [u.account, plan].filter(Boolean).join(' · ') : plan;
      const key = u.tool === 'codex' && u.account ? `${u.tool}:${u.account}` : u.tool;
      return `<details data-tool="${escapeHtml(key)}" open><summary title="${escapeHtml(title)}"><img class="light" src="${escapeHtml(webview.asWebviewUri(icons.light).toString())}" alt=""><img class="dark" src="${escapeHtml(webview.asWebviewUri(icons.dark).toString())}" alt=""><span>${toolLabel(u.tool)}</span>${warning}<span class="plan">${escapeHtml(sub)}</span></summary><ul>${rows}</ul></details>`;
    }).join('');
  }
}

export function isUsageStale(usage: ToolUsage): boolean {
  return usage.windows.length > 0 && Date.now() - usage.asOf > 10 * 60 * 1000;
}

/** Windows count down: 100% is a fresh window, 0% is exhausted. */
export function remaining(w: UsageWindow): number {
  return Math.max(0, Math.min(100, 100 - w.percent));
}

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

/** Colour of a window: red under 10% left, orange under 20%, green otherwise; the provider's own "locked" is red regardless. */
function usageTone(w: UsageWindow): 'red' | 'orange' | 'green' {
  const left = remaining(w);
  if (w.severity === 'locked' || left < 10) return 'red';
  if (left < 20) return 'orange';
  return 'green';
}

/** Compact status-bar text like `Claude 51%/87%  Codex 12%` — percent LEFT in each window. */
export function usageStatusText(usages: ToolUsage[]): string {
  return usages
    .filter((u) => u.windows.length && !u.inactive)
    .map((u) => `${isUsageStale(u) ? '$(warning) ' : ''}${toolLabel(u.tool)} ${u.windows.filter((w) => !w.detail || w.percent > 0).map((w) => `${remaining(w)}%`).join('/')}`)
    .join('  ');
}

/** The tightest window across both tools decides the status bar colour. */
export function usageStatusColor(usages: ToolUsage[]): vscode.ThemeColor | undefined {
  let worst: UsageWindow | undefined;
  for (const u of usages) if (!u.inactive) for (const w of u.windows) if (!w.detail && (!worst || remaining(w) < remaining(worst))) worst = w;
  if (!worst) return undefined;
  const left = remaining(worst);
  if (worst.severity === 'locked' || left < 10) return new vscode.ThemeColor('statusBarItem.errorForeground');
  if (left < 20) return new vscode.ThemeColor('statusBarItem.warningForeground');
  return undefined;
}

export function usageStatusTooltip(usages: ToolUsage[]): vscode.MarkdownString {
  const md = new vscode.MarkdownString(undefined, true);
  for (const u of usages) {
    md.appendMarkdown(`**${toolLabel(u.tool)}**${u.account ? ` · ${u.account}` : ''}${u.plan ? ` · ${u.plan}` : ''}\n\n`);
    if (u.error) {
      md.appendMarkdown(`${u.error}\n\n`);
    }
    for (const w of u.windows) {
      md.appendMarkdown(`${progressBar(remaining(w))} ${remaining(w)}% left · ${w.label}${w.resetsAt ? ` · resets ${resetText(w.resetsAt)}` : ''}\n\n`);
    }
    if (u.windows.length) md.appendMarkdown(`${isUsageStale(u) ? '$(warning) Usage is more than 10 minutes old. ' : ''}_as of ${relativeTime(u.asOf)} (${new Date(u.asOf).toLocaleString()})_\n\n`);
  }
  return md;
}
