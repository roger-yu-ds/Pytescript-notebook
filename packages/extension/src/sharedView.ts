// "Shared Values" view in the Explorer: what the active notebook has shared
// with share() (💾 = saved as a Delta table).

import * as vscode from "vscode";
import type { SharedItem } from "@polyglot-tutor/core/browser";
import { NOTEBOOK_TYPE } from "./convert.ts";
import type { NotebookStates } from "./notebookState.ts";

export const SHARED_VIEW = "polyglotTutor.shared";

export class SharedValuesView implements vscode.TreeDataProvider<SharedItem>, vscode.Disposable {
  private changed = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changed.event;
  private disposables: vscode.Disposable[];

  constructor(private states: NotebookStates) {
    this.disposables = [
      this.changed,
      vscode.window.onDidChangeActiveNotebookEditor(() => this.changed.fire()),
      states.onDidChange(() => this.changed.fire()),
    ];
  }

  private active() {
    const nb = vscode.window.activeNotebookEditor?.notebook;
    return nb?.notebookType === NOTEBOOK_TYPE ? nb : undefined;
  }

  getChildren(): SharedItem[] {
    const nb = this.active();
    return nb ? [...this.states.get(nb.uri).shared].sort((a, b) => a.name.localeCompare(b.name)) : [];
  }

  getTreeItem(i: SharedItem): vscode.TreeItem {
    const item = new vscode.TreeItem(i.name);
    item.description = i.summary;
    item.iconPath = new vscode.ThemeIcon(i.persisted ? "database" : i.kind === "table" ? "table" : "json");
    item.tooltip = new vscode.MarkdownString(
      `**${i.name}** — ${i.summary}\n\nShared from ${i.from}${i.persisted ? " · saved as a Delta table (survives restarts; `get(name, version=N)` / `delta_at(name, N)` for older versions)" : ""}\n\nPython: \`get("${i.name}")\` · TypeScript: \`await get("${i.name}")\`${i.kind === "table" ? ` · SQL: \`select * from ${i.name}\`` : ""}`,
    );
    item.contextValue = i.kind;
    return item;
  }

  dispose() {
    for (const d of this.disposables) d.dispose();
  }
}
