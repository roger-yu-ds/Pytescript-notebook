// tsserver plugin for VS Code's built-in TypeScript support, so completions,
// hover and go-to-definition in notebook cells know what the cells know:
//
//   - the global declarations the extension writes (Deno's runtime types and
//     share()/get()), through `typesFile`;
//   - each notebook's modules.d.ts (types for what its cells import, see
//     core's deno-resolver.ts), through `notebooks`: notebook key → file;
//   - the names a module cell declares (a cell with an import or export keeps
//     its names private, see core's cell-links.ts): the cell's text gets an
//     export appendix and a virtual companion file next to it re-exposes every
//     name globally. A name that is a global already (`import process from
//     "node:process"`) would make that alias circular and every other name
//     `any`; heal() drops such names from the companion, as core's checker does.
//
// The extension sends the configuration with configurePlugin. tsserver makes
// one plugin instance per project: projects created after the configuration
// arrives get it as `info.config` in create(), earlier ones through
// onConfigurationChanged. Module-level state covers both.
//
// tsserver passes its own `typescript` module to init(); nothing here imports
// TypeScript at runtime (build.mjs leaves it external).

import type tsModule from "typescript-6";
import { CIRCULAR_ALIAS, COMPANION_SUFFIX, cellLinks, circularAliasNames, companionName, isCompanion, parseSpecifier } from "@polyglot-tutor/core/browser";
import { isCellFile, notebookKey, notebookOfCell } from "./notebook-key.ts";

type TS = typeof tsModule;

// (Not exported: an ESM export would make the bundler ignore `export =` below.)
interface PluginConfig {
  /** The global declarations file (helpers + Deno's types). */
  typesFile?: string;
  /** Notebook key (see notebook-key.ts) → that notebook's modules.d.ts. */
  notebooks?: Record<string, string>;
}

interface Links {
  /** Length of the cell's own text; the appendix follows it. */
  length: number;
  appendix: string;
  companion: string;
}

interface Located {
  fileName: string;
  textSpan: tsModule.TextSpan;
}

let config: PluginConfig = {};
const projects = new Set<{ markAsDirty?: () => void }>();

const normalizeConfig = (c: PluginConfig | undefined): PluginConfig => {
  const out: PluginConfig = {};
  if (c && typeof c.typesFile === "string") out.typesFile = c.typesFile;
  if (c?.notebooks && typeof c.notebooks === "object") {
    out.notebooks = {};
    for (const [k, v] of Object.entries(c.notebooks)) if (typeof v === "string") out.notebooks[notebookKey(k)] = v;
  }
  return out;
};

/** A cell's companion file is virtual: it lives next to the cell under the same (odd) name plus the suffix. */
const isCellCompanion = (file: string) => isCellFile(file) && isCompanion(file);
const cellOfCompanion = (companion: string) => companion.slice(0, -COMPANION_SUFFIX.length);

/** The files to add to a project for the notebook cells it holds: the globals file and each notebook's modules.d.ts. */
function extraFilesFor(cellFiles: readonly string[], cfg: PluginConfig = config): string[] {
  if (!cellFiles.length) return [];
  const out: string[] = [];
  if (cfg.typesFile) out.push(cfg.typesFile);
  const seen = new Set<string>();
  for (const f of cellFiles) {
    const key = notebookOfCell(f);
    const file = key !== undefined ? cfg.notebooks?.[key] : undefined;
    if (file && !seen.has(file)) {
      seen.add(file);
      out.push(file);
    }
  }
  return out;
}

