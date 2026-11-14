// When one of our notebooks is opened in the Jupyter editor, offer to reopen
// it with Polyglot Tutor (and to remember that for the workspace).

import * as vscode from "vscode";
import { NOTEBOOK_TYPE } from "./convert.ts";

const DECLINED = "polyglotTutor.reopenDeclined";

/** The built-in .ipynb serializer keeps the file's metadata under `metadata` (older versions: `custom.metadata`). */
export const isPolyglotNotebook = (nb: vscode.NotebookDocument) =>
  nb.notebookType === "jupyter-notebook" && !!(nb.metadata?.metadata?.polyglot ?? nb.metadata?.custom?.metadata?.polyglot);

export async function reopenWithTutor(uri: vscode.Uri) {
  // VS Code won't open a file in a second notebook type while it's open in another one,
  // so close the other editor(s) first and wait for the document to be released.
  const key = uri.toString();
  const other = vscode.window.tabGroups.all
    .flatMap((g) => g.tabs)
    .filter((t) => t.input instanceof vscode.TabInputNotebook && t.input.uri.toString() === key && t.input.notebookType !== NOTEBOOK_TYPE);
  if (other.length) {
    if (!(await vscode.window.tabGroups.close(other))) return; // the user kept unsaved changes
    for (let i = 0; i < 40 && vscode.workspace.notebookDocuments.some((d) => d.uri.toString() === key && d.notebookType !== NOTEBOOK_TYPE); i++) {
      await new Promise((r) => setTimeout(r, 50));
    }
  }
  await vscode.commands.executeCommand("vscode.openWith", uri, NOTEBOOK_TYPE);
}

export function offerReopen(memento: vscode.Memento): vscode.Disposable {
  const offer = async (nb: vscode.NotebookDocument) => {
    if (!isPolyglotNotebook(nb) || memento.get(DECLINED) || nb.uri.scheme !== "file") return;
    const hasWorkspace = !!vscode.workspace.workspaceFolders?.length;
    const choice = await vscode.window.showInformationMessage(
      `${vscode.workspace.asRelativePath(nb.uri)} was made with Polyglot Tutor. Open it with Polyglot Tutor to run prompt cells and mixed-language cells?`,
      "Reopen",
      ...(hasWorkspace ? ["Always in This Workspace"] : []),
      "Not Now",
    );
    if (choice === "Not Now" || !choice) return void memento.update(DECLINED, true);
    if (choice === "Always in This Workspace") {
      const cfg = vscode.workspace.getConfiguration("workbench");
      const current = cfg.inspect<Record<string, string>>("editorAssociations")?.workspaceValue ?? {};
      await cfg.update("editorAssociations", { ...current, "*.ipynb": NOTEBOOK_TYPE }, vscode.ConfigurationTarget.Workspace);
    }
    await reopenWithTutor(nb.uri);
  };
  vscode.workspace.notebookDocuments.forEach((nb) => void offer(nb));
  return vscode.workspace.onDidOpenNotebookDocument((nb) => void offer(nb));
}
