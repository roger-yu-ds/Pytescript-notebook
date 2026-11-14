// Small items under each cell: Hint/Answer on prompt cells, 🙈 / 📌 when set,
// and "Ask about this error" on cells whose last run failed.

import * as vscode from "vscode";
import { PROMPT_LANG, cellFlags, readAnswer } from "./convert.ts";

export class CellStatusBar implements vscode.NotebookCellStatusBarItemProvider {
  private changed = new vscode.EventEmitter<void>();
  readonly onDidChangeCellStatusBarItems = this.changed.event;

  refresh() {
    this.changed.fire();
  }

  provideCellStatusBarItems(cell: vscode.NotebookCell): vscode.NotebookCellStatusBarItem[] {
    const items: vscode.NotebookCellStatusBarItem[] = [];
    const flags = cellFlags(cell);
    const arg = (command: string, title: string) => ({ command, title, arguments: [cell] });

    if (cell.document.languageId === PROMPT_LANG) {
      const answer = flags.mode === "answer";
      const item = new vscode.NotebookCellStatusBarItem(answer ? "$(check) Answer" : "$(lightbulb) Hint", vscode.NotebookCellStatusBarAlignment.Left);
      item.tooltip = answer
        ? "Answer mode: the tutor gives the full solution. Click for Hint mode."
        : "Hint mode: the tutor nudges you toward the answer. Click for the full answer.";
      item.command = arg("polyglotTutor.toggleMode", "Toggle Hint / Answer");
      items.push(item);
      const usage = readAnswer(cell)?.usage;
      if (usage) {
        const u = new vscode.NotebookCellStatusBarItem(
          `$(info) ${(usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens).toLocaleString()} in · ${usage.outputTokens.toLocaleString()} out · $${usage.costUsd.toFixed(4)}`,
          vscode.NotebookCellStatusBarAlignment.Right,
        );
        u.tooltip = `${usage.model}: ${usage.inputTokens} uncached + ${usage.cacheReadTokens} cache-read + ${usage.cacheWriteTokens} cache-write input tokens${usage.summarizedBlocks ? `; ${usage.summarizedBlocks} old blocks summarised` : ""}`;
        items.push(u);
      }
    }
    if (flags.hidden) {
      const h = new vscode.NotebookCellStatusBarItem("$(eye-closed) hidden from tutor", vscode.NotebookCellStatusBarAlignment.Left);
      h.tooltip = "The tutor doesn't see this cell. Click to show it again.";
      h.command = arg("polyglotTutor.toggleHidden", "Show to tutor");
      items.push(h);
    }
    if (flags.pinned) {
      const p = new vscode.NotebookCellStatusBarItem("$(pinned) sent in full", vscode.NotebookCellStatusBarAlignment.Left);
      p.tooltip = "Always sent to the tutor untruncated. Click to unpin.";
      p.command = arg("polyglotTutor.togglePinned", "Unpin");
      items.push(p);
    }
    if (cell.kind === vscode.NotebookCellKind.Code && cell.document.languageId !== PROMPT_LANG && cell.executionSummary?.success === false) {
      const a = new vscode.NotebookCellStatusBarItem("$(comment-discussion) Ask about this error", vscode.NotebookCellStatusBarAlignment.Left);
      a.tooltip = "Insert a prompt cell below asking the tutor about this error";
      a.command = arg("polyglotTutor.askAboutError", "Ask about this error");
      items.push(a);
    }
    return items;
  }
}
