import * as path from 'node:path';
import * as vscode from 'vscode';
import type { SessionState, Tool } from './types.js';

let root = '';
export function initIcons(context: vscode.ExtensionContext): void {
  root = context.extensionPath;
}

/** Theme-aware monochrome vendor marks, shared with the native view toolbar. */
export function toolIcon(tool: Tool): { light: vscode.Uri; dark: vscode.Uri } {
  const file = (theme: 'light' | 'dark') => vscode.Uri.file(path.join(root, 'resources', 'toolbar', `${tool}-${theme}.svg`));
  return { light: file('light'), dark: file('dark') };
}

/** The state glyph (codicon shape and colour) with the tool's mark in the top-right corner — one file per tool × state × theme. */
export function stateIcon(tool: Tool, state: SessionState, archived: boolean): { light: vscode.Uri; dark: vscode.Uri } {
  const name = `${tool}-${archived ? 'archived' : state}`;
  const file = (theme: 'light' | 'dark') => vscode.Uri.file(path.join(root, 'resources', 'state', `${name}-${theme}.svg`));
  return { light: file('light'), dark: file('dark') };
}
