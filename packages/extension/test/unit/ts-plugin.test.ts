// The tsserver plugin against a real TypeScript 6 language service, with cell
// files named the way VS Code names notebook cells for tsserver.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import ts from "typescript-6";
import { defaultLibDir, writeTypesDir, type Resolution } from "@polyglot-tutor/core";
import { HELPER_TYPES_SOURCE } from "@polyglot-tutor/core/browser";
import init = require("../../ts-plugin/index.ts");
import { notebookKey, notebookOfCell } from "../../ts-plugin/notebook-key.ts";

const tmp = mkdtempSync(path.join(os.tmpdir(), "polyglot-plugin-"));
after(() => rmSync(tmp, { recursive: true, force: true }));

// A zod-like package in a "Deno cache", linked into a types dir like the extension does.
const pkg = path.join(tmp, "cache", "zod", "4.0.0");
mkdirSync(pkg, { recursive: true });
writeFileSync(path.join(pkg, "package.json"), '{"name":"zod","version":"4.0.0","types":"index.d.ts"}');
writeFileSync(path.join(pkg, "index.d.ts"), "export declare const z: { string(): ZodString };\nexport interface ZodString { parse(x: unknown): string }\n");
const zod: Resolution = { specifier: "npm:zod@4", kind: "npm", bare: "zod", packages: [{ name: "zod", version: "4.0.0", dir: pkg }], modules: [], redirects: {} };
const typesDir = path.join(tmp, "types");
writeTypesDir(typesDir, [zod]);
const modulesFile = path.join(typesDir, "modules.d.ts");
const typesFile = path.join(tmp, "globals.d.ts");
writeFileSync(typesFile, HELPER_TYPES_SOURCE);
// The same plus a slice of @types/node: node:process is `export = process`, the global.
const nodeTypesFile = path.join(tmp, "globals-node.d.ts");
writeFileSync(nodeTypesFile, `${HELPER_TYPES_SOURCE}\ndeclare var process: { execPath: string };\ndeclare module "node:process" { export = process; }\n`);

const nbDir = path.join(tmp, "nb");
mkdirSync(nbDir, { recursive: true });
const notebook = path.join(nbDir, "a.ipynb");
// The notebook's URI path, as vscode.Uri.path gives it: forward slashes, and a leading slash before a Windows drive.
const notebookUriPath = (/^[A-Za-z]:/.test(notebook) ? "/" : "") + notebook.replace(/\\/g, "/");
const cell = (id: string) => `^/vscode-notebook-cell/ts-nul-authority${notebookUriPath}#${id}`;
const config = { typesFile, notebooks: { [notebookKey(notebookUriPath)]: modulesFile } };

// VS Code's inferred-project options, more or less.
const options: ts.CompilerOptions = {
  target: ts.ScriptTarget.ESNext,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Node10,
  lib: ["lib.esnext.d.ts"],
  strict: true,
  allowSyntheticDefaultImports: true,
  allowNonTsExtensions: true,
  noEmit: true,
  types: [],
};

function makeHost() {
  // Keyed by normalized name: TypeScript asks for root files with forward slashes, whatever getScriptFileNames returned.
  const files = new Map<string, { text: string; version: number }>();
  const norm = (f: string) => f.replace(/\\/g, "/");
  const host: ts.LanguageServiceHost = {
    getCompilationSettings: () => options,
    getScriptFileNames: () => [...files.keys()],
    getScriptVersion: (f) => String(files.get(norm(f))?.version ?? 0),
    getScriptSnapshot: (f) => {
      const v = files.get(norm(f));
      if (v) return ts.ScriptSnapshot.fromString(v.text);
      return ts.sys.fileExists(f) ? ts.ScriptSnapshot.fromString(ts.sys.readFile(f)!) : undefined;
    },
    getCurrentDirectory: () => nbDir,
    getDefaultLibFileName: () => path.join(defaultLibDir(), "lib.esnext.d.ts"),
    fileExists: (f) => files.has(norm(f)) || ts.sys.fileExists(f),
    readFile: (f) => files.get(norm(f))?.text ?? ts.sys.readFile(f),
    directoryExists: ts.sys.directoryExists,
    getDirectories: ts.sys.getDirectories,
    realpath: ts.sys.realpath,
  };
  const set = (f: string, text: string) => files.set(norm(f), { text, version: (files.get(norm(f))?.version ?? 0) + 1 });
  return { host, set, files };
}

