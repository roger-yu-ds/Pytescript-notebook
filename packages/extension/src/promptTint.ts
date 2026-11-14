// Tints Tutor Prompt cells so they stand out from code cells.
//
// VS Code has no API to colour a whole notebook cell, so this decorates every line of a prompt cell's
// editor (a whole-line background) and marks it in the scrollbar. The colours are theme colours
// (polyglotTutor.promptCellBackground, polyglotTutor.promptCellRuler) that users can override in
// workbench.colorCustomizations; polyglotTutor.tintPromptCells turns it off.

import * as vscode from "vscode";
import { PROMPT_LANG } from "./convert.ts";

export const PROMPT_BACKGROUND = "polyglotTutor.promptCellBackground";
export const PROMPT_RULER = "polyglotTutor.promptCellRuler";
const SETTING = "tintPromptCells";

const isCellEditor = (e: vscode.TextEditor) => e.document.uri.scheme === "vscode-notebook-cell";

export function registerPromptTint(): vscode.Disposable {
  const decoration = vscode.window.createTextEditorDecorationType({
    isWholeLine: true,
    backgroundColor: new vscode.ThemeColor(PROMPT_BACKGROUND),
    overviewRulerColor: new vscode.ThemeColor(PROMPT_RULER),
    overviewRulerLane: vscode.OverviewRulerLane.Full,
  });
  const enabled = () => vscode.workspace.getConfiguration("polyglotTutor").get<boolean>(SETTING, true);

  /** Tint the prompt cells among `editors`; clear cells that are no longer prompts (or when turned off). */
  const apply = (editors: readonly vscode.TextEditor[] = vscode.window.visibleTextEditors) => {
    const on = enabled();
    for (const editor of editors) {
      if (!isCellEditor(editor)) continue;
      const doc = editor.document;
      const tint = on && doc.languageId === PROMPT_LANG;
      // One range over every line; re-applied on edits so new lines are covered too.
      editor.setDecorations(decoration, tint ? [new vscode.Range(0, 0, Math.max(0, doc.lineCount - 1), 0)] : []);
    }
  };
  const forDocument = (doc: vscode.TextDocument) => apply(vscode.window.visibleTextEditors.filter((e) => e.document === doc));

  apply();
  return vscode.Disposable.from(
    decoration,
    vscode.window.onDidChangeVisibleTextEditors((editors) => apply(editors)),
    vscode.workspace.onDidChangeTextDocument((e) => {
      if (e.document.uri.scheme === "vscode-notebook-cell" && e.document.languageId === PROMPT_LANG) forDocument(e.document);
    }),
    // Changing a cell's language reopens its document.
    vscode.workspace.onDidOpenTextDocument((doc) => doc.uri.scheme === "vscode-notebook-cell" && setTimeout(() => forDocument(doc), 0)),
    vscode.workspace.onDidChangeConfiguration((e) => e.affectsConfiguration(`polyglotTutor.${SETTING}`) && apply()),
  );
}
