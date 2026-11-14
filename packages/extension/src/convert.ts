// Converts between core's notebook model (Cell, Output) and VS Code's
// (NotebookCellData, NotebookCellOutput).
//
// Cell metadata in VS Code:   { id, polyglot: { mode?, hidden?, pinned? }, meta?: other .ipynb metadata }
// A prompt cell is a code cell in the `tutor-prompt` language whose single
// output holds the answer (ANSWER_MIME, drawn by our renderer, plus a
// text/markdown copy for any other viewer).

import * as vscode from "vscode";
import { newCellId, type Cell, type Lang, type Output, type PromptMode, type PromptUsage } from "@polyglot-tutor/core/browser";

export const NOTEBOOK_TYPE = "polyglot-tutor";
export const PROMPT_LANG = "tutor-prompt";
export const ANSWER_MIME = "application/vnd.polyglot-tutor.answer+json";
const ERROR_MIME = "application/vnd.code.notebook.error";
const STDOUT_MIME = "application/vnd.code.notebook.stdout";
const STDERR_MIME = "application/vnd.code.notebook.stderr";
const CODE_LANGS: readonly Lang[] = ["python", "typescript", "sql"];

/** What our answer renderer receives. */
export interface Answer {
  /** The prompt cell's id (so "Insert as cell" knows where to insert). */
  cellId?: string;
  response: string;
  mode: PromptMode;
  thinking?: string;
  usage?: PromptUsage;
  status: "streaming" | "done" | "error";
  error?: string;
}

export interface CellFlags {
  mode?: PromptMode;
  hidden?: boolean;
  pinned?: boolean;
}

// ---------- outputs ----------

const BINARY = /^image\/(png|jpeg|gif|webp)$/;
const dec = new TextDecoder();

export function toVsOutput(o: Output): vscode.NotebookCellOutput {
  switch (o.kind) {
    case "stream":
      return new vscode.NotebookCellOutput([o.name === "stderr" ? vscode.NotebookCellOutputItem.stderr(o.text) : vscode.NotebookCellOutputItem.stdout(o.text)]);
    case "error":
      return new vscode.NotebookCellOutput(
        [vscode.NotebookCellOutputItem.error({ name: o.ename, message: o.evalue, stack: o.traceback.join("\n") })],
        { polyglot: { traceback: o.traceback } },
      );
    case "display": {
      const items: vscode.NotebookCellOutputItem[] = [];
      for (const [mime, value] of Object.entries(o.data)) {
        if (BINARY.test(mime) && typeof value === "string") items.push(new vscode.NotebookCellOutputItem(Buffer.from(value.replace(/\s/g, ""), "base64"), mime));
        else if (typeof value === "string") items.push(vscode.NotebookCellOutputItem.text(value, mime));
        else items.push(vscode.NotebookCellOutputItem.json(value, mime));
      }
      return new vscode.NotebookCellOutput(items);
    }
  }
}

export function fromVsOutput(o: vscode.NotebookCellOutput): Output | null {
  const first = o.items[0];
  if (!first) return null;
  if (first.mime === STDOUT_MIME || first.mime === STDERR_MIME) {
    return { kind: "stream", name: first.mime === STDERR_MIME ? "stderr" : "stdout", text: o.items.map((i) => dec.decode(i.data)).join("") };
  }
  if (first.mime === ERROR_MIME) {
    const e = JSON.parse(dec.decode(first.data)) as { name: string; message: string; stack?: string };
    const traceback = (o.metadata?.polyglot?.traceback as string[] | undefined) ?? (e.stack ? e.stack.split("\n") : []);
    return { kind: "error", ename: e.name, evalue: e.message, traceback };
  }
  const data: Record<string, unknown> = {};
  for (const item of o.items) {
    if (item.mime === ANSWER_MIME) continue;
    if (BINARY.test(item.mime)) data[item.mime] = Buffer.from(item.data).toString("base64");
    else if (/json/.test(item.mime)) data[item.mime] = JSON.parse(dec.decode(item.data));
    else data[item.mime] = dec.decode(item.data);
  }
  return { kind: "display", data };
}

/** The output of a prompt cell. */
export function answerOutput(a: Answer): vscode.NotebookCellOutput {
  return new vscode.NotebookCellOutput(answerItems(a));
}

export function answerItems(a: Answer): vscode.NotebookCellOutputItem[] {
  return [vscode.NotebookCellOutputItem.json(a, ANSWER_MIME), vscode.NotebookCellOutputItem.text(a.response, "text/markdown")];
}

