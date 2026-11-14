// .ipynb (nbformat 4) codec. Polyglot-specific data lives in
// metadata.polyglot so files still open in Jupyter and on GitHub:
//   - code cells: metadata.polyglot.lang = "python" | "typescript" | "sql"
//   - prompt cells: markdown cells (readable anywhere) with the question,
//     answer, mode and usage in metadata.polyglot (type: "prompt")
// Browser-safe.

import type { Cell, Notebook, Output } from "./types.ts";

/** Short random cell id (nbformat 4.5 ids). */
export const newCellId = () => Math.random().toString(36).slice(2, 10).padEnd(8, "0");

/** True if the document was written by Polyglot Tutor (or the web app before it). */
export const isPolyglotIpynb = (nb: any) => !!nb?.metadata?.polyglot;

const joinSrc = (s: unknown) => (Array.isArray(s) ? s.join("") : typeof s === "string" ? s : "");
const splitSrc = (s: string) => (s === "" ? [] : s.split(/(?<=\n)/));

function outputFromIpynb(o: any): Output | null {
  switch (o.output_type) {
    case "stream":
      return { kind: "stream", name: o.name === "stderr" ? "stderr" : "stdout", text: joinSrc(o.text) };
    case "display_data":
    case "execute_result": {
      const data: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(o.data ?? {})) data[k] = Array.isArray(v) ? v.join("") : v;
      return { kind: "display", data };
    }
    case "error":
      return { kind: "error", ename: o.ename, evalue: o.evalue, traceback: o.traceback ?? [] };
    default:
      return null;
  }
}

function outputToIpynb(o: Output): any {
  switch (o.kind) {
    case "stream":
      return { output_type: "stream", name: o.name, text: splitSrc(o.text) };
    case "display":
      return { output_type: "display_data", data: o.data, metadata: {} };
    case "error":
      return { output_type: "error", ename: o.ename, evalue: o.evalue, traceback: o.traceback };
  }
}

/** Parse an .ipynb document (already JSON-parsed). */
export function fromIpynb(name: string, nb: any): Notebook {
  const defaultLang = nb?.metadata?.kernelspec?.name === "deno" ? "typescript" : "python";
  const cells: Cell[] = (nb.cells ?? []).map((c: any): Cell => withoutUndefined(parseCell(c, defaultLang)));
  const { polyglot: _ours, ...meta } = nb?.metadata ?? {};
  return { name, cells, ...(Object.keys(meta).length ? { meta } : {}) };
}

/** Drop keys whose value is undefined (keeps parsed cells canonical). */
function withoutUndefined<T extends object>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;
}

function parseCell(c: any, defaultLang: "python" | "typescript"): Cell {
  const { polyglot: meta = {}, ...rest } = c.metadata ?? {};
  const id = typeof c.id === "string" && c.id ? c.id : newCellId();
  const common = {
    id,
    ...(meta.hidden ? { hidden: true } : {}),
    ...(meta.pinned ? { pinned: true } : {}),
    ...(Object.keys(rest).length ? { meta: rest } : {}),
  };
  if (meta.type === "prompt") {
    return {
      ...common,
      type: "prompt",
      source: meta.question ?? "",
      response: meta.response ?? "",
      mode: meta.mode === "answer" ? "answer" : "hint",
      usage: meta.usage,
      thinking: meta.thinking || undefined,
      outputs: [],
    };
  }
  if (c.cell_type === "code") {
    return {
      ...common,
      type: "code",
      lang: ["typescript", "python", "sql"].includes(meta.lang) ? meta.lang : defaultLang,
      source: joinSrc(c.source),
      outputs: (c.outputs ?? []).map(outputFromIpynb).filter(Boolean) as Output[],
      executionCount: c.execution_count ?? null,
    };
  }
  return { ...common, type: "markdown", source: joinSrc(c.source), outputs: [] };
}

/** Serialise to an .ipynb document (nbformat 4.5). */
export function toIpynb(nb: Notebook): any {
  const cells = nb.cells.map((c) => {
    const flags = { ...(c.hidden ? { hidden: true } : {}), ...(c.pinned ? { pinned: true } : {}) };
    const other = c.meta ?? {};
    if (c.type === "prompt") {
      const shown = `**🧑 Prompt (${c.mode ?? "hint"}):** ${c.source}\n\n---\n\n${c.response ?? ""}`;
      return {
        id: c.id,
        cell_type: "markdown",
        metadata: {
          ...other,
          polyglot: { type: "prompt", question: c.source, response: c.response ?? "", mode: c.mode ?? "hint", usage: c.usage, ...(c.thinking ? { thinking: c.thinking } : {}), ...flags },
        },
        source: splitSrc(shown),
      };
    }
    if (c.type === "code") {
      return {
        id: c.id,
        cell_type: "code",
        metadata: { ...other, polyglot: { lang: c.lang ?? "python", ...flags } },
        execution_count: c.executionCount ?? null,
        outputs: c.outputs.map(outputToIpynb),
        source: splitSrc(c.source),
      };
    }
    return { id: c.id, cell_type: "markdown", metadata: { ...other, polyglot: { ...flags } }, source: splitSrc(c.source) };
  });
  return {
    nbformat: 4,
    nbformat_minor: 5,
    metadata: {
      kernelspec: { name: "python3", display_name: "Python 3", language: "python" },
      language_info: { name: "python", file_extension: ".py" },
      ...nb.meta,
      polyglot: { version: 1 },
    },
    cells,
  };
}
