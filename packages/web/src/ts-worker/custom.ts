// The web app's TypeScript worker: Monaco's TypeScriptWorker plus what the
// VS Code extension's checker (core's checker.ts) does for notebooks.
//
//   - A cell that is a module (it has an import or export) gets core's
//     export appendix added to its text and a companion declaration file
//     `file:///cells/<id>.globals.d.ts` (cell-links.ts), so its names reach
//     later cells. Diagnostics inside the appendix are dropped.
//   - What cells import (npm:, jsr:, node:, bare names, urls) is typed by the
//     extra libs under `file:///types/`: modules.d.ts (module-shims.ts, fetched
//     from the server) and the declaration files it re-exports: packages under
//     `file:///node_modules/<pkg>/…` (found by walking up from the cells and
//     from the shims alike, so a deno.json import-map name resolves too) and
//     remote modules under `file:///types/remote/<host>/…`. Those files are
//     not program roots; TypeScript finds them by resolution.
//   - "Cannot find module" for a specifier Deno could not resolve carries
//     Deno's error, which the main thread stores in the first line of
//     modules.d.ts (see types.ts).
//   - getImportSpecifiers(file) tells the main thread what a cell imports.
//   - An import that is a global already (`import process from "node:process"`)
//     can't be re-exposed: its alias is circular and would make every name of
//     the cell `any`. Before reporting diagnostics the worker heals such cells
//     the way core's CellChecker does: the offending names are left out of the
//     cell's appendix and companion (the global provides them anyway).
//
// Pure: Monaco's worker class and TypeScript are passed in (worker.ts).

import { COMPANION_SUFFIX, cellLinks, circularAliasNames, companionName, importSpecifiers, isCompanion, needsDeno, type CellLinks } from "@polyglot-tutor/core/browser";
import type tsType from "typescript-6";

type TS = typeof tsType;

export const CELL_DIR = "file:///cells/";
export const TYPES_DIR = "file:///types/";
/** The extra lib holding the module shims (module-shims.ts). */
export const SHIMS_LIB = `${TYPES_DIR}modules.d.ts`;
/** First line of the shims lib: a JSON object, specifier → Deno's error, for specifiers that could not be resolved. */
export const ERRORS_HEADER = "// deno-errors: ";

/** `file:///cells/<id>.ts` (a TypeScript cell's model), not its companion. */
export const isCellFile = (f: string) => f.startsWith(CELL_DIR) && f.endsWith(".ts") && !isCompanion(f);
const cellOf = (companion: string) => companion.slice(0, -COMPANION_SUFFIX.length) + ".ts";
/** Declaration files of imported modules (types.ts puts them here) are found by resolution, never roots. */
const isTypesSubfile = (f: string) => (f.startsWith(TYPES_DIR) && f !== SHIMS_LIB) || f.startsWith("file:///node_modules/");

/** Deno's resolution errors embedded in the shims lib. */
export function resolutionErrors(shims: string | undefined): Record<string, string> {
  if (!shims?.startsWith(ERRORS_HEADER)) return {};
  try {
    const parsed = JSON.parse(shims.slice(ERRORS_HEADER.length, shims.indexOf("\n") < 0 ? undefined : shims.indexOf("\n")));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

const CANNOT_FIND = /^Cannot find module '([^']+)'/;

/** "Cannot find module 'x' …" with Deno's reason appended when Deno failed on x. */
export function withDenoError(message: string, errors: Record<string, string>): string {
  const spec = CANNOT_FIND.exec(message)?.[1];
  const error = spec && errors[spec];
  return error ? `${message}\nDeno: ${error}` : message;
}

interface Diag {
  start?: number;
  code: number;
  messageText: string | { messageText: string };
}

interface LinksEntry {
  /** Model version plus the number of excluded names: either change rebuilds the links. */
  key: string;
  links: CellLinks | null;
}

interface Exclusions {
  /** The model version the exclusions were found for; a changed cell starts afresh. */
  version: number;
  names: Set<string>;
}

interface MirrorModel {
  version: number;
  getValue(): string;
}

/** Monaco's TypeScriptWorker, as far as the subclass uses it. */
interface BaseWorker {
  _extraLibs: Record<string, { content: string; version: number }>;
  _getModel(fileName: string): MirrorModel | null;
  _getScriptText(fileName: string): string | undefined;
  _languageService: { getSemanticDiagnostics(fileName: string): readonly { code: number; start?: number }[] };
  getScriptFileNames(): string[];
  getScriptVersion(fileName: string): string;
  getSyntacticDiagnostics(fileName: string): Promise<Diag[]>;
  getSemanticDiagnostics(fileName: string): Promise<Diag[]>;
  getSuggestionDiagnostics(fileName: string): Promise<Diag[]>;
}

type BaseCtor = new (...args: any[]) => BaseWorker;

