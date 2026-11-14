// Type-checks TypeScript cells with core's CellChecker (VS Code's built-in
// TypeScript support hides semantic errors in notebooks): one checker per
// notebook, each cell a virtual file in the notebook's folder, Deno's types and
// the share()/get() declarations as globals, and the cells' imports typed for
// real. Errors show as squiggles and are sent to the tutor with the cell.
//
// Imports: npm:, jsr:, node:, import-map names and URLs are resolved by Deno
// (core's DenoResolver) in the notebook's folder, so its deno.json applies. A
// specifier is "pending" (typed as any) until Deno answers; its types are then
// laid out in a types dir under the extension's storage and the notebook is
// checked again. A specifier Deno can't resolve gets "Cannot find module"
// with Deno's own message appended. The tsserver plugin is told where each
// notebook's modules.d.ts is, so completions and hover know the imports too.

import * as vscode from "vscode";
import { createHash } from "node:crypto";
import path from "node:path";
import ts from "typescript-6";
import { CellChecker, DenoResolver, NODE_TYPES, SHIMS_FILE, writeTypesDir, type CellDiagnostics, type Resolution } from "@polyglot-tutor/core";
import { HELPER_TYPES_SOURCE } from "@polyglot-tutor/core/browser";
import { notebookKey } from "../ts-plugin/notebook-key.ts";
import { NOTEBOOK_TYPE, cellId } from "./convert.ts";
import type { TsPluginConfig } from "./denoTypes.ts";

const HELPERS_FILE = "/polyglot/helpers.d.ts";
const DENO_FILE = "/polyglot/lib.deno.d.ts";
const DEBOUNCE_MS = 400;
/** How long a failed resolution is shown before Deno is asked again (the learner may have fixed deno.json). */
const RETRY_FAILED_MS = 60_000;
const NO_DENO = "Deno isn't set up, so imports can't be resolved. Run \"Polyglot Tutor: Set Up Runtimes\" or set polyglotTutor.denoPath.";
export const DIAGNOSTIC_SOURCE = "Polyglot Tutor (TypeScript)";
const CANNOT_FIND_MODULE = [2307, 2792];

export interface TypeCheckerOptions {
  /** Folder with TypeScript's lib.*.d.ts files (dist/ts-lib). */
  libDir: string;
  /** Where the types dirs go: <storage>/notebooks/<hash>. */
  storage: string;
  log: vscode.LogOutputChannel;
  /** The file a notebook's kernels belong to (untitled notebooks get one in extension storage). */
  fileOf: (nb: vscode.NotebookDocument) => string;
  /** The Deno executable, if any (may change with the settings). */
  deno: () => string | undefined;
  plugin: TsPluginConfig;
}

interface Resolved {
  resolution: Resolution;
  at: number;
}

/** One notebook's checker plus what Deno said about its imports. */
class NotebookProgram {
  readonly checker: CellChecker;
  readonly cwd: string;
  readonly typesDir: string;
  /** Cell id → cell, for the cells the checker was last updated with. */
  cells = new Map<string, vscode.NotebookCell>();
  resolved = new Map<string, Resolved>();
  pending = new Set<string>();
  private typesDirSet = false;

  constructor(libDir: string, file: string, storage: string) {
    this.cwd = path.dirname(file);
    this.typesDir = path.join(storage, "notebooks", createHash("sha256").update(file).digest("hex").slice(0, 16));
    this.checker = new CellChecker({ libDir, cwd: this.cwd });
  }

  /** Lay out the types known so far (pending ones as any) and make the checker look again. */
  writeTypes(): string {
    const ok = [...this.resolved.values()].map((r) => r.resolution).filter((r) => r.kind !== "error");
    writeTypesDir(this.typesDir, ok, [...this.pending], this.cwd);
    if (this.typesDirSet) this.checker.invalidateTypes();
    else {
      this.typesDirSet = true;
      this.checker.setTypesDir(this.typesDir);
    }
    return path.join(this.typesDir, SHIMS_FILE);
  }

  /** Deno's message for a specifier it couldn't resolve. */
  failure(specifier: string): string | undefined {
    const r = this.resolved.get(specifier)?.resolution;
    return r?.kind === "error" ? r.error : undefined;
  }

  /** Specifiers the cells import that still need Deno: never asked, or failed long enough ago to ask again. */
  unresolved(now: number): string[] {
    // @types/node is always wanted: Deno's globals include Node's (setTimeout), even in a notebook that imports nothing.
    return [...new Set([...this.checker.imports(), NODE_TYPES])].filter((s) => {
      if (this.pending.has(s)) return false;
      const r = this.resolved.get(s);
      return !r || (r.resolution.kind === "error" && now - r.at > RETRY_FAILED_MS);
    });
  }

  dispose() {
    this.checker.dispose();
  }
}

