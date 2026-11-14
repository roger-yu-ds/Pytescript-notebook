// Monaco setup: bundled locally (no CDN), Deno-flavoured TypeScript checking.
//
// Every TypeScript cell is its own model (file:///cells/<id>.ts). Cells without
// imports are "scripts", so their top-level declarations are global and later
// cells see them — mirroring how Deno's kernel keeps state between cells. A
// cell with an import is a module; our worker (ts-worker/) makes its names
// global too, and types what it imports with declarations fetched from the
// server (types.ts).

import * as monaco from "monaco-editor";
import { loader } from "@monaco-editor/react";
import { HELPER_TYPES_SOURCE, TS_IGNORED_CODES as IGNORED_CODES, flattenMessage } from "@polyglot-tutor/core/browser";
import EditorWorker from "monaco-editor/editor/editor.worker?worker";
import TsWorker from "./ts-worker/worker.ts?worker";

self.MonacoEnvironment = {
  getWorker(_id: string, label: string) {
    if (label === "typescript" || label === "javascript") return new TsWorker();
    return new EditorWorker();
  },
};

const ts = monaco.typescript;

/** Like core's CELL_COMPILER_OPTIONS. Bundler resolution (TypeScript's 100; Monaco's enum stops at NodeJs) finds the types dir's node_modules. */
ts.typescriptDefaults.setCompilerOptions({
  target: ts.ScriptTarget.ESNext,
  module: ts.ModuleKind.ESNext,
  moduleResolution: 100 as unknown as monaco.typescript.ModuleResolutionKind,
  lib: ["esnext"],
  strict: true,
  allowNonTsExtensions: true,
  allowImportingTsExtensions: true,
  resolveJsonModule: true,
  skipLibCheck: true,
  types: [],
  noEmit: true,
});

ts.typescriptDefaults.setDiagnosticsOptions({
  noSemanticValidation: false,
  noSyntaxValidation: false,
  diagnosticCodesToIgnore: [...IGNORED_CODES],
});

ts.typescriptDefaults.setEagerModelSync(true);

/** Add or replace a global declaration file. Unchanged content is a no-op; changes are coalesced into one re-check. */
export function setLib(path: string, content: string) {
  ts.typescriptDefaults.addExtraLib(content, path);
}

fetch("/api/deno-types")
  .then((r) => (r.ok ? r.text() : Promise.reject(new Error(String(r.status)))))
  .then((src) => setLib("file:///lib.deno.d.ts", src))
  .catch((e) => console.warn("Deno types unavailable; TypeScript checking will be less accurate.", e));

// Types for the share()/get() helpers the backend defines in every Deno kernel.
setLib("file:///polyglot-helpers.d.ts", HELPER_TYPES_SOURCE);

loader.config({ monaco });

export { monaco };

export function cellUri(id: string, lang: string) {
  const ext = { typescript: "ts", python: "py", sql: "sql" }[lang] ?? "md";
  return monaco.Uri.parse(`file:///cells/${id}.${ext}`);
}

/** The TypeScript worker, with our extra methods (ts-worker/custom.ts), synced with the given models. */
export async function tsWorker(...uris: monaco.Uri[]) {
  const worker = await (await ts.getTypeScriptWorker())(...uris);
  return worker as typeof worker & { getImportSpecifiers(fileName: string): Promise<string[]> };
}

/**
 * Type-checker errors for a TypeScript cell, as "line N: message" strings.
 * Asks the TS worker directly so the result is current even if the editor's
 * markers haven't refreshed yet.
 */
export async function typeErrors(id: string): Promise<string[]> {
  const uri = cellUri(id, "typescript");
  const model = monaco.editor.getModel(uri);
  if (!model) return [];
  try {
    const worker = await tsWorker(uri);
    const file = uri.toString();
    const diags = [...(await worker.getSyntacticDiagnostics(file)), ...(await worker.getSemanticDiagnostics(file))];
    return diags
      .filter((d) => d.category === 1 && !IGNORED_CODES.includes(d.code))
      .map((d) => `line ${model.getPositionAt(d.start ?? 0).lineNumber}: ${flattenMessage(d.messageText as any)}`);
  } catch {
    return [];
  }
}

/** Current error markers of a TypeScript cell (what the squiggles show). */
export function cellMarkers(id: string): string[] {
  return monaco.editor
    .getModelMarkers({ resource: cellUri(id, "typescript") })
    .filter((m) => m.severity === monaco.MarkerSeverity.Error)
    .map((m) => m.message);
}

/** Dispose cell models that don't belong to the current notebook. */
export function disposeModelsExcept(ids: Set<string>) {
  for (const m of monaco.editor.getModels()) {
    const match = /^\/cells\/([^.]+)\./.exec(m.uri.path);
    if (match && !ids.has(match[1])) m.dispose();
  }
}

// Handy for debugging in the browser console (and for UI tests).
if (import.meta.env.DEV) (globalThis as any).monaco = monaco;
