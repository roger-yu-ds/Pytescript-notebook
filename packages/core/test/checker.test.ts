import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import ts from "typescript-6";
import { CellChecker, cellFileName, defaultLibDir, formatDiagnostic } from "../src/checker.ts";
import { writeTypesDir, type Resolution } from "../src/deno-resolver.ts";
import { HELPER_TYPES_SOURCE } from "../src/typescript.ts";

const tmp = mkdtempSync(path.join(os.tmpdir(), "polyglot-checker-"));
after(() => rmSync(tmp, { recursive: true, force: true }));

const nb = path.join(tmp, "notebooks");
mkdirSync(path.join(nb, "lib"), { recursive: true });
writeFileSync(path.join(nb, "lib", "helper.ts"), "export const helper = (x: number): string => String(x);\nexport type Id = string;\n");

const pkg = path.join(tmp, "cache", "zod", "4.0.0");
mkdirSync(pkg, { recursive: true });
writeFileSync(path.join(pkg, "package.json"), '{"name":"zod","version":"4.0.0","types":"index.d.ts","exports":{".":{"types":"./index.d.ts"}}}');
writeFileSync(path.join(pkg, "index.d.ts"), "export declare const z: { string(): ZodString };\nexport interface ZodString { parse(x: unknown): string }\n");
const zod: Resolution = { specifier: "npm:zod@4", kind: "npm", bare: "zod", packages: [{ name: "zod", version: "4.0.0", dir: pkg }], modules: [], redirects: {} };
const typesDir = path.join(tmp, "types");

const messages = (c: CellChecker, id: string) => {
  const d = c.diagnostics().get(id)!;
  return [...d.syntactic, ...d.semantic].map(formatDiagnostic);
};

function checker() {
  const c = new CellChecker({ libDir: defaultLibDir(), cwd: nb });
  c.setGlobal("/polyglot/helpers.d.ts", HELPER_TYPES_SOURCE);
  return c;
}

test("cells are virtual files in the notebook folder", () => {
  assert.equal(cellFileName("/n b/dir", "ab-c.d"), "/n b/dir/.polyglot-cell-ab-c_d.ts");
});

test("a module cell's imports, declarations and let variables reach later cells; relative imports find real files; npm types come from the types dir", () => {
  writeTypesDir(typesDir, [zod], ["npm:pending@1"]);
  const c = checker();
  c.setTypesDir(typesDir);
  c.update([
    { id: "c1", text: 'import { z, type ZodString } from "npm:zod@4";\nimport { helper, type Id } from "./lib/helper.ts";\nconst schema = z.string();\nlet count = 0;\nexport const limit = 3;\n' },
    { id: "c2", text: 'const s: ZodString = schema;\nconst txt: string = helper(limit);\nconst id: Id = "a";\ncount = count + 1;\nconst bad: number = s.parse(1);\n' },
    { id: "c3", text: 'import { what } from "npm:pending@1";\nconst n: number = what.anything;\n' },
    { id: "c4", text: 'import { nope } from "npm:unknown-pkg@1";\n' },
    { id: "c5", text: "schema = z.string();\n" },
    { id: "c6", text: "const = ;\n" },
    { id: "c7", text: 'import { z as zz } from "npm:zod@4";\nexport { zz };\n' },
  ]);
  assert.deepEqual(messages(c, "c1"), []);
  assert.deepEqual(messages(c, "c2"), ["line 5: Type 'string' is not assignable to type 'number'."]);
  assert.deepEqual(messages(c, "c3"), [], "a pending module types as any");
  assert.match(messages(c, "c4").join("\n"), /^line 1: Cannot find module 'npm:unknown-pkg@1'/);
  assert.match(messages(c, "c5").join("\n"), /Cannot assign to 'schema' because it is an import/);
  const d6 = c.diagnostics().get("c6")!;
  assert.ok(d6.syntactic.length > 0 && d6.semantic.length === 0, "syntax errors are reported apart, without semantic ones");
  assert.deepEqual(messages(c, "c7"), [], "a name the cell exports itself is not exported twice");
  assert.deepEqual(c.imports(), ["npm:zod@4", "npm:pending@1", "npm:unknown-pkg@1"]);
  c.dispose();
});