export class NotebookTypeChecker implements vscode.Disposable {
  private collection = vscode.languages.createDiagnosticCollection("polyglot-tutor-ts");
  private programs = new Map<string, NotebookProgram>();
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private globalFiles = new Map<string, string>([[HELPERS_FILE, HELPER_TYPES_SOURCE]]);
  private resolvers = new Map<string, DenoResolver>();
  private disposables: vscode.Disposable[] = [];
  /** Syntax errors per cell document (not published; sent to the tutor). */
  private syntax = new Map<string, string[]>();

  constructor(private opts: TypeCheckerOptions) {
    this.disposables.push(
      this.collection,
      vscode.workspace.onDidOpenNotebookDocument((nb) => this.schedule(nb, 0)),
      vscode.workspace.onDidChangeNotebookDocument((e) => this.schedule(e.notebook)),
      vscode.workspace.onDidChangeTextDocument((e) => {
        const nb = vscode.workspace.notebookDocuments.find((n) => n.getCells().some((c) => c.document === e.document));
        if (nb) this.schedule(nb);
      }),
      vscode.workspace.onDidCloseNotebookDocument((nb) => this.forget(nb)),
      vscode.workspace.onDidChangeConfiguration((e) => e.affectsConfiguration("deno") && this.recheckAll()),
    );
    this.recheckAll();
  }

  /** Deno's runtime types (from `deno types`) as a global declaration file. */
  setDenoTypes(source: string) {
    this.globalFiles.set(DENO_FILE, source);
    for (const p of this.programs.values()) p.checker.setGlobal(DENO_FILE, source);
    this.recheckAll();
  }

  /** The Python/Deno paths changed: forget what Deno said and ask again. */
  runtimesChanged() {
    this.resolvers.clear();
    for (const p of this.programs.values()) {
      p.resolved.clear();
      p.pending.clear();
    }
    this.recheckAll();
  }

  private ours = (nb: vscode.NotebookDocument) => nb.notebookType === NOTEBOOK_TYPE;

  /** When the Deno extension is enabled for this notebook, it reports errors itself. */
  private denoHandles(nb: vscode.NotebookDocument): boolean {
    if (!vscode.extensions.getExtension("denoland.vscode-deno")) return false;
    const cfg = vscode.workspace.getConfiguration("deno", nb.uri);
    if (cfg.get<boolean>("enable")) return true;
    const folder = vscode.workspace.getWorkspaceFolder(nb.uri);
    const paths = cfg.get<string[]>("enablePaths") ?? [];
    return !!folder && paths.some((p) => nb.uri.fsPath.startsWith(path.resolve(folder.uri.fsPath, p)));
  }

  private schedule(nb: vscode.NotebookDocument, delay = DEBOUNCE_MS) {
    if (!this.ours(nb)) return;
    const key = nb.uri.toString();
    clearTimeout(this.timers.get(key));
    this.timers.set(
      key,
      setTimeout(() => this.check(nb), delay),
    );
  }

  private recheckAll() {
    for (const nb of vscode.workspace.notebookDocuments) this.schedule(nb, 0);
  }

  private program(nb: vscode.NotebookDocument): NotebookProgram {
    const key = nb.uri.toString();
    let p = this.programs.get(key);
    if (!p) {
      p = new NotebookProgram(this.opts.libDir, this.opts.fileOf(nb), this.opts.storage);
      for (const [name, text] of this.globalFiles) p.checker.setGlobal(name, text);
      this.programs.set(key, p);
    }
    return p;
  }

  private resolver(deno: string): DenoResolver {
    let r = this.resolvers.get(deno);
    if (!r) this.resolvers.set(deno, (r = new DenoResolver(deno, { log: (m) => this.opts.log.info(`deno: ${m}`) })));
    return r;
  }

  /** Check a notebook now and publish its diagnostics. */
  check(nb: vscode.NotebookDocument) {
    const key = nb.uri.toString();
    clearTimeout(this.timers.get(key));
    this.timers.delete(key);
    for (const cell of nb.getCells()) {
      this.collection.delete(cell.document.uri);
      this.syntax.delete(cell.document.uri.toString());
    }
    if (this.denoHandles(nb)) return;
    const program = this.program(nb);
    try {
      program.cells.clear();
      const sources: { id: string; text: string }[] = [];
      for (const cell of nb.getCells()) {
        if (cell.kind !== vscode.NotebookCellKind.Code || cell.document.languageId !== "typescript") continue;
        const id = cellId(cell);
        program.cells.set(id, cell);
        sources.push({ id, text: cell.document.getText() });
      }
      program.checker.update(sources);
      this.syncImports(nb, program);
      for (const [id, diags] of program.checker.diagnostics()) {
        const cell = program.cells.get(id);
        if (cell) this.publish(cell, diags, program);
      }
    } catch (e) {
      this.opts.log.warn(`type check failed: ${e}`);
    }
  }

  /** New imports are marked pending (typed as any) and handed to Deno; its answer triggers another check. */
  private syncImports(nb: vscode.NotebookDocument, program: NotebookProgram) {
    const fresh = program.unresolved(Date.now());
    if (!fresh.length) return;
    for (const s of fresh) {
      program.pending.add(s);
      program.resolved.delete(s);
    }
    this.opts.plugin.setNotebook(notebookKey(nb.uri.path), program.writeTypes());
    void this.resolve(nb, program, fresh);
  }

