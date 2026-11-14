// Types for what TypeScript cells import (npm:, jsr:, node:, import-map names,
// urls). The server resolves a specifier with Deno (GET /api/types/:nb) and
// returns the module shims (modules.d.ts) for everything resolved so far plus
// the declaration files; they become extra libs under file:///types/, where
// the worker (ts-worker/custom.ts) resolves them.
//
// While a specifier is being resolved it is declared as `any` (a shorthand
// ambient module), so nothing is flagged prematurely. A specifier Deno can't
// resolve stays undeclared, so the cell gets "Cannot find module", and Deno's
// error travels to the worker in the first line of modules.d.ts.

import { monaco, setLib, tsWorker } from "./monaco.ts";
import { ERRORS_HEADER, SHIMS_LIB, TYPES_DIR } from "./ts-worker/custom.ts";

export interface TypesResponse {
  status: "ok" | "error";
  /** modules.d.ts for every specifier the server has resolved for this notebook. */
  shims: string;
  /** Declaration files, as paths under the types dir → text. */
  files: Record<string, string>;
  error?: string;
}

const DEBOUNCE_MS = 400;
/** A failed specifier is asked again after this long (Deno may have been fixed, or the network). */
const RETRY_MS = 60_000;

/**
 * Where a types-dir file lives in the browser. Packages go to the root
 * node_modules, which TypeScript finds by walking up from both the cells
 * (a bare name from a deno.json import map) and the shims (their re-exports);
 * remote modules stay under types/, where the shims refer to them.
 */
export const libPath = (file: string) => (file.startsWith("node_modules/") ? `file:///${file}` : TYPES_DIR + file);

const isCellModel = (m: monaco.editor.ITextModel) => m.getLanguageId() === "typescript" && /^\/cells\/[^/]+\.ts$/.test(m.uri.path);

class ImportTypes {
  private notebook = "";
  private known = new Set<string>();
  private pending = new Set<string>();
  private failed = new Map<string, { error: string; at: number }>();
  private shims = "";
  private timer: ReturnType<typeof setTimeout> | null = null;
  private listeners = new Set<() => void>();

  constructor() {
    monaco.editor.onDidCreateModel((m) => {
      if (!isCellModel(m)) return;
      m.onDidChangeContent(() => this.schedule());
      this.schedule(0);
    });
  }

  /** Start tracking a notebook (state is per notebook: the server's shims are). */
  activate(notebook: string) {
    if (this.notebook === notebook) return;
    this.notebook = notebook;
    this.known.clear();
    this.pending.clear();
    this.failed.clear();
    this.shims = "";
    this.apply();
    this.schedule(0);
  }

  /** Called after types arrived or a resolution failed (the cells' errors may have changed). */
  onChange(l: () => void) {
    this.listeners.add(l);
    return () => void this.listeners.delete(l);
  }

  /** Deno's error for a specifier that could not be resolved. */
  errorFor(specifier: string): string | undefined {
    return this.failed.get(specifier)?.error;
  }

  get resolving(): string[] {
    return [...this.pending];
  }

  private schedule(ms = DEBOUNCE_MS) {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.scan().catch((e) => console.warn("import scan failed", e)), ms);
  }

  /** Ask the worker what every TypeScript cell imports and resolve what is new. */
  private async scan() {
    if (!this.notebook) return;
    const models = monaco.editor.getModels().filter(isCellModel);
    if (!models.length) return;
    const worker = await tsWorker(...models.map((m) => m.uri));
    const specs = new Set<string>();
    for (const m of models) if (!m.isDisposed()) for (const s of await worker.getImportSpecifiers(m.uri.toString())) specs.add(s);
    for (const s of specs) {
      if (this.known.has(s) || this.pending.has(s)) continue;
      const f = this.failed.get(s);
      if (f && Date.now() - f.at < RETRY_MS) continue;
      void this.request(s);
    }
  }

  private async request(specifier: string) {
    const notebook = this.notebook;
    this.pending.add(specifier);
    this.failed.delete(specifier);
    this.apply();
    try {
      const r = await fetch(`/api/types/${encodeURIComponent(notebook)}?specifier=${encodeURIComponent(specifier)}`);
      const body = (await r.json().catch(() => ({}))) as Partial<TypesResponse>;
      if (notebook !== this.notebook) return;
      if (r.ok && body.status === "ok" && typeof body.shims === "string") {
        this.known.add(specifier);
        this.shims = body.shims;
        for (const [file, text] of Object.entries(body.files ?? {})) setLib(libPath(file), text);
      } else {
        this.failed.set(specifier, { error: body.error ?? `HTTP ${r.status}`, at: Date.now() });
      }
    } catch (e) {
      if (notebook !== this.notebook) return;
      this.failed.set(specifier, { error: String((e as Error).message ?? e), at: Date.now() });
    } finally {
      if (notebook === this.notebook) {
        this.pending.delete(specifier);
        this.apply();
        for (const l of this.listeners) l();
      }
    }
  }

  /** Write modules.d.ts: Deno's errors, the server's shims, and `any` for what is still resolving. */
  private apply() {
    const errors = Object.fromEntries([...this.failed].map(([s, f]) => [s, f.error]));
    const pending = [...this.pending].map((p) => `declare module ${JSON.stringify(p)};\n`).join("");
    setLib(SHIMS_LIB, `${ERRORS_HEADER}${JSON.stringify(errors)}\n${this.shims}${pending}`);
  }
}

export const importTypes = new ImportTypes();

if (import.meta.env.DEV) (globalThis as any).importTypes = importTypes;
