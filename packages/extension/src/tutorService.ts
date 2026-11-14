// Turns a prompt cell into a tutor request and records the prompt cache.

import * as vscode from "vscode";
import path from "node:path";
import { Tutor, type AskResult } from "@polyglot-tutor/core";
import { cacheInfoFor, toContextCells, type AskRequest, type Cell, type ContextCell, type PromptMode } from "@polyglot-tutor/core/browser";
import { MISSING_KEY_HELP, type ApiKeys } from "./apiKey.ts";
import { tutorSettings } from "./config.ts";
import { cellId, fromCell } from "./convert.ts";
import type { NotebookStates } from "./notebookState.ts";

/** Supplies TypeScript type errors for a cell ("line N: message"), e.g. from our checker. */
export type TypeErrorSource = (cell: vscode.NotebookCell) => string[];

export class TutorService {
  readonly tutor: Tutor;

  constructor(
    storage: vscode.Uri,
    keys: ApiKeys,
    private states: NotebookStates,
    private typeErrors: TypeErrorSource = () => [],
  ) {
    this.tutor = new Tutor({
      apiKey: () => keys.get(),
      summaryCacheFile: path.join(storage.fsPath, "summaries.json"),
      missingKeyHelp: MISSING_KEY_HELP,
    });
  }

  setTypeErrorSource(source: TypeErrorSource) {
    this.typeErrors = source;
  }

  /** Visible cells above position `end`, with type errors, as the tutor sees them. */
  contextCells(nb: vscode.NotebookDocument, end: number): ContextCell[] {
    const cells: Cell[] = nb.getCells().map(fromCell);
    const ctx = toContextCells(cells, end);
    for (const c of ctx) {
      if (c.lang !== "typescript") continue;
      const cell = nb.cellAt(c.index - 1);
      c.typeErrors = this.typeErrors(cell);
    }
    return ctx;
  }

  private request(nb: vscode.NotebookDocument, cellIdValue: string, cells: ContextCell[], question: string, mode: PromptMode): AskRequest {
    return { notebook: nb.uri.toString(), cellId: cellIdValue, cells, question, mode, ...tutorSettings() };
  }

  /** Ask about a prompt cell; streams text and reasoning through the handlers. */
  async ask(
    cell: vscode.NotebookCell,
    mode: PromptMode,
    h: { onText: (t: string) => void; onThinking: (t: string) => void },
    signal: AbortSignal,
  ): Promise<AskResult> {
    const nb = cell.notebook;
    const req = this.request(nb, cellId(cell), this.contextCells(nb, cell.index), cell.document.getText(), mode);
    const r = await this.tutor.ask(req, h, signal);
    const info = cacheInfoFor(req, r.cache);
    if (info) this.states.setCache(nb.uri, info);
    return r;
  }

  /** Re-read the cached prefix to reset the cache timer. Returns false when there is nothing cached. */
  async keepWarm(nb: vscode.NotebookDocument): Promise<boolean> {
    const settings = tutorSettings();
    const cache = this.states.get(nb.uri).cache[settings.model];
    if (!cache) return false;
    const ids = new Set(cache.cells.map((c) => c.id));
    let end = 0;
    nb.getCells().forEach((c, i) => ids.has(cellId(c)) && (end = i + 1));
    const req = this.request(nb, "", this.contextCells(nb, end).slice(0, cache.cells.length), "", "hint");
    const r = await this.tutor.keepWarm(req);
    const info = cacheInfoFor(req, r.cache);
    if (info) this.states.setCache(nb.uri, info);
    return true;
  }

  describeError(e: unknown) {
    return this.tutor.describeError(e);
  }
}
