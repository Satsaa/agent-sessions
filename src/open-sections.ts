import * as vscode from 'vscode';

/**
 * Which sections a person opened or closed: the Sessions view's groups, a session's notes rows, the Worktrees view's
 * repositories and Inactive rows. A section is named by what it is, not by its row id, so a row that is new (another
 * current session, another session's Tasks row, a reloaded window) opens or closes as that kind of row last did.
 * Kept in globalState, so every window follows the same choice.
 */
const KEY = 'openSections';

let store: vscode.Memento | undefined;

/** A row that opens and closes as its section was last left. */
export interface Section {
  readonly section: string;
}

export function rememberOpenSections(memento: vscode.Memento): void {
  store = memento;
}

/** The row's state: as the person last left `section`, else `open`. */
export function sectionState(section: string, open: boolean): vscode.TreeItemCollapsibleState {
  const remembered = store?.get<Record<string, boolean>>(KEY, {})[section];
  return (remembered ?? open) ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed;
}

/** Records every section row `view` opens or closes, the view's Collapse All included. */
export function trackOpenSections<T>(view: vscode.TreeView<T>): vscode.Disposable {
  const record = (element: T, open: boolean) => {
    if (!store || typeof element !== 'object' || element === null || !('section' in element) || typeof element.section !== 'string') return;
    const all = store.get<Record<string, boolean>>(KEY, {});
    if (all[element.section] === open) return;
    void store.update(KEY, { ...all, [element.section]: open });
  };
  return vscode.Disposable.from(
    view.onDidExpandElement((e) => record(e.element, true)),
    view.onDidCollapseElement((e) => record(e.element, false)),
  );
}