export function readAnswer(cell: { outputs: readonly vscode.NotebookCellOutput[] }): Answer | null {
  for (const o of cell.outputs) {
    const item = o.items.find((i) => i.mime === ANSWER_MIME);
    if (item) return JSON.parse(dec.decode(item.data)) as Answer;
  }
  return null;
}

// ---------- cells ----------

export function toCellData(c: Cell): vscode.NotebookCellData {
  const flags: CellFlags = { ...(c.hidden ? { hidden: true } : {}), ...(c.pinned ? { pinned: true } : {}) };
  let data: vscode.NotebookCellData;
  if (c.type === "markdown") {
    data = new vscode.NotebookCellData(vscode.NotebookCellKind.Markup, c.source, "markdown");
  } else if (c.type === "prompt") {
    flags.mode = c.mode ?? "hint";
    data = new vscode.NotebookCellData(vscode.NotebookCellKind.Code, c.source, PROMPT_LANG);
    if (c.response || c.usage) {
      data.outputs = [answerOutput({ cellId: c.id, response: c.response ?? "", mode: flags.mode, thinking: c.thinking, usage: c.usage, status: "done" })];
    }
  } else {
    data = new vscode.NotebookCellData(vscode.NotebookCellKind.Code, c.source, c.lang ?? "python");
    data.outputs = c.outputs.map(toVsOutput);
    if (c.executionCount != null) data.executionSummary = { executionOrder: c.executionCount };
  }
  data.metadata = { id: c.id, polyglot: flags, ...(c.meta ? { meta: c.meta } : {}) };
  return data;
}

interface CellLike {
  kind: vscode.NotebookCellKind;
  value: string;
  languageId: string;
  metadata?: { [key: string]: any };
  outputs?: readonly vscode.NotebookCellOutput[];
  executionSummary?: vscode.NotebookCellExecutionSummary;
}

/** A VS Code cell (live or serialised) as a core Cell. */
export function fromCellData(d: CellLike): Cell {
  const flags = (d.metadata?.polyglot ?? {}) as CellFlags;
  const common = {
    id: typeof d.metadata?.id === "string" ? d.metadata.id : newCellId(),
    ...(flags.hidden ? { hidden: true } : {}),
    ...(flags.pinned ? { pinned: true } : {}),
    ...(d.metadata?.meta ? { meta: d.metadata.meta as Record<string, unknown> } : {}),
  };
  if (d.kind === vscode.NotebookCellKind.Markup) return { ...common, type: "markdown", source: d.value, outputs: [] };
  if (d.languageId === PROMPT_LANG) {
    const a = readAnswer({ outputs: d.outputs ?? [] });
    return {
      ...common,
      type: "prompt",
      source: d.value,
      mode: flags.mode ?? a?.mode ?? "hint",
      response: a?.response ?? "",
      ...(a?.usage ? { usage: a.usage } : {}),
      ...(a?.thinking ? { thinking: a.thinking } : {}),
      outputs: [],
    };
  }
  return {
    ...common,
    type: "code",
    lang: (CODE_LANGS as readonly string[]).includes(d.languageId) ? (d.languageId as Lang) : "python",
    source: d.value,
    outputs: (d.outputs ?? []).map(fromVsOutput).filter((o): o is Output => o !== null),
    executionCount: d.executionSummary?.executionOrder ?? null,
  };
}

/** A live cell as a core Cell. */
export const fromCell = (c: vscode.NotebookCell): Cell =>
  fromCellData({ kind: c.kind, value: c.document.getText(), languageId: c.document.languageId, metadata: c.metadata, outputs: c.outputs, executionSummary: c.executionSummary });

export const cellFlags = (c: vscode.NotebookCell): CellFlags => (c.metadata?.polyglot ?? {}) as CellFlags;

export const cellId = (c: vscode.NotebookCell): string => (typeof c.metadata?.id === "string" ? c.metadata.id : `cell-${c.index}`);

/** Cell metadata with some flags changed. */
export function withFlags(c: vscode.NotebookCell, patch: CellFlags): Record<string, unknown> {
  const flags = { ...cellFlags(c), ...patch };
  for (const k of Object.keys(flags) as (keyof CellFlags)[]) if (flags[k] === undefined || flags[k] === false) delete flags[k];
  return { ...c.metadata, id: cellId(c), polyglot: flags };
}

export const isCodeLang = (lang: string): lang is Lang => (CODE_LANGS as readonly string[]).includes(lang);
