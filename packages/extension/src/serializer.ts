// Reads and writes .ipynb files in the same format as the web app.

import * as vscode from "vscode";
import { fromIpynb, newCellId, toIpynb, type Notebook } from "@polyglot-tutor/core/browser";
import { fromCellData, toCellData } from "./convert.ts";

const dec = new TextDecoder();
const enc = new TextEncoder();

export class IpynbSerializer implements vscode.NotebookSerializer {
  deserializeNotebook(content: Uint8Array): vscode.NotebookData {
    const text = dec.decode(content).trim();
    const nb: Notebook = text ? fromIpynb("notebook.ipynb", JSON.parse(text)) : starterNotebook();
    const data = new vscode.NotebookData(nb.cells.map(toCellData));
    data.metadata = nb.meta ? { meta: nb.meta } : {};
    return data;
  }

  serializeNotebook(data: vscode.NotebookData): Uint8Array {
    const nb: Notebook = { name: "notebook.ipynb", cells: data.cells.map(fromCellData), ...(data.metadata?.meta ? { meta: data.metadata.meta } : {}) };
    return enc.encode(JSON.stringify(toIpynb(nb), null, 1) + "\n");
  }
}

/** What a brand-new notebook starts with. */
export function starterNotebook(): Notebook {
  return {
    name: "notebook.ipynb",
    cells: [
      { id: newCellId(), type: "markdown", source: "# My notebook\n\nCode cells run Python, TypeScript or SQL (pick the language at the bottom right of a cell). Prompt cells ask the tutor about everything above them.", outputs: [] },
      { id: newCellId(), type: "code", lang: "typescript", source: "", outputs: [] },
    ],
  };
}
