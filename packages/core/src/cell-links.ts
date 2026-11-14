// Cross-cell names for TypeScript cells that are modules.
//
// Deno's kernel keeps every cell's top-level declarations, imports included,
// for the cells that follow. The checkers model each cell as its own file,
// which is right for script cells (their declarations are global) but not for
// a cell with an import or export: that cell is a module and its names stay
// private, so later cells get "Cannot find name".
//
// For a module cell we do two things to the checker's view of the notebook:
//   1. append an export list to the cell's text, so the names can be reached
//      from another file (appending leaves every position in the cell as is);
//   2. add a companion declaration file next to the cell that re-exposes each
//      name globally with `export import x = __c.x`, which carries values,
//      classes, interfaces, generics and type-only imports alike. `let`/`var`
//      variables are declared with their type instead, so a later cell may
//      still assign to them.
//
// One kind of name can't be re-exposed: an import that *is* a global already
// (`import process from "node:process"`: the module is `export = process`, the
// global). Its alias would be circular (TS2303), and the checker then treats
// every name the companion exposes as `any`. Hosts heal this from the
// diagnostics: `circularAliasNames` reads the offending names, and `exclude`
// leaves them out (the global already provides them).
//
// A name that is also a global (Deno's `Worker`, `Request`, `Event`) can't be re-exposed either: the
// companion's alias silently loses to the lib's declaration, with no diagnostic, and later cells see the
// global. Hosts find such names with the type checker, keep them out of the companion (`hidden`) and give
// each later cell its own binding instead: an appended `import { Worker } from "./.polyglot-cell-x"`
// (`inherited`), which shadows the global as the kernel's cell-to-cell scope does.
//
// Browser-safe: the TypeScript API is passed in (the extension bundles
// TypeScript 6, Monaco's worker has its own).

import type ts from "typescript-6";

type TS = typeof ts;

export interface CellName {
  name: string;
  /** Declared with `let`/`var` (or `using`): later cells may assign to it. */
  assignable: boolean;
  /** The cell exports it itself (under this name), so the appendix must not. */
  exported: boolean;
}

export interface CellLinks {
  names: CellName[];
  /** Appended to the cell text for the checker: `export { … }` for the names the cell doesn't export itself ("" if none). */
  appendix: string;
  /** The companion declaration file (a module augmenting the global scope). */
  companion: string;
}

export const COMPANION_SUFFIX = ".globals.d.ts";

/** The companion file of a cell file: `/cells/abc.ts` → `/cells/abc.globals.d.ts`. */
export const companionName = (cellFile: string) => cellFile.replace(/\.tsx?$/, "") + COMPANION_SUFFIX;

export const isCompanion = (file: string) => file.endsWith(COMPANION_SUFFIX);

export interface CellLinksOptions {
  /** Names left out of the appendix and companion (see circularAliasNames). */
  exclude?: ReadonlySet<string>;
  /** Names left out of the companion only: a global of the same name hides them (see the header). */
  hidden?: ReadonlySet<string>;
  /** Hidden names of earlier cells → the cell module that has them (`./.polyglot-cell-x`): imported by the appendix. */
  inherited?: ReadonlyMap<string, string>;
}

/** True when a statement list awaits at the top level (`await x`, `for await`), outside any function or class. */
export function hasTopLevelAwait(api: TS, sf: ts.SourceFile): boolean {
  const visit = (node: ts.Node): boolean => {
    if (api.isFunctionLike(node) || api.isClassLike(node)) return false;
    if (api.isAwaitExpression(node) || (api.isForOfStatement(node) && node.awaitModifier)) return true;
    // In a script `await (async () => x)()` parses as a call to a function named `await`.
    if (api.isCallExpression(node) && api.isIdentifier(node.expression) && node.expression.text === "await") return true;
    return api.forEachChild(node, visit) ?? false;
  };
  return sf.statements.some(visit);
}

/**
 * Top-level names a cell declares or imports, in order; null when the cell is a script (no import/export).
 * A script that awaits at the top level is linked as a module: Deno's kernel runs it, but TypeScript allows
 * top-level await only in a module (TS1375/TS1431), so its appendix makes it one (`export {}` at least).
 */