  private async resolve(nb: vscode.NotebookDocument, program: NotebookProgram, specifiers: string[]) {
    const deno = this.opts.deno();
    const failed = (error: string): Resolution[] => specifiers.map((specifier) => ({ specifier, kind: "error", packages: [], modules: [], redirects: {}, error }));
    let results: Resolution[];
    if (!deno) results = failed(NO_DENO);
    else {
      try {
        results = await this.resolver(deno).resolveAll(program.cwd, specifiers);
      } catch (e) {
        results = failed(String(e instanceof Error ? e.message : e));
      }
    }
    if (this.programs.get(nb.uri.toString()) !== program) return; // closed meanwhile
    const now = Date.now();
    for (const r of results) {
      program.pending.delete(r.specifier);
      program.resolved.set(r.specifier, { resolution: r, at: now });
      if (r.kind === "error") this.opts.log.info(`${path.basename(program.cwd)}: could not resolve ${r.specifier}: ${r.error}`);
    }
    try {
      this.opts.plugin.setNotebook(notebookKey(nb.uri.path), program.writeTypes());
    } catch (e) {
      this.opts.log.warn(`could not write the types for ${nb.uri.fsPath}: ${e}`);
    }
    this.schedule(nb, 0);
  }

  private message(d: ts.Diagnostic, program: NotebookProgram): string {
    const text = ts.flattenDiagnosticMessageText(d.messageText, "\n");
    if (!CANNOT_FIND_MODULE.includes(d.code)) return text;
    const spec = /^Cannot find module '([^']+)'/.exec(text)?.[1];
    const error = spec === undefined ? undefined : program.failure(spec);
    return error === undefined ? text : `${text}\nDeno: ${error}`;
  }

  private publish(cell: vscode.NotebookCell, { syntactic, semantic }: CellDiagnostics, program: NotebookProgram) {
    const line = (d: ts.Diagnostic) => cell.document.positionAt(d.start ?? 0).line + 1;
    this.syntax.set(cell.document.uri.toString(), syntactic.map((d) => `line ${line(d)}: ${this.message(d, program)}`));
    this.collection.set(
      cell.document.uri,
      semantic.map((d) => {
        const start = cell.document.positionAt(d.start ?? 0);
        const end = cell.document.positionAt((d.start ?? 0) + (d.length ?? 0));
        const diag = new vscode.Diagnostic(new vscode.Range(start, end), this.message(d, program), vscode.DiagnosticSeverity.Error);
        diag.source = DIAGNOSTIC_SOURCE;
        diag.code = d.code;
        return diag;
      }),
    );
  }

  /** Current type errors of a cell as "line N: message" (checks first if an update is pending). */
  errorsFor(cell: vscode.NotebookCell): string[] {
    if (cell.document.languageId !== "typescript") return [];
    if (this.timers.has(cell.notebook.uri.toString())) this.check(cell.notebook);
    const semantic = (this.collection.get(cell.document.uri) ?? []).map((d) => `line ${d.range.start.line + 1}: ${d.message}`);
    return [...(this.syntax.get(cell.document.uri.toString()) ?? []), ...semantic];
  }

  private forget(nb: vscode.NotebookDocument) {
    const key = nb.uri.toString();
    clearTimeout(this.timers.get(key));
    this.timers.delete(key);
    this.programs.get(key)?.dispose();
    this.programs.delete(key);
    this.opts.plugin.removeNotebook(notebookKey(nb.uri.path));
    for (const cell of nb.getCells()) {
      this.collection.delete(cell.document.uri);
      this.syntax.delete(cell.document.uri.toString());
    }
  }

  dispose() {
    for (const t of this.timers.values()) clearTimeout(t);
    for (const p of this.programs.values()) p.dispose();
    for (const d of this.disposables) d.dispose();
  }
}

/** Offers "Ask the tutor about this type error" on our diagnostics. */
export class AskAboutTypeError implements vscode.CodeActionProvider {
  static readonly kinds = [vscode.CodeActionKind.QuickFix];

  provideCodeActions(doc: vscode.TextDocument, _range: vscode.Range, ctx: vscode.CodeActionContext): vscode.CodeAction[] {
    const ours = ctx.diagnostics.filter((d) => d.source === DIAGNOSTIC_SOURCE);
    if (!ours.length) return [];
    const cell = vscode.workspace.notebookDocuments.flatMap((n) => n.getCells()).find((c) => c.document === doc);
    if (!cell) return [];
    const action = new vscode.CodeAction("Ask the tutor about this type error", vscode.CodeActionKind.QuickFix);
    action.diagnostics = ours;
    action.command = { title: action.title, command: "polyglotTutor.askAboutError", arguments: [cell, "type"] };
    return [action];
  }
}
