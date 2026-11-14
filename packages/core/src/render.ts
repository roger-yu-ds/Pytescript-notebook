// Renders notebook cells as text for the tutor. Browser-safe (no Node imports).

import type { ContextCell, Output } from "./types.ts";

const ANSI = /\x1b\[[0-9;]*[A-Za-z]/g;
/** Strip ANSI colour codes (Deno and IPython tracebacks are coloured). */
export const plain = (s: string) => s.replace(ANSI, "");

/** Rough token estimate used for budgeting: ~4 characters per token. */
export const estTokens = (s: string) => Math.ceil(s.length / 4);
/** Rough per-chart token estimate for budgeting. */
export const IMAGE_TOKENS = 1_000;
/** Charts larger than this (base64 characters) are not sent. */
export const MAX_IMAGE_B64 = 1_500_000;

/** Keep the head (70%) and tail (30%) of long text. */
export function truncate(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const head = text.slice(0, Math.floor(limit * 0.7));
  const tail = text.slice(-Math.floor(limit * 0.3));
  return `${head}\n…[${text.length - head.length - tail.length} characters truncated]…\n${tail}`;
}

const firstLine = (s: string, n = 120) => {
  const line = s.trim().split("\n")[0] ?? "";
  return line.length > n ? line.slice(0, n - 1) + "…" : line;
};

function renderOutput(o: Output): string {
  switch (o.kind) {
    case "stream":
      return o.name === "stderr" ? `[stderr]\n${o.text}` : o.text;
    case "error":
      return `[error] ${o.ename}: ${o.evalue}\n${o.traceback.join("\n")}`;
    case "display": {
      const d = o.data;
      if (typeof d["text/plain"] === "string") return String(d["text/plain"]);
      if (d["image/png"] || d["image/svg+xml"]) return "";
      if (typeof d["text/markdown"] === "string") return String(d["text/markdown"]);
      if (typeof d["text/html"] === "string") return `[html]\n${String(d["text/html"])}`;
      return `[output: ${Object.keys(d).join(", ")}]`;
    }
  }
}

/** One-line stand-in for an output in a compact (older) cell. */
function stubOutput(o: Output): string {
  switch (o.kind) {
    case "stream": {
      const t = plain(o.text);
      const lines = t.trimEnd().split("\n").length;
      return `[${o.name}: ${lines} line${lines > 1 ? "s" : ""}] ${firstLine(t)}`;
    }
    case "error":
      return `[error] ${o.ename}: ${firstLine(plain(o.evalue))}`;
    case "display": {
      const d = o.data;
      if (d["image/png"] || d["image/svg+xml"]) return "[chart]";
      if (typeof d["text/html"] === "string" && /<table/i.test(String(d["text/html"]))) return `[table] ${firstLine(plain(String(d["text/plain"] ?? "")))}`;
      return `[output] ${firstLine(plain(String(d["text/plain"] ?? d["text/markdown"] ?? "")))}`;
    }
  }
}

/** PNG charts in a cell's outputs, as base64 without whitespace. */
export const pngs = (c: ContextCell) =>
  c.outputs.flatMap((o) => (o.kind === "display" && typeof o.data["image/png"] === "string" ? [String(o.data["image/png"]).replace(/\s/g, "")] : []));

export type RenderMode = "full" | "compact";

export function renderCell(c: ContextCell, mode: RenderMode = "full", outputLimit = 2000, imagesAttached = 0): string {
  const attrs = `index="${c.index}" type="${c.type}"${c.lang ? ` lang="${c.lang}"` : ""}`;
  const compact = mode === "compact" && !c.pinned;
  if (c.type === "prompt") {
    const answer = compact ? truncate(c.response ?? "", 600) : (c.response ?? "");
    return `<cell ${attrs}>\n<question>\n${c.source}\n</question>\n<answer>\n${answer}\n</answer>\n</cell>`;
  }
  if (c.type === "markdown") return `<cell ${attrs}>\n${c.source}\n</cell>`;
  const parts = [`<cell ${attrs}>`, `<source>\n${c.source}\n</source>`];
  if (c.typeErrors?.length) parts.push(`<type_errors>\n${c.typeErrors.join("\n")}\n</type_errors>`);
  if (!c.outputs.length) parts.push("<output>(not run or no output)</output>");
  else if (compact) parts.push(`<output_summary>\n${c.outputs.map(stubOutput).join("\n")}\n</output_summary>`);
  else {
    let out = plain(c.outputs.map(renderOutput).filter(Boolean).join("\n"));
    out = c.pinned ? out : truncate(out, outputLimit);
    const charts = pngs(c).length;
    if (charts) out += imagesAttached ? `\n[${charts} chart image(s) attached below]` : `\n[${charts} chart image(s) not attached]`;
    parts.push(`<output>\n${out}\n</output>`);
  }
  parts.push("</cell>");
  return parts.join("\n");
}

export const renderQuestion = (mode: string, question: string) => `<learner_question mode="${mode}">\n${question}\n</learner_question>`;
