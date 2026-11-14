import assert from "node:assert/strict";
import { test } from "node:test";
import ts from "typescript-6";
import { CIRCULAR_ALIAS, cellLinks, circularAliasNames, companionName, identifierAt, importSpecifiers, isCompanion } from "../src/cell-links.ts";

test("a script cell (no import/export) needs no links: its declarations are global already", () => {
  assert.equal(cellLinks(ts, "/cells/a.ts", "const x = 1;\nasync function f() { await fetch('x'); for await (const y of g()) y; }\nclass K { async m() { await 1; } }"), null);
});

test("a script cell that awaits at the top level is linked as a module, so TypeScript allows the await (Deno runs it)", () => {
  for (const src of ["let total = 0;\nfor await (const t of ticks()) total += t;\n", "const total = await fetch('x');\n", "const total = 1;\nawait (async () => total)();\n"]) {
    const links = cellLinks(ts, "/cells/s.ts", src)!;
    assert.ok(links, src);
    assert.deepEqual(links.names.map((n) => n.name), ["total"]);
    assert.equal(links.appendix, "\nexport { total };\n");
  }
  assert.equal(cellLinks(ts, "/cells/s.ts", "await fetch('x');\n")!.appendix, "\nexport {};\n", "no names: still a module");
});

test("a module cell: every top-level name, imports included, with let/var assignable and own exports left alone", () => {
  const src = `import def, { z, type ZT } from "npm:zod@4";
import * as path from "node:path";
export const ex = 1;
const a = 1, { b, c: [d] } = obj;
let n = 0;
var v = 1;
function f<T>(x: T) { return x }
class K {}
interface I {}
type P<A> = A;
enum E { X }
namespace NS { export const q = 1 }
declare global { interface Window { w: 1 } }
export default function dflt() {}
export { a as renamed };
`;
  const links = cellLinks(ts, "/cells/c1.ts", src)!;
  assert.deepEqual(
    links.names.map((n) => n.name),
    ["def", "z", "ZT", "path", "ex", "a", "b", "d", "n", "v", "f", "K", "I", "P", "E", "NS", "dflt"],
  );
  assert.deepEqual(links.names.filter((n) => n.assignable).map((n) => n.name), ["n", "v"]);
  assert.deepEqual(links.names.filter((n) => n.exported).map((n) => n.name), ["ex"]);
  assert.equal(links.appendix, "\nexport { def, z, ZT, path, a, b, d, n, v, f, K, I, P, E, NS, dflt };\n");
  assert.equal(
    links.companion,
    `import * as __c from "./c1";
declare global {
  export import def = __c.def;
  export import z = __c.z;
  export import ZT = __c.ZT;
  export import path = __c.path;
  export import ex = __c.ex;
  export import a = __c.a;
  export import b = __c.b;
  export import d = __c.d;
  let n: typeof __c.n;
  let v: typeof __c.v;
  export import f = __c.f;
  export import K = __c.K;
  export import I = __c.I;
  export import P = __c.P;
  export import E = __c.E;
  export import NS = __c.NS;
  export import dflt = __c.dflt;
}
export {};
`,
  );
});

test("a module cell that only exports has an empty appendix and companion block", () => {
  const links = cellLinks(ts, "/cells/c2.ts", "export {};\n")!;
  assert.equal(links.appendix, "");
  assert.equal(links.companion, 'import * as __c from "./c2";\ndeclare global {\n\n}\nexport {};\n');
});

test("a redeclared name is listed once, with the last declaration's kind", () => {
  const links = cellLinks(ts, "/cells/c3.ts", 'import { x } from "npm:a";\nlet x = 2;\n')!;
  assert.deepEqual(links.names, [{ name: "x", assignable: true, exported: false }]);
});

test("companion file names", () => {
  assert.equal(companionName("/cells/abc.ts"), "/cells/abc.globals.d.ts");
  assert.equal(companionName("C:/nb/.polyglot-cell-x.tsx"), "C:/nb/.polyglot-cell-x.globals.d.ts");
  assert.ok(isCompanion("/cells/abc.globals.d.ts") && !isCompanion("/cells/abc.d.ts"));
});

test("importSpecifiers finds static imports, re-exports, import(), import types and import = require", () => {
  const src = `import a from "npm:a";\nexport * from "jsr:b";\nexport { c } from "./c.ts";\nconst d = await import("./d.ts");\ntype T = import("./t.ts").T;\nimport fs = require("node:fs");\nconst nope = import(someVar);\n`;
  assert.deepEqual(importSpecifiers(ts, "/cells/i.ts", src), ["npm:a", "jsr:b", "./c.ts", "./d.ts", "./t.ts", "node:fs"]);
});

test("excluded names are left out of the appendix and the companion", () => {
  const links = cellLinks(ts, "/cells/x.ts", 'import process from "node:process";\nconst rows = [1];\n', { exclude: new Set(["process"]) })!;
  assert.deepEqual(links.names.map((n) => n.name), ["rows"]);
  assert.equal(links.appendix, "\nexport { rows };\n");
  assert.ok(!links.companion.includes("process"));
});

test("circularAliasNames reads the offending identifiers from the companion and the cell", () => {
  const companion = 'import * as __c from "./x";\ndeclare global {\n  export import process = __c.process;\n  export import rows = __c.rows;\n}\nexport {};\n';
  const cell = 'import * as proc from "node:process";\nconst rows = [1];\n\nexport { proc, rows };\n';
  const at = (text: string, name: string) => text.lastIndexOf(name);
  const names = circularAliasNames(
    { text: companion, diagnostics: [{ code: CIRCULAR_ALIAS, start: at(companion, "process = __c") }, { code: 2300, start: at(companion, "rows = __c") }] },
    { text: cell, diagnostics: [{ code: CIRCULAR_ALIAS, start: at(cell, "proc, rows") }, { code: CIRCULAR_ALIAS, start: cell.indexOf(" ") }] },
  );
  assert.deepEqual([...names], ["process", "proc"], "only TS2303, and only where an identifier starts");
  assert.equal(identifierAt("  foo_1 = 2", 2), "foo_1");
  assert.equal(identifierAt("= 2", 0), "");
});