test("a bare import-map name (no shim) resolves from the types dir's node_modules, not from the notebook's folder", () => {
  const dir = path.join(tmp, "types-mapped");
  // deno.json: { "imports": { "zod": "npm:zod@4" } } → Deno reports the bare name as the package itself, and shimsFor writes no shim for it.
  writeTypesDir(dir, [{ ...zod, specifier: "zod" }]);
  const c = checker();
  c.setTypesDir(dir);
  c.update([
    { id: "m1", text: 'import { z } from "zod";\nconst schema = z.string();\n' },
    { id: "m2", text: 'const bad: number = schema.parse("x");\n' },
  ]);
  assert.deepEqual(messages(c, "m1"), []);
  assert.deepEqual(messages(c, "m2"), ["line 1: Type 'string' is not assignable to type 'number'."]);
  c.setTypesDir(undefined);
  assert.match(messages(c, "m1").join("\n"), /^line 1: Cannot find module 'zod'/, "without a types dir the bare name is unknown");
  c.dispose();
});

test("a notebook-local module's bare imports resolve from the types dir too, so cell and module share one copy of a package", () => {
  // The repo also has the package npm-installed in its own node_modules; a class with a #private field from
  // that copy is a different type from the types dir's copy (TS2345 "... refers to a different member").
  const decl = "export declare class Client { #secret: string; constructor(); }\nexport declare const brand: unique symbol;\nexport type Branded = { readonly [brand]: true };\nexport declare function make(): Branded;\n";
  const cached = path.join(tmp, "cache", "brand", "1.0.0");
  const installed = path.join(nb, "node_modules", "brand");
  for (const [d, version] of [[cached, "1.0.0"], [installed, "1.0.1"]]) {
    mkdirSync(d, { recursive: true });
    writeFileSync(path.join(d, "package.json"), `{"name":"brand","version":"${version}","types":"index.d.ts"}`);
    writeFileSync(path.join(d, "index.d.ts"), decl);
  }
  writeFileSync(path.join(nb, "lib", "use.ts"), 'import { type Branded, Client } from "brand";\nexport const use = (c: Client): number => 1;\nexport const take = (b: Branded): number => 2;\nexport const client = (): Client => new Client();\n');
  const dir = path.join(tmp, "types-brand");
  writeTypesDir(dir, [{ specifier: "brand", kind: "npm", bare: "brand", packages: [{ name: "brand", version: "1.0.0", dir: cached }], modules: [], redirects: {} }]);
  const c = checker();
  c.setTypesDir(dir);
  c.update([{ id: "b1", text: 'import { Client, make } from "brand";\nimport { client, take, use } from "./lib/use.ts";\nuse(new Client());\ntake(make());\nconst mine: Client = client();\n' }]);
  assert.deepEqual(messages(c, "b1"), []);
  c.dispose();
  rmSync(path.join(nb, "node_modules"), { recursive: true, force: true });
});

test("a name that is also a global (Worker, Event, Request) keeps the cell's meaning in later cells, and a top-level for await needs no import", () => {
  writeFileSync(path.join(nb, "lib", "shadow.ts"), "export interface Worker { speed: number }\nexport class Event { kind = 'k' }\nexport const Request = 3;\nexport const mk = (): Worker => ({ speed: 1 });\nexport async function* ticks() { yield 1; }\n");
  const c = checker();
  c.setGlobal("/polyglot/lib.d.ts", "interface Worker { postMessage(x: unknown): void }\ndeclare var Worker: { new(): Worker };\ninterface Event { type: string }\ndeclare var Event: { new(t: string): Event };\ndeclare var Request: string;\n");
  c.update([
    { id: "h1", text: 'import { mk, Event, Request, ticks, type Worker } from "./lib/shadow.ts";\nconst w: Worker = mk();\n' },
    { id: "h2", text: "const s: string = w.speed;\nconst w2: Worker = mk();\nconst k: number = new Event().kind;\nconst r: string = Request;\nlet total = 0;\nfor await (const t of ticks()) total += t;\n" },
    { id: "h3", text: "interface Worker { own: true }\nconst mine: Worker = { own: true };\nconst n: number = total;\n" },
  ]);
  assert.deepEqual(messages(c, "h1"), []);
  assert.deepEqual(messages(c, "h2"), [
    "line 1: Type 'number' is not assignable to type 'string'.",
    "line 3: Type 'string' is not assignable to type 'number'.",
    "line 4: Type 'number' is not assignable to type 'string'.",
  ]);
  assert.deepEqual(messages(c, "h3"), [], "a later cell's own declaration of the name is its own, and script-cell names still carry over");
  c.dispose();
});

