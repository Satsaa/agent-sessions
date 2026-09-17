import * as path from 'node:path';
import * as vscode from 'vscode';
import type { RepoWorktree } from './worktree.js';

export async function deleteWorktree(worktree: RepoWorktree): Promise<void> {
  if (worktree.isMain || path.resolve(worktree.path) === path.resolve(worktree.repoRoot)) return;
  const extension = vscode.extensions.getExtension<unknown>('vscode.git');
  if (!extension) throw new Error('Enable the built-in Git extension to delete worktrees.');
  const exported: unknown = await extension.activate();
  if (!(await vscode.commands.getCommands(true)).includes('git.repositories.deleteWorktree')) {
    throw new Error('This VS Code version does not provide the Repositories worktree delete action. Update VS Code to use this button.');
  }
  if (!exported || typeof exported !== 'object' || !('getAPI' in exported) || typeof exported.getAPI !== 'function') {
    throw new Error('The built-in Git extension API is unavailable.');
  }
  const api: unknown = exported.getAPI(1);
  if (!api || typeof api !== 'object' || !('getRepository' in api) || typeof api.getRepository !== 'function') {
    throw new Error('The built-in Git repository API is unavailable.');
  }
  await vscode.commands.executeCommand('git.openRepository', worktree.repoRoot);
  const root = vscode.Uri.file(worktree.repoRoot);
  const repository: unknown = api.getRepository(root);
  if (!repository || typeof repository !== 'object' || !('rootUri' in repository)
    || !(repository.rootUri instanceof vscode.Uri) || path.resolve(repository.rootUri.fsPath) !== path.resolve(worktree.repoRoot)) {
    throw new Error('Open the main repository in Source Control before deleting this worktree.');
  }
  // The repositories submenu passes the repository URI and a worktree artifact whose id is its path.
  await vscode.commands.executeCommand('git.repositories.deleteWorktree', root, { id: worktree.path });
}
