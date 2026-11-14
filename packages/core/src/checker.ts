// A TypeScript language service over the cells of one notebook, shared by the
// VS Code extension and the headless runner (the web app's Monaco worker
// mirrors it in the browser).
//
// Each cell is a virtual file in the notebook's folder, so relative imports
// find real files. Script cells' declarations are global; a module cell's
// names reach later cells through its companion (cell-links.ts); npm:, jsr:,
// node: and import-map specifiers are declared by a types dir
// (deno-resolver.ts); Deno's runtime types and share()/get() are globals.

import { existsSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import ts from "typescript-6";
import { cellLinks, circularAliasNames, companionName, importSpecifiers } from "./cell-links.ts";
import { SHIMS_FILE, needsDeno, parseSpecifier } from "./module-shims.ts";
import { TS_IGNORED_CODES } from "./typescript.ts";

export interface CellSource {
  id: string;
  text: string;
}

export interface CellDiagnostics {
  syntactic: ts.Diagnostic[];
  semantic: ts.Diagnostic[];
}

export interface CheckerOptions {
  /** Folder with TypeScript's lib.*.d.ts files (see defaultLibDir). */
  libDir: string;
  /** The notebook's folder. */
  cwd: string;
}

/** Compiler options for cells: Deno-like, strict, no emit. */
export const CELL_COMPILER_OPTIONS: ts.CompilerOptions = {
  target: ts.ScriptTarget.ESNext,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  lib: ["lib.esnext.d.ts"],
  strict: true,
  noEmit: true,
  allowImportingTsExtensions: true,
  resolveJsonModule: true,
  preserveSymlinks: true, // node_modules in the types dir links into Deno's cache; resolve dependencies from the links, not the cache
  skipLibCheck: true,
  types: [],
};

/** TypeScript's bundled lib files (for Node callers; the extension ships its own copy). */
export function defaultLibDir(): string {
  const require = createRequire(import.meta.url);
  return path.join(path.dirname(require.resolve("typescript-6/package.json")), "lib");
}

export const CELL_PREFIX = ".polyglot-cell-";
const norm = (p: string) => p.split(path.sep).join("/");

/** The virtual file of a cell: `<notebook folder>/.polyglot-cell-<id>.ts`. */
export const cellFileName = (cwd: string, id: string) => norm(path.join(cwd, `${CELL_PREFIX}${id.replace(/[^\w-]/g, "_")}.ts`));

interface Entry {
  text: string;
  version: number;
}

interface CellEntry extends Entry {
  id: string;
  /** Length of the cell's own text (the appendix follows it). */
  length: number;
}

export class CellChecker {
  private cells = new Map<string, CellEntry>();
  private companions = new Map<string, Entry>();
  private globals = new Map<string, Entry>();
  /** Per cell file: names the companion must not re-expose (see heal). */
  private excluded = new Map<string, Set<string>>();
  /** Per cell file: names a global of the same name hides (see healHidden); later cells import them instead. */
  private hidden = new Map<string, Set<string>>();
  /** Cell files in notebook order. */
  private order: string[] = [];
  private typesDir: string | undefined;
  private invalidated = false;
  private readonly host: ts.LanguageServiceHost;
  private readonly resolutions: ts.ModuleResolutionCache;
  readonly cwd: string;
  readonly service: ts.LanguageService;

  constructor(opts: CheckerOptions) {
    this.cwd = norm(path.resolve(opts.cwd));
    const libDir = norm(opts.libDir);
    const virtual = (f: string) => this.cells.get(f) ?? this.companions.get(f) ?? this.globals.get(f);
    this.resolutions = ts.createModuleResolutionCache(this.cwd, (f) => (ts.sys.useCaseSensitiveFileNames ? f : f.toLowerCase()), CELL_COMPILER_OPTIONS);
    const host: ts.LanguageServiceHost & { hasInvalidatedResolutions?: () => boolean } = {
      getCompilationSettings: () => CELL_COMPILER_OPTIONS,
      getScriptFileNames: () => [...this.cells.keys(), ...this.companions.keys(), ...this.globals.keys(), ...(this.typesDir ? [`${this.typesDir}/${SHIMS_FILE}`] : [])],
      getScriptVersion: (f) => {
        const v = virtual(f);
        if (v) return String(v.version);
        try {
          return String(statSync(f).mtimeMs);
        } catch {
          return "0";
        }
      },
      getScriptSnapshot: (f) => {
        const text = this.read(f);
        return text === undefined ? undefined : ts.ScriptSnapshot.fromString(text);
      },
      getCurrentDirectory: () => this.cwd,
      getDefaultLibFileName: () => `${libDir}/lib.esnext.d.ts`,
      fileExists: (f) => !!virtual(f) || (!f.includes(CELL_PREFIX) && existsSync(f)),
      readFile: (f) => this.read(f),
      directoryExists: (d) => d.startsWith("/polyglot") || ts.sys.directoryExists(d),
      getDirectories: (d) => {
        try {
          return ts.sys.getDirectories(d);
        } catch {
          return [];
        }
      },
      realpath: (f) => (virtual(f) ? f : (ts.sys.realpath?.(f) ?? f)),
      useCaseSensitiveFileNames: () => ts.sys.useCaseSensitiveFileNames,
      hasInvalidatedResolutions: () => this.invalidated,
      resolveModuleNameLiterals: (literals, containingFile, redirected, options) => literals.map((l) => this.resolveModule(l.text, containingFile, options, redirected)),
    };
    this.host = host;
    this.service = ts.createLanguageService(host, ts.createDocumentRegistry(ts.sys.useCaseSensitiveFileNames, this.cwd));
  }

  /**
   * Module resolution: a bare name a cell imports (an import-map entry like
   * "zod", or "zod/v4") lives in the types dir's node_modules, not next to the
   * notebook, so it is resolved as if the shims file imported it. The same goes
   * for the notebook's own modules (a `../src/support/x.ts` a cell imports):
   * Deno resolves their bare names through the same import map, so they must
   * see the same copy of a package. Resolved from their own folder they would
   * find a project's npm-installed node_modules instead, a second copy whose
   * classes with #private fields or unique-symbol brands don't match the
   * cell's. Package files (anything under a node_modules folder or the types
   * dir) resolve from where they are written.
   */
  private resolveModule(name: string, containingFile: string, options: ts.CompilerOptions, redirected?: ts.ResolvedProjectReference): ts.ResolvedModuleWithFailedLookupLocations {
    if (this.typesDir && parseSpecifier(name).scheme === "bare" && this.viaTypesDir(containingFile)) {
      const r = ts.resolveModuleName(name, `${this.typesDir}/${SHIMS_FILE}`, options, this.host, this.resolutions, redirected);
      if (r.resolvedModule) return r;
    }
    return ts.resolveModuleName(name, containingFile, options, this.host, this.resolutions, redirected);
  }

  /** A cell, or a source file of the notebook's own (not a package's): its bare imports go through the types dir. */
  private viaTypesDir(file: string): boolean {
    if (file.includes(CELL_PREFIX)) return true;
    const f = norm(file);
    return !f.includes("/node_modules/") && !(this.typesDir && f.startsWith(`${this.typesDir}/`));
  }

  private read(f: string): string | undefined {
    const v = this.cells.get(f) ?? this.companions.get(f) ?? this.globals.get(f);
    if (v) return v.text;
    if (f.includes(CELL_PREFIX)) return undefined;
    try {
      return readFileSync(f, "utf8");
    } catch {
      return undefined;
    }
  }

  /** A global declaration file (Deno's types, the share()/get() helpers). */
  setGlobal(name: string, text: string) {
    const prev = this.globals.get(name);
    if (prev?.text !== text) this.globals.set(name, { text, version: (prev?.version ?? 0) + 1 });
  }

  /** The folder holding modules.d.ts and node_modules for this notebook's imports (built by writeTypesDir). */
  setTypesDir(dir: string | undefined) {
    this.typesDir = dir === undefined ? undefined : norm(path.resolve(dir));
    this.invalidateTypes();
  }

  /** Call after the types dir changed on disk, so imports are resolved again. */
  invalidateTypes() {
    this.invalidated = true;
    this.resolutions.clear();
  }

  /** Sync the virtual files with the notebook's TypeScript cells, in order. */
  update(cells: CellSource[]) {
    const seen = new Set<string>();
    this.order = cells.map((c) => cellFileName(this.cwd, c.id));
    for (const cell of cells) {
      const name = cellFileName(this.cwd, cell.id);
      seen.add(name);
      const prev = this.cells.get(name);
      if (prev && prev.text.slice(0, prev.length) !== cell.text) {
        this.excluded.delete(name); // a changed cell starts afresh
        this.hidden.delete(name);
      }
      this.link(name, cell.id, cell.text);
    }
    for (const name of [...this.cells.keys()]) {
      if (!seen.has(name)) {
        this.cells.delete(name);
        this.companions.delete(companionName(name));
        this.excluded.delete(name);
        this.hidden.delete(name);
      }
    }
  }

  /** Hidden names of the cells before `name` → the cell module that last declared each. */
  private inherited(name: string): Map<string, string> {
    const out = new Map<string, string>();
    for (const earlier of this.order) {
      if (earlier === name) break;
      const base = `./${earlier.slice(earlier.lastIndexOf("/") + 1).replace(/\.ts$/, "")}`;
      for (const n of this.hidden.get(earlier) ?? []) out.set(n, base);
    }
    return out;
  }

  /** (Re)build a cell's virtual file and companion from its text and current exclusions. */
  private link(name: string, id: string, source: string) {
    const links = cellLinks(ts, name, source, { exclude: this.excluded.get(name), hidden: this.hidden.get(name), inherited: this.inherited(name) });
    const text = source + (links?.appendix ?? "");
    const prev = this.cells.get(name);
    if (!prev) this.cells.set(name, { id, text, version: 1, length: source.length });
    else if (prev.text !== text || prev.id !== id) this.cells.set(name, { id, text, version: prev.version + 1, length: source.length });
    const cname = companionName(name);
    if (links) {
      const old = this.companions.get(cname);
      if (old?.text !== links.companion) this.companions.set(cname, { text: links.companion, version: (old?.version ?? 0) + 1 });
    } else this.companions.delete(cname);
  }

  /**
   * Drop names the checker rejects as circular aliases (an import that is a global already, like
   * `import process from "node:process"`) from their cells' companions, so the other names keep
   * their types. Returns true when something changed; call again until it returns false.
   */
  heal(): boolean {
    let changed = false;
    for (const [name, cell] of this.cells) {
      const cname = companionName(name);
      const companion = this.companions.get(cname);
      if (!companion) continue;
      const found = circularAliasNames(
        { text: companion.text, diagnostics: this.service.getSemanticDiagnostics(cname) },
        { text: cell.text, diagnostics: this.service.getSemanticDiagnostics(name) },
      );
      const exclude = this.excluded.get(name) ?? new Set<string>();
      const fresh = [...found].filter((n) => !exclude.has(n));
      if (!fresh.length) continue;
      for (const n of fresh) exclude.add(n);
      this.excluded.set(name, exclude);
      this.link(name, cell.id, cell.text.slice(0, cell.length));
      changed = true;
    }
    return changed;
  }

  /**
   * Find names a cell re-exposes that are also globals declared outside the cells (Deno's `Worker`,
   * `Request`, `Event`): the companion's alias loses to the global without a diagnostic. They are kept
   * out of the companion and imported by every later cell instead. Returns true when something changed.
   */
  healHidden(): boolean {
    const tc = this.service.getProgram()?.getTypeChecker();
    if (!tc) return false;
    const virtualCell = (f: string) => f.includes(CELL_PREFIX);
    const meaning = ts.SymbolFlags.Value | ts.SymbolFlags.Type | ts.SymbolFlags.Namespace;
    let changed = false;
    for (const name of this.order) {
      const cell = this.cells.get(name);
      if (!cell || !this.companions.has(companionName(name))) continue;
      const links = cellLinks(ts, name, cell.text.slice(0, cell.length), { exclude: this.excluded.get(name) });
      const hidden = this.hidden.get(name) ?? new Set<string>();
      for (const n of links?.names ?? []) {
        if (n.assignable || hidden.has(n.name)) continue; // an import binding can't be assigned: let/var stay global
        const sym = tc.resolveName(n.name, undefined, meaning, false);
        if (sym?.declarations?.some((d) => !virtualCell(d.getSourceFile().fileName))) {
          hidden.add(n.name);
          changed = true;
        }
      }
      if (hidden.size) this.hidden.set(name, hidden);
    }
    if (changed) for (const name of this.order) {
      const cell = this.cells.get(name);
      if (cell) this.link(name, cell.id, cell.text.slice(0, cell.length));
    }
    return changed;
  }

  /** Specifiers the cells import that TypeScript can't resolve alone (npm:, jsr:, node:, bare names, urls), first seen first. */
  imports(): string[] {
    const out = new Set<string>();
    for (const [name, cell] of this.cells) for (const s of importSpecifiers(ts, name, cell.text)) if (needsDeno(s)) out.add(s);
    return [...out];
  }

  /** Errors per cell id. Syntax errors are reported apart (editors show those themselves); semantic ones only when the syntax is fine. */
  diagnostics(): Map<string, CellDiagnostics> {
    for (let i = 0; i < 3 && this.heal(); i++); // a healed companion can reveal the next clash
    for (let i = 0; i < 3 && this.healHidden(); i++); // a name hidden by a global: later cells import it
    const out = new Map<string, CellDiagnostics>();
    for (const [name, cell] of this.cells) {
      const relevant = (d: ts.Diagnostic) => d.category === ts.DiagnosticCategory.Error && !TS_IGNORED_CODES.includes(d.code) && (d.start ?? 0) < cell.length;
      const syntactic = this.service.getSyntacticDiagnostics(name).filter(relevant);
      out.set(cell.id, { syntactic, semantic: syntactic.length ? [] : this.service.getSemanticDiagnostics(name).filter(relevant) });
    }
    this.invalidated = false;
    return out;
  }

  dispose() {
    this.service.dispose();
  }
}

/** A diagnostic as "line N: message" (1-based line within the cell). */
export function formatDiagnostic(d: ts.Diagnostic): string {
  const line = d.file && d.start !== undefined ? d.file.getLineAndCharacterOfPosition(d.start).line + 1 : 1;
  return `line ${line}: ${ts.flattenDiagnosticMessageText(d.messageText, "\n")}`;
}