export function cellLinks(api: TS, cellFile: string, text: string, opts: CellLinksOptions = {}): CellLinks | null {
  const sf = api.createSourceFile(cellFile, text, api.ScriptTarget.Latest, true, api.ScriptKind.TS);
  const module = api.isExternalModule(sf);
  const inheritedFor = (own: ReadonlySet<string>) => [...(opts.inherited ?? new Map<string, string>())].filter(([n]) => !own.has(n));
  if (!module && !hasTopLevelAwait(api, sf) && !inheritedFor(scriptNames(api, sf)).length) return null;
  const names = new Map<string, CellName>();
  const add = (name: string | undefined, assignable: boolean, exported: boolean) => {
    if (name && !opts.exclude?.has(name)) names.set(name, { name, assignable, exported });
  };
  // Exported under its own name (a default export leaves the local name unexported).
  const ownExport = (node: ts.Node) => {
    const flags = api.getCombinedModifierFlags(node as ts.Declaration);
    return !!(flags & api.ModifierFlags.Export) && !(flags & api.ModifierFlags.Default);
  };
  for (const st of sf.statements) {
    if (api.isImportDeclaration(st)) {
      const clause = st.importClause;
      if (!clause) continue;
      add(clause.name?.text, false, false);
      if (clause.namedBindings) {
        if (api.isNamespaceImport(clause.namedBindings)) add(clause.namedBindings.name.text, false, false);
        else for (const el of clause.namedBindings.elements) add(el.name.text, false, false);
      }
    } else if (api.isImportEqualsDeclaration(st)) {
      add(st.name.text, false, ownExport(st));
    } else if (api.isVariableStatement(st)) {
      const assignable = !(st.declarationList.flags & api.NodeFlags.Const);
      for (const d of st.declarationList.declarations) for (const n of boundNames(api, d.name)) add(n, assignable, ownExport(st));
    } else if (api.isFunctionDeclaration(st) || api.isClassDeclaration(st) || api.isInterfaceDeclaration(st) || api.isTypeAliasDeclaration(st) || api.isEnumDeclaration(st)) {
      add(st.name?.text, false, ownExport(st));
    } else if (api.isModuleDeclaration(st) && api.isIdentifier(st.name) && !(st.flags & api.NodeFlags.GlobalAugmentation)) {
      add(st.name.text, false, ownExport(st));
    }
  }
  const list = [...names.values()];
  const unexported = list.filter((n) => !n.exported).map((n) => n.name);
  const byModule = new Map<string, string[]>();
  for (const [n, from] of inheritedFor(new Set(names.keys()))) byModule.set(from, [...(byModule.get(from) ?? []), n]);
  const imports = [...byModule].map(([from, ns]) => `import { ${ns.join(", ")} } from ${JSON.stringify(from)};\n`).join("");
  const exports = unexported.length ? `export { ${unexported.join(", ")} };\n` : module || imports ? "" : "export {};\n";
  const appendix = imports || exports ? `\n${imports}${exports}` : "";
  const base = cellFile.slice(cellFile.lastIndexOf("/") + 1).replace(/\.tsx?$/, "");
  const lines = list
    .filter((n) => !opts.hidden?.has(n.name))
    .map((n) => (n.assignable ? `  let ${n.name}: typeof __c.${n.name};` : `  export import ${n.name} = __c.${n.name};`));
  const companion = `import * as __c from "./${base}";\ndeclare global {\n${lines.join("\n")}\n}\nexport {};\n`;
  return { names: list, appendix, companion };
}

/** Names a script's top-level statements declare (so an inherited import doesn't redeclare them). */
function scriptNames(api: TS, sf: ts.SourceFile): Set<string> {
  const out = new Set<string>();
  for (const st of sf.statements) {
    if (api.isVariableStatement(st)) for (const d of st.declarationList.declarations) for (const n of boundNames(api, d.name)) out.add(n);
    else if ((api.isFunctionDeclaration(st) || api.isClassDeclaration(st) || api.isInterfaceDeclaration(st) || api.isTypeAliasDeclaration(st) || api.isEnumDeclaration(st)) && st.name) out.add(st.name.text);
  }
  return out;
}

/** TypeScript's "Circular definition of import alias" diagnostic. */
export const CIRCULAR_ALIAS = 2303;

/** The identifier at a position in some text ("" when there is none). */
export function identifierAt(text: string, position: number): string {
  return /^[A-Za-z_$][\w$]*/.exec(text.slice(position))?.[0] ?? "";
}

/**
 * Names whose re-exposure the checker rejected as circular (TS2303), read from the diagnostics of
 * a cell's companion and of the cell file itself (the error lands on the import line, on the
 * appendix, or in the companion, depending on the import's form). A host adds them to `exclude`
 * and rebuilds the cell's links; a genuine circular alias in the cell keeps its error.
 */
export function circularAliasNames(...files: { text: string; diagnostics: readonly { code: number; start?: number }[] }[]): Set<string> {
  const out = new Set<string>();
  for (const f of files) for (const d of f.diagnostics) if (d.code === CIRCULAR_ALIAS && d.start !== undefined) out.add(identifierAt(f.text, d.start));
  out.delete("");
  return out;
}

/** Every identifier bound by a declaration name, destructuring included. */
function boundNames(api: TS, name: ts.BindingName): string[] {
  if (api.isIdentifier(name)) return [name.text];
  const out: string[] = [];
  for (const el of name.elements) if (!api.isOmittedExpression(el)) out.push(...boundNames(api, el.name));
  return out;
}

/** Module specifiers a cell imports (static imports, re-exports and `import()` with a literal). */
export function importSpecifiers(api: TS, cellFile: string, text: string): string[] {
  const sf = api.createSourceFile(cellFile, text, api.ScriptTarget.Latest, true, api.ScriptKind.TS);
  const out = new Set<string>();
  const visit = (node: ts.Node) => {
    if ((api.isImportDeclaration(node) || api.isExportDeclaration(node)) && node.moduleSpecifier && api.isStringLiteral(node.moduleSpecifier)) out.add(node.moduleSpecifier.text);
    else if (api.isImportEqualsDeclaration(node) && api.isExternalModuleReference(node.moduleReference) && api.isStringLiteral(node.moduleReference.expression)) out.add(node.moduleReference.expression.text);
    else if (api.isCallExpression(node) && node.expression.kind === api.SyntaxKind.ImportKeyword && node.arguments[0] && api.isStringLiteral(node.arguments[0])) out.add(node.arguments[0].text);
    else if (api.isImportTypeNode(node) && api.isLiteralTypeNode(node.argument) && api.isStringLiteral(node.argument.literal)) out.add(node.argument.literal.text);
    api.forEachChild(node, visit);
  };
  visit(sf);
  return [...out];
}
