// Pylance analyses our notebooks with the workspace's selected interpreter. If
// that isn't the environment the kernels run on, imports like pandas show as
// unresolved, so ask once per workspace whether to switch it.

import * as vscode from "vscode";
import path from "node:path";

const ASKED = "polyglotTutor.pythonEnvAsked";

interface PythonApi {
  environments?: {
    getActiveEnvironmentPath(resource?: vscode.Uri): { path: string };
    updateActiveEnvironmentPath(env: string, resource?: vscode.Uri): Promise<void>;
  };
}

export async function offerPythonEnvironment(memento: vscode.Memento, nb: vscode.NotebookDocument, python: string | undefined) {
  const ext = vscode.extensions.getExtension<PythonApi>("ms-python.python");
  const folder = vscode.workspace.getWorkspaceFolder(nb.uri);
  if (!ext || !python || !folder || memento.get(ASKED)) return;
  try {
    const api = (await ext.activate())?.environments;
    if (!api) return;
    const current = api.getActiveEnvironmentPath(folder.uri)?.path;
    if (current && path.resolve(current) === path.resolve(python)) return;
    await memento.update(ASKED, true);
    const choice = await vscode.window.showInformationMessage(
      "Use the Polyglot Tutor Python environment for code intelligence (Pylance) in this workspace? Imports like pandas then resolve in notebook cells.",
      "Use It",
      "No",
    );
    if (choice === "Use It") await api.updateActiveEnvironmentPath(python, folder.uri);
  } catch {
    /* the Python extension's API is optional */
  }
}