function plugin(cfg: object = config) {
  const { host, set } = makeHost();
  const inner = ts.createLanguageService(host);
  const project = { markAsDirty: () => {}, getScriptFileNames: () => host.getScriptFileNames() };
  const mod = init({ typescript: ts });
  const ls = mod.create({ languageService: inner, languageServiceHost: host, project, serverHost: ts.sys, config: cfg } as unknown as ts.server.PluginCreateInfo);
  const errors = (f: string) => [...ls.getSyntacticDiagnostics(f), ...ls.getSemanticDiagnostics(f)].map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n"));
  return { ls, host, set, project, mod, errors };
}

test("notebook keys: a tsserver cell file name maps to the notebook's URI path", () => {
  assert.equal(notebookOfCell("^/vscode-notebook-cell/ts-nul-authority/home/r/nb.ipynb#W0sZmlsZQ=="), "home/r/nb.ipynb");
  assert.equal(notebookOfCell("^/vscode-notebook-cell/ts-nul-authority/c:/Users/R/My NB.ipynb#W1s"), notebookKey("/c:/Users/R/My NB.ipynb"));
  assert.equal(notebookOfCell("/home/r/other.ts"), undefined);
});

test("a module cell's names reach later cells with real package types; share/get and the modules file are known", () => {
  const { ls, set, errors, mod, project } = plugin();
  set(cell("c1"), 'import { z } from "npm:zod@4";\nconst schema = z.string();\nlet count = 0;\n');
  set(cell("c2"), 'const bad: number = schema.parse(1);\ncount = 2;\nshare("n", count).then(() => get<number>("n"));\n');
  set(cell("c3"), "sche");
  assert.deepEqual(errors(cell("c1")), []);
  assert.deepEqual(errors(cell("c2")), ["Type 'string' is not assignable to type 'number'."]);
  const names = ls.getCompletionsAtPosition(cell("c3"), 4, undefined)?.entries.map((e) => e.name) ?? [];
  assert.ok(names.includes("schema") && names.includes("share"), names.slice(0, 10).join(","));
  assert.deepEqual(mod.getExternalFiles(project as unknown as ts.server.Project), [typesFile, modulesFile]);
  // hover on the cross-cell name shows the package's type
  const hover = ls.getQuickInfoAtPosition(cell("c2"), 22);
  assert.match(ts.displayPartsToString(hover?.displayParts), /ZodString/);
});