function init(mod: { typescript: TS }) {
  const ts = mod.typescript;

  function create(info: tsModule.server.PluginCreateInfo): tsModule.LanguageService {
    if (info.config) config = normalizeConfig(info.config);
    projects.add(info.project as { markAsDirty?: () => void });
    const host = info.languageServiceHost;
    const origNames = host.getScriptFileNames.bind(host);
    const origSnapshot = host.getScriptSnapshot.bind(host);
    const origVersion = host.getScriptVersion.bind(host);
    const origExists = host.fileExists?.bind(host);
    const origRead = host.readFile?.bind(host);
    const origResolve = host.resolveModuleNameLiterals?.bind(host);
    const origOptions = host.getCompilationSettings.bind(host);

    // Per cell file: names the companion must not re-expose (see heal); forgotten when the cell's text changes.
    const excluded = new Map<string, Set<string>>();
    /** A cell's version as tsserver should see it: the editor's, plus how many names are excluded. */
    const cellVersion = (file: string) => `${origVersion(file)}:${excluded.get(file)?.size ?? 0}`;

    // Links per cell file, recomputed when the cell's version or its exclusions change.
    const cache = new Map<string, { original: string; version: string; links: Links | null }>();
    const linksOf = (file: string): Links | null => {
      const original = origVersion(file);
      const hit = cache.get(file);
      if (hit && hit.original !== original) excluded.delete(file); // a changed cell starts afresh
      const version = cellVersion(file);
      if (hit && hit.version === version) return hit.links;
      const snap = origSnapshot(file);
      if (!snap) {
        cache.delete(file);
        return null;
      }
      const text = snap.getText(0, snap.getLength());
      const l = cellLinks(ts as unknown as TS, file, text, { exclude: excluded.get(file) });
      const links = l && { length: text.length, appendix: l.appendix, companion: l.companion };
      cache.set(file, { original, version, links });
      return links;
    };
    const cellFiles = () => origNames().filter(isCellFile);

    host.getScriptFileNames = () => {
      const names = origNames();
      const cells = names.filter(isCellFile);
      if (!cells.length) return names;
      const out = [...names];
      for (const c of cells) if (linksOf(c)) out.push(companionName(c));
      for (const f of extraFilesFor(cells)) if (!out.includes(f)) out.push(f);
      return out;
    };
    host.getScriptSnapshot = (file) => {
      if (isCellCompanion(file)) {
        const l = linksOf(cellOfCompanion(file));
        return l ? ts.ScriptSnapshot.fromString(l.companion) : undefined;
      }
      if (isCellFile(file)) {
        const l = linksOf(file);
        const snap = origSnapshot(file);
        if (l && snap) return ts.ScriptSnapshot.fromString(snap.getText(0, snap.getLength()) + l.appendix);
        return snap;
      }
      return origSnapshot(file);
    };
    host.getScriptVersion = (file) => (isCellCompanion(file) ? cellVersion(cellOfCompanion(file)) : isCellFile(file) ? cellVersion(file) : origVersion(file));
    host.fileExists = (file) => (isCellCompanion(file) ? !!linksOf(cellOfCompanion(file)) : (origExists?.(file) ?? false));
    host.readFile = (file, encoding) => (isCellCompanion(file) ? linksOf(cellOfCompanion(file))?.companion : origRead?.(file, encoding));

    // Module resolution for cells and companions:
    //   - a companion imports its cell as a module; the cell's name is nothing a relative import would find, so it is resolved by hand;
    //   - a bare name from the notebook's import map (`import { z } from "zod"`) has no shim (see core's shimsFor): it must resolve from
    //     the types dir's node_modules, so it is looked up as if imported from the notebook's modules.d.ts before the usual rules apply.
    const resolutionHost = host as tsModule.ModuleResolutionHost;
    const resolutionCache = origResolve ? undefined : ts.createModuleResolutionCache(host.getCurrentDirectory(), (f) => f, origOptions());
    const fromTypesDir = (name: string, containingFile: string, options: tsModule.CompilerOptions, redirected?: tsModule.ResolvedProjectReference) => {
      if (parseSpecifier(name).scheme !== "bare") return undefined;
      const key = notebookOfCell(containingFile);
      const modules = key === undefined ? undefined : config.notebooks?.[key];
      if (!modules) return undefined;
      const r = ts.resolveModuleName(name, modules, options, resolutionHost, undefined, redirected);
      return r.resolvedModule ? r : undefined;
    };
    host.resolveModuleNameLiterals = (literals, containingFile, redirected, options, containingSourceFile, reusedNames) => {
      if (isCellCompanion(containingFile)) {
        const cell = cellOfCompanion(containingFile);
        return literals.map(() => ({ resolvedModule: { resolvedFileName: cell, extension: ts.Extension.Ts, isExternalLibraryImport: false } }));
      }
      const usual = origResolve
        ? origResolve(literals, containingFile, redirected, options, containingSourceFile, reusedNames)
        : literals.map((l) => ts.resolveModuleName(l.text, containingFile, options, resolutionHost, resolutionCache, redirected));
      if (!isCellFile(containingFile)) return usual;
      return literals.map((l, i) => (usual[i].resolvedModule ? usual[i] : (fromTypesDir(l.text, containingFile, options, redirected) ?? usual[i])));
    };

    // The types dir's node_modules links into Deno's cache: resolve a package's dependencies from the links, not from the cache.
    host.getCompilationSettings = () => {
      const o = origOptions();
      return cellFiles().length && !o.preserveSymlinks ? { ...o, preserveSymlinks: true } : o;
    };

    // Results pointing into a companion or an appendix would confuse the editor: drop them.
    const inAppendix = (loc: Located) => {
      if (!isCellFile(loc.fileName) || isCellCompanion(loc.fileName)) return false;
      const l = linksOf(loc.fileName);
      return !!l && loc.textSpan.start >= l.length;
    };
    const keep = (loc: Located) => !isCellCompanion(loc.fileName) && !inAppendix(loc);
    const visible = (file: string, d: tsModule.Diagnostic) => {
      if (!isCellFile(file) || d.start === undefined) return true;
      const l = linksOf(file);
      return !l || d.start < l.length;
    };

    const ls = info.languageService;

    /** The local names a cell's import declarations bind. */
    const importedNames = (file: string, text: string): string[] => {
      const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
      const out: string[] = [];
      for (const st of sf.statements) {
        if (!ts.isImportDeclaration(st) || !st.importClause) continue;
        if (st.importClause.name) out.push(st.importClause.name.text);
        const b = st.importClause.namedBindings;
        if (b && ts.isNamespaceImport(b)) out.push(b.name.text);
        else if (b) for (const el of b.elements) out.push(el.name.text);
      }
      return out;
    };

    /** Names declared globally outside the notebook's cells (libs, @types, the globals file). */
    const preexistingGlobals = (): Set<string> => {
      const program = ls.getProgram();
      const anchor = program?.getSourceFiles().find((sf) => sf.isDeclarationFile && !isCellFile(sf.fileName));
      if (!program || !anchor) return new Set();
      const out = new Set<string>();
      for (const sym of program.getTypeChecker().getSymbolsInScope(anchor, ts.SymbolFlags.Value | ts.SymbolFlags.Namespace)) {
        if (sym.declarations?.some((d) => !isCellFile(d.getSourceFile().fileName))) out.add(sym.name);
      }
      return out;
    };

    /**
     * Drop names the checker rejects as circular aliases (an import that is a global already)
     * from their cells' companions, so the other names keep their types. The error names the
     * alias when it lands on the import line, but tsserver may report it on the companion's own
     * `__c` import instead; then the cell's imported names that are globals already are dropped.
     * Returns true when something changed; called again until it returns false. Never from a host callback.
     */
    const heal = (): boolean => {
      let changed = false;
      for (const file of cellFiles()) {
        const l = linksOf(file);
        if (!l) continue;
        const snap = origSnapshot(file);
        const source = snap ? snap.getText(0, snap.getLength()) : "";
        const companionDiags = ls.getSemanticDiagnostics(companionName(file));
        const cellDiags = ls.getSemanticDiagnostics(file);
        const found = circularAliasNames({ text: l.companion, diagnostics: companionDiags }, { text: source + l.appendix, diagnostics: cellDiags });
        found.delete("__c");
        if (!found.size && [...companionDiags, ...cellDiags].some((d) => d.code === CIRCULAR_ALIAS)) {
          const globals = preexistingGlobals();
          for (const n of importedNames(file, source)) if (globals.has(n)) found.add(n);
        }
        const exclude = excluded.get(file) ?? new Set<string>();
        const fresh = [...found].filter((n) => !exclude.has(n));
        if (!fresh.length) continue;
        for (const n of fresh) exclude.add(n);
        excluded.set(file, exclude);
        changed = true;
      }
      return changed;
    };

    const proxy: tsModule.LanguageService = Object.create(null);
    for (const k of Object.keys(ls) as (keyof tsModule.LanguageService)[]) {
      const f = ls[k] as unknown as (...args: unknown[]) => unknown;
      (proxy as unknown as Record<string, unknown>)[k] = (...args: unknown[]) => f.apply(ls, args);
    }
    proxy.getSyntacticDiagnostics = (file) => ls.getSyntacticDiagnostics(file).filter((d) => visible(file, d));
    proxy.getSemanticDiagnostics = (file) => {
      for (let i = 0; i < 3 && heal(); i++); // a healed companion can reveal the next clash
      return ls.getSemanticDiagnostics(file).filter((d) => visible(file, d));
    };
    proxy.getSuggestionDiagnostics = (file) => ls.getSuggestionDiagnostics(file).filter((d) => visible(file, d));
    proxy.getDefinitionAtPosition = (file, pos) => ls.getDefinitionAtPosition(file, pos)?.filter(keep);
    proxy.getDefinitionAndBoundSpan = (file, pos) => {
      const r = ls.getDefinitionAndBoundSpan(file, pos);
      return r && { ...r, definitions: r.definitions?.filter(keep) };
    };
    proxy.getTypeDefinitionAtPosition = (file, pos) => ls.getTypeDefinitionAtPosition(file, pos)?.filter(keep);
    proxy.getImplementationAtPosition = (file, pos) => ls.getImplementationAtPosition(file, pos)?.filter(keep);
    // A cross-cell name is one symbol in the declaring cell and another (the companion's alias) in later cells, joined by the
    // appendix export. A search from either side stops at the join, so a search is repeated from the other side: a hit in a
    // companion adds the real declarations as starting points, a hit in an appendix adds the alias in the companion.
    const locKey = (l: Located) => `${l.fileName}\0${l.textSpan.start}\0${l.textSpan.length}`;
    const declarations = (file: string, pos: number): Located[] => (ls.getDefinitionAtPosition(file, pos) ?? []).filter((d) => isCellFile(d.fileName) && keep(d));
    const aliasOf = (l: Located): Located | undefined => {
      const links = isCellFile(l.fileName) && !isCellCompanion(l.fileName) ? linksOf(l.fileName) : null;
      if (!links || l.textSpan.start < links.length) return undefined;
      const name = host.getScriptSnapshot(l.fileName)?.getText(l.textSpan.start, l.textSpan.start + l.textSpan.length);
      if (!name || !/^[\w$]+$/.test(name)) return undefined;
      const m = new RegExp(`^\\s*(?:export import|let) ${name.replace(/\$/g, "\\$")}\\b`, "m").exec(links.companion);
      return m ? { fileName: companionName(l.fileName), textSpan: { start: m.index + m[0].length - name.length, length: name.length } } : undefined;
    };
    const searchAll = <T>(file: string, pos: number, search: (f: string, p: number) => readonly T[] | undefined, locations: (r: T) => Located[]): T[] | undefined => {
      const first = search(file, pos);
      if (!first) return undefined;
      const out = [...first];
      const starts = [{ fileName: file, textSpan: { start: pos, length: 0 } }];
      const visited = new Set<string>();
      for (let i = 0; i < starts.length && i < 16; i++) {
        const s = starts[i];
        if (visited.has(`${s.fileName}\0${s.textSpan.start}`)) continue;
        visited.add(`${s.fileName}\0${s.textSpan.start}`);
        const results = i === 0 ? first : (search(s.fileName, s.textSpan.start) ?? []);
        if (i > 0) out.push(...results);
        for (const r of results) {
          for (const l of locations(r)) {
            if (isCellCompanion(l.fileName)) starts.push(...declarations(s.fileName, s.textSpan.start));
            else {
              const alias = aliasOf(l);
              if (alias) starts.push(alias);
            }
          }
        }
      }
      return out;
    };
    const merged = <T extends Located>(file: string, pos: number, search: (f: string, p: number) => readonly T[] | undefined): T[] | undefined => {
      const all = searchAll(file, pos, search, (l) => [l]);
      if (!all) return undefined;
      const seen = new Set<string>();
      return all.filter((l) => keep(l) && !seen.has(locKey(l)) && !!seen.add(locKey(l)));
    };
    proxy.getReferencesAtPosition = (file, pos) => merged(file, pos, (f, p) => ls.getReferencesAtPosition(f, p));
    proxy.getFileReferences = (file) => ls.getFileReferences(file).filter(keep);
    proxy.findReferences = (file, pos) => {
      const symbols = searchAll(file, pos, (f, p) => ls.findReferences(f, p), (s) => [s.definition, ...s.references]);
      if (!symbols) return undefined;
      // Symbols defined in a companion (the alias) hand their references to one with a real definition.
      const defs = new Map<string, tsModule.ReferencedSymbol>();
      const orphans: tsModule.ReferenceEntry[] = [];
      for (const s of symbols) {
        if (!keep(s.definition)) orphans.push(...s.references);
        else {
          const key = locKey(s.definition);
          const prev = defs.get(key);
          defs.set(key, prev ? { ...prev, references: [...prev.references, ...s.references] } : { ...s, references: [...s.references] });
        }
      }
      const result = [...defs.values()];
      if (result.length) result[0].references.push(...orphans);
      else return symbols.map((s) => ({ ...s, references: s.references.filter(keep) })).filter((s) => s.references.length);
      const seen = new Set<string>();
      return result.map((s) => ({ ...s, references: s.references.filter((r) => keep(r) && !seen.has(locKey(r)) && !!seen.add(locKey(r))) }));
    };
    proxy.findRenameLocations = (file, pos, findInStrings, findInComments, preferences) =>
      merged(file, pos, (f, p) => ls.findRenameLocations(f, p, findInStrings, findInComments, preferences as tsModule.UserPreferences));
    proxy.getDocumentHighlights = (file, pos, filesToSearch) =>
      ls
        .getDocumentHighlights(file, pos, filesToSearch)
        ?.filter((h) => !isCellCompanion(h.fileName))
        .map((h) => ({ ...h, highlightSpans: h.highlightSpans.filter((s) => keep({ fileName: s.fileName ?? h.fileName, textSpan: s.textSpan })) }));
    return proxy;
  }

  /** Real files on disk that notebook projects get in addition to their roots (tsserver watches these for changes). */
  function getExternalFiles(project: tsModule.server.Project): string[] {
    return extraFilesFor(project.getScriptFileNames().filter(isCellFile));
  }

  function onConfigurationChanged(c: PluginConfig | undefined) {
    config = normalizeConfig(c);
    for (const p of projects) p.markAsDirty?.();
  }

  return { create, getExternalFiles, onConfigurationChanged };
}

export = init;
