import * as path from 'node:path';
import * as vscode from 'vscode';
import type { SessionState, Tool } from './types.js';

let root = '';
export function initIcons(context: vscode.ExtensionContext): void {
  root = context.extensionPath;
}

/** The vendor's own mark: Claude's orange spark, Codex's blossom (black on light themes, white on dark). */
export function toolIcon(tool: Tool): { light: vscode.Uri; dark: vscode.Uri } {
  const file = (name: string) => vscode.Uri.file(path.join(root, 'resources', name));
  return tool === 'claude'
    ? { light: file('claude.svg'), dark: file('claude.svg') }
    : { light: file('codex-light.svg'), dark: file('codex-dark.svg') };
}

/** The state glyph (codicon shape and colour) with the tool's mark in the top-right corner — one file per tool × state × theme. */
export function stateIcon(tool: Tool, state: SessionState, archived: boolean): { light: vscode.Uri; dark: vscode.Uri } {
  const name = `${tool}-${archived ? 'archived' : state}`;
  const file = (theme: 'light' | 'dark') => vscode.Uri.file(path.join(root, 'resources', 'state', `${name}-${theme}.svg`));
  return { light: file('light'), dark: file('dark') };
}