// A slice of @types/node: node:process is `export = process`, the global; node:buffer names its exports.
const NODE_TYPES = `declare var process: { execPath: string; env: Record<string, string | undefined> };
declare module "node:process" { export = process; }
declare class Buffer { static from(s: string): Buffer; toString(): string }
declare module "node:buffer" { export { Buffer }; }
`;

test("an import that is a global already (node:process) is left out of the companion, so the cell's other names keep their types", () => {
  const c = checker();
  c.setGlobal("/polyglot/node.d.ts", NODE_TYPES);
  c.update([
    { id: "p1", text: 'import process from "node:process";\nconst rows = [1, 2, 3];\nconst exe: string = process.execPath;\n' },
    { id: "p2", text: "const doubled: number[] = rows.map((r) => r * 2);\nconst bad: string = rows[0];\nconst again: string = process.execPath;\n" },
    { id: "n1", text: 'import * as proc from "node:process";\nimport { Buffer } from "node:buffer";\nconst bytes = Buffer.from(proc.execPath);\n' },
    { id: "n2", text: "const text: string = bytes.toString();\nconst wrong: number = bytes;\n" },
  ]);
  assert.deepEqual(messages(c, "p1"), []);
  assert.deepEqual(messages(c, "p2"), ["line 2: Type 'number' is not assignable to type 'string'."], "rows kept its type and the global process still resolves");
  assert.deepEqual(messages(c, "n1"), []);
  assert.deepEqual(messages(c, "n2"), ["line 2: Type 'Buffer' is not assignable to type 'number'."], "a namespace import of a global module heals too; a named global import (Buffer) never needed healing");
  // Editing the cell forgets the exclusion; the next check heals again.
  c.update([
    { id: "p1", text: 'import process from "node:process";\nconst rows = ["a"];\nconst exe: string = process.execPath;\n' },
    { id: "p2", text: "const bad: number = rows[0];\n" },
  ]);
  assert.deepEqual(messages(c, "p2"), ["line 1: Type 'string' is not assignable to type 'number'."]);
  c.dispose();
});

test("types that arrive later are picked up after invalidateTypes(); removed cells drop out", () => {
  const dir = path.join(tmp, "types-later");
  writeTypesDir(dir, [], ["npm:zod@4"]);
  const c = checker();
  c.setTypesDir(dir);
  c.update([
    { id: "a", text: 'import { z } from "npm:zod@4";\n' },
    { id: "b", text: "const bad: number = z.string().parse(1);\n" },
  ]);
  assert.deepEqual(messages(c, "b"), [], "pending: any");
  writeTypesDir(dir, [zod]);
  c.invalidateTypes();
  assert.deepEqual(messages(c, "b"), ["line 1: Type 'string' is not assignable to type 'number'."]);
  c.update([{ id: "a", text: 'import { z } from "npm:zod@4";\n' }]);
  assert.deepEqual([...c.diagnostics().keys()], ["a"]);
  c.dispose();
});

test("script cells still share globals, Deno and share()/get() are known, and errors carry the cell's line", () => {
  const c = checker();
  c.setGlobal("/polyglot/lib.deno.d.ts", "declare namespace Deno { function readTextFileSync(p: string): string; }\n");
  c.update([
    { id: "s1", text: "interface User { name: string; age: number }\nconst ada: User = { name: 'Ada', age: '36' };" },
    { id: "s2", text: "const later = ada.age + 1;\nconst text = Deno.readTextFileSync('x');\nconst n = await get<number>('n');\nn.toFixed(1);" },
    { id: "s3", text: "notDefinedAnywhere();\nDeno.noSuchApi();" },
  ]);
  assert.deepEqual(messages(c, "s1"), ["line 2: Type 'string' is not assignable to type 'number'."]);
  assert.deepEqual(messages(c, "s2"), []);
  assert.match(messages(c, "s3").join("\n"), /notDefinedAnywhere[\s\S]*noSuchApi/);
  const d = c.diagnostics().get("s1")!.semantic[0];
  assert.equal(d.category, ts.DiagnosticCategory.Error);
  c.dispose();
});