test("results inside the appendix or the companion are dropped: references, highlights, definitions", () => {
  const { ls, set, host } = plugin();
  set(cell("c1"), 'import { z } from "npm:zod@4";\nconst schema = z.string();\n');
  set(cell("c2"), "schema.parse(1);\n");
  ls.getProgram(); // sync
  assert.ok(host.getScriptFileNames().some((f) => f.endsWith("#c1.globals.d.ts")), "the module cell has a companion");
  assert.ok(!host.getScriptFileNames().some((f) => f.endsWith("#c2.globals.d.ts")), "a script cell has none");
  const where = (r: { fileName: string; textSpan: ts.TextSpan }) => [r.fileName.slice(r.fileName.lastIndexOf("#")), r.textSpan.start];
  // from the use in c2: the declaration in c1 and the use, nothing in the companion alias or the appendix
  assert.deepEqual((ls.getReferencesAtPosition(cell("c2"), 2) ?? []).map(where).sort(), [["#c1", 37], ["#c2", 0]]);
  assert.deepEqual((ls.findRenameLocations(cell("c2"), 2, false, false, {}) ?? []).map(where).sort(), [["#c1", 37], ["#c2", 0]]);
  const symbols = ls.findReferences(cell("c2"), 2) ?? [];
  assert.deepEqual(symbols.flatMap((s) => s.references).map(where).sort(), [["#c1", 37], ["#c2", 0]]);
  assert.ok(symbols.every((s) => !s.definition.fileName.endsWith(".globals.d.ts")));
  // and from the declaration in c1: the same two
  assert.deepEqual((ls.getReferencesAtPosition(cell("c1"), 37) ?? []).map(where).sort(), [["#c1", 37], ["#c2", 0]]);
  const defs = ls.getDefinitionAtPosition(cell("c2"), 2) ?? [];
  assert.deepEqual(defs.map((d) => d.fileName.slice(d.fileName.lastIndexOf("#"))), ["#c1"]);
  for (const h of ls.getDocumentHighlights(cell("c1"), 37, host.getScriptFileNames()) ?? []) {
    assert.ok(!h.fileName.endsWith(".globals.d.ts"));
    for (const s of h.highlightSpans) assert.ok(s.textSpan.start < 60, "no highlight in the appendix");
  }
  assert.deepEqual(
    ls.getSemanticDiagnostics(cell("c1")).filter((d) => (d.start ?? 0) >= 60),
    [],
    "no diagnostics from the appendix",
  );
});

test("an import-map bare name resolves from the notebook's types dir, and the modules file is read again when the configuration changes", () => {
  const { set, errors, mod } = plugin();
  set(cell("c1"), 'import { z as zz } from "zod";\nconst bad: number = zz.string().parse(1);\n');
  assert.deepEqual(errors(cell("c1")), ["Type 'string' is not assignable to type 'number'."]);
  mod.onConfigurationChanged({ typesFile });
  assert.match(errors(cell("c1")).join("\n"), /Cannot find module 'zod'/);
  mod.onConfigurationChanged(config);
  assert.deepEqual(errors(cell("c1")), ["Type 'string' is not assignable to type 'number'."]);
});

test("an import that is a global already (node:process) is dropped from the companion, so the cell's other names keep their types", () => {
  for (const line of ['import process from "node:process";', 'import * as process from "node:process";']) {
    const { ls, set, errors } = plugin({ ...config, typesFile: nodeTypesFile });
    set(cell("c1"), `${line}\nconst rows = [1, 2, 3];\nconst exe: string = process.execPath;\n`);
    set(cell("c2"), "const bad: string = rows[0];\nconst again: string = process.execPath;\n");
    set(cell("c3"), "ro");
    assert.deepEqual(errors(cell("c1")), [], line);
    assert.deepEqual(errors(cell("c2")), ["Type 'number' is not assignable to type 'string'."], `${line}: rows must keep its type`);
    const names = ls.getCompletionsAtPosition(cell("c3"), 2, undefined)?.entries.map((e) => e.name) ?? [];
    assert.ok(names.includes("rows"), `${line}: ${names.slice(0, 10).join(",")}`);
    // Editing the cell forgets the exclusion; the next diagnostics request heals again.
    set(cell("c1"), `${line}\nconst rows = ["a"];\n`);
    set(cell("c2"), "const bad: number = rows[0];\n");
    assert.deepEqual(errors(cell("c2")), ["Type 'string' is not assignable to type 'number'."], line);
  }
});

test("script cells are left alone, and files outside notebooks are untouched", () => {
  const { set, errors, host } = plugin();
  set(cell("c1"), "const q = 1;\n");
  set(cell("c2"), "q.toFixed(1);\n");
  const other = path.join(nbDir, "other.ts");
  set(other, "export const o: number = 'x';\n");
  assert.deepEqual(errors(cell("c2")), []);
  assert.match(errors(other).join("\n"), /not assignable/);
  assert.ok(!host.getScriptFileNames().some((f) => f.includes("globals.d.ts") && f.includes("other")));
});
