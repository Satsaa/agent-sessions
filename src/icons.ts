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

export type Tint = 'blue' | 'green' | 'grey';

/** State → tint: working is green, a reply or question waiting on you is blue, stopped or archived is grey. */
export function tintFor(state: SessionState, archived: boolean): Tint {
  if (archived) return 'grey';
  switch (state) {
    case 'running':
      return 'green';
    case 'waiting':
    case 'replied':
      return 'blue';
    case 'stopped':
      return 'grey';
  }
}

/** The vendor's mark pre-tinted (file icons cannot take theme colours), the same file on both themes. */
export function tintedToolIcon(tool: Tool, tint: Tint): { light: vscode.Uri; dark: vscode.Uri } {
  const uri = vscode.Uri.file(path.join(root, 'resources', `${tool}-${tint}.svg`));
  return { light: uri, dark: uri };
}