export function polyglotWorker<B extends BaseCtor>(Base: B, ts: TS) {
  return class PolyglotTypeScriptWorker extends Base {
    private _links = new Map<string, LinksEntry>();
    /** Per cell file: names the companion must not re-expose (see _heal). */
    private _excluded = new Map<string, Exclusions>();

    /** The names excluded for a cell at its current version (exclusions of an older version are dropped). */
    private _exclusions(cellFile: string, version: number): Set<string> | undefined {
      const e = this._excluded.get(cellFile);
      if (!e) return undefined;
      if (e.version !== version) {
        this._excluded.delete(cellFile);
        return undefined;
      }
      return e.names;
    }

    /** Cross-cell links of a cell file, computed once per model version and set of exclusions. */
    private _linksFor(cellFile: string): CellLinks | null {
      const model = this._getModel(cellFile);
      if (!model) return null;
      const exclude = this._exclusions(cellFile, model.version);
      const key = `${model.version}:${exclude?.size ?? 0}`;
      const hit = this._links.get(cellFile);
      if (hit && hit.key === key) return hit.links;
      const links = cellLinks(ts, cellFile, model.getValue(), { exclude });
      this._links.set(cellFile, { key, links });
      return links;
    }

    /**
     * Drop names the checker rejects as circular aliases from their cells' companions, so the cells'
     * other names keep their types. Returns true when something changed; call again until it doesn't.
     * Never called from a host callback (it asks the language service, which syncs the host).
     */
    private _heal(): boolean {
      let changed = false;
      for (const cellFile of super.getScriptFileNames().filter(isCellFile)) {
        const links = this._linksFor(cellFile);
        const model = this._getModel(cellFile);
        if (!links || !model) continue;
        const found = circularAliasNames(
          { text: links.companion, diagnostics: this._languageService.getSemanticDiagnostics(companionName(cellFile)) },
          { text: model.getValue() + links.appendix, diagnostics: this._languageService.getSemanticDiagnostics(cellFile) },
        );
        const current = this._exclusions(cellFile, model.version) ?? new Set<string>();
        const fresh = [...found].filter((n) => !current.has(n));
        if (!fresh.length) continue;
        for (const n of fresh) current.add(n);
        this._excluded.set(cellFile, { version: model.version, names: current });
        changed = true;
      }
      return changed;
    }

    override getScriptFileNames(): string[] {
      const names = super.getScriptFileNames().filter((n) => !isTypesSubfile(n));
      const companions = names.filter((n) => isCellFile(n) && this._linksFor(n)).map(companionName);
      return [...names, ...companions];
    }

    /** A cell's version (its companion's too) also changes when its exclusions do, or TypeScript keeps the stale appendix. */
    override getScriptVersion(fileName: string): string {
      const cellFile = fileName.startsWith(CELL_DIR) && isCompanion(fileName) ? cellOf(fileName) : fileName;
      const base = super.getScriptVersion(cellFile);
      if (!isCellFile(cellFile)) return base;
      const model = this._getModel(cellFile);
      const excluded = model ? (this._exclusions(cellFile, model.version)?.size ?? 0) : 0;
      return excluded ? `${base}:${excluded}` : base;
    }

    override _getScriptText(fileName: string): string | undefined {
      if (fileName.startsWith(CELL_DIR) && isCompanion(fileName)) return this._linksFor(cellOf(fileName))?.companion;
      const text = super._getScriptText(fileName);
      if (text !== undefined && isCellFile(fileName)) {
        const links = this._linksFor(fileName);
        if (links) return text + links.appendix;
      }
      return text;
    }

    /** Only diagnostics inside the cell's own text; "Cannot find module" gets Deno's reason. */
    private _trim(fileName: string, diags: Diag[]): Diag[] {
      if (!isCellFile(fileName)) return diags;
      const length = this._getModel(fileName)?.getValue().length ?? Infinity;
      const errors = resolutionErrors(this._extraLibs[SHIMS_LIB]?.content);
      const out: Diag[] = [];
      for (const d of diags) {
        if ((d.start ?? 0) >= length) continue;
        if ((d.code === 2307 || d.code === 2792) && typeof d.messageText === "string") d.messageText = withDenoError(d.messageText, errors);
        out.push(d);
      }
      return out;
    }

    override async getSyntacticDiagnostics(fileName: string): Promise<Diag[]> {
      return this._trim(fileName, await super.getSyntacticDiagnostics(fileName));
    }

    override async getSemanticDiagnostics(fileName: string): Promise<Diag[]> {
      for (let i = 0; i < 3 && this._heal(); i++); // a healed companion can reveal the next clash
      return this._trim(fileName, await super.getSemanticDiagnostics(fileName));
    }

    override async getSuggestionDiagnostics(fileName: string): Promise<Diag[]> {
      return this._trim(fileName, await super.getSuggestionDiagnostics(fileName));
    }

    /** Specifiers a cell imports that TypeScript can't resolve alone (npm:, jsr:, node:, bare names, urls). */
    async getImportSpecifiers(fileName: string): Promise<string[]> {
      const model = this._getModel(fileName);
      if (!model || !isCellFile(fileName)) return [];
      return importSpecifiers(ts, fileName, model.getValue()).filter(needsDeno);
    }
  };
}
