import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { after, test } from "node:test";
import { DenoResolver, NODE_TYPES, TypesTooLarge, collectTypes, fromDenoInfo, modulePath, resolveWithDeno, shimsFor, writeTypesDir, type Resolution } from "../src/deno-resolver.ts";
import { defaultDeno } from "../src/runtimes.ts";

const tmp = mkdtempSync(path.join(os.tmpdir(), "polyglot-resolver-"));
after(() => rmSync(tmp, { recursive: true, force: true }));

/** A package folder like one in Deno's npm cache. */
function fakePackage(name: string, files: Record<string, string>): string {
  const dir = path.join(tmp, "cache", ...name.split("/"), "1.0.0");
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    writeFileSync(path.join(dir, rel), text);
  }
  return dir;
}

const npmInfo = (root: string, version = "4.6.7", sub = "") => ({
  version: 1,
  roots: [root],
  modules: [{ kind: "npm", specifier: `npm:/zod@${version}${sub}`, npmPackage: `zod@${version}` }],
  redirects: { [root]: `npm:/zod@${version}${sub}` },
  npmPackages: { [`zod@${version}`]: { name: "zod", version, dependencies: [], registryUrl: "https://registry.npmjs.org/", localPath: `/cache/zod/${version}` } },
});

test("fromDenoInfo: an npm specifier, with its version range, subpath and import-map name", () => {
  const r = fromDenoInfo("npm:zod@4", npmInfo("npm:zod@4"));
  assert.equal(r.kind, "npm");
  assert.equal(r.bare, "zod");
  assert.deepEqual(r.packages, [{ name: "zod", version: "4.6.7", dir: "/cache/zod/4.6.7" }]);
  assert.equal(fromDenoInfo("npm:zod@4/v4", npmInfo("npm:zod@4/v4", "4.6.7", "/v4")).bare, "zod/v4");
  const mapped = fromDenoInfo("zod", npmInfo("npm:zod@4")); // deno.json: { "imports": { "zod": "npm:zod@4" } }
  assert.equal(mapped.kind, "npm");
  assert.equal(mapped.specifier, "zod");
  assert.equal(mapped.bare, "zod");
});

const jsrInfo = {
  version: 1,
  roots: ["jsr:@std/expect"],
  modules: [
    { kind: "esm", local: "/cache/remote/aaa", mediaType: "TypeScript", specifier: "https://jsr.io/@std/expect/1.0.20/mod.ts", dependencies: [{ specifier: "./expect.ts", code: { specifier: "https://jsr.io/@std/expect/1.0.20/expect.ts" } }] },
    { kind: "esm", local: "/cache/remote/bbb", mediaType: "TypeScript", specifier: "https://jsr.io/@std/expect/1.0.20/expect.ts", dependencies: [{ specifier: "jsr:@std/assert@^1.0.19/equal", code: { specifier: "https://jsr.io/@std/assert/1.0.19/equal.ts" } }] },
    { kind: "esm", local: "/cache/remote/ccc", mediaType: "TypeScript", specifier: "https://jsr.io/@std/assert/1.0.19/equal.ts" },
  ],
  redirects: { "jsr:@std/expect": "https://jsr.io/@std/expect/1.0.20/mod.ts", "jsr:@std/assert@^1.0.19/equal": "https://jsr.io/@std/assert/1.0.19/equal.ts" },
  packages: { "@std/expect@*": "@std/expect@1.0.20" },
  npmPackages: {},
};

test("fromDenoInfo: a jsr specifier is a module graph with cached files", () => {
  const r = fromDenoInfo("jsr:@std/expect", jsrInfo);
  assert.equal(r.kind, "module");
  assert.equal(r.entry, "https://jsr.io/@std/expect/1.0.20/mod.ts");
  assert.equal(r.modules.length, 3);
  assert.deepEqual(r.modules[0], { url: "https://jsr.io/@std/expect/1.0.20/mod.ts", local: "/cache/remote/aaa", mediaType: "TypeScript" });
  assert.equal(r.redirects["jsr:@std/assert@^1.0.19/equal"], "https://jsr.io/@std/assert/1.0.19/equal.ts");
});

test("fromDenoInfo: a remote JavaScript module with a types dependency enters through the declaration file", () => {
  const r = fromDenoInfo("https://esm.sh/nanoid@5", {
    version: 1,
    roots: ["https://esm.sh/nanoid@5"],
    modules: [
      { kind: "esm", local: "/c/js", mediaType: "JavaScript", specifier: "https://esm.sh/nanoid@5.1.16", typesDependency: { specifier: "x-typescript-types", dependency: { specifier: "https://esm.sh/nanoid@5.1.16/index.d.ts" } } },
      { kind: "esm", local: "/c/dts", mediaType: "Dts", specifier: "https://esm.sh/nanoid@5.1.16/index.d.ts" },
    ],
    redirects: { "https://esm.sh/nanoid@5": "https://esm.sh/nanoid@5.1.16" },
    npmPackages: {},
  });
  assert.equal(r.kind, "module");
  assert.equal(r.entry, "https://esm.sh/nanoid@5.1.16/index.d.ts");
});

test("fromDenoInfo: node: built-ins, and Deno's errors", () => {
  assert.equal(fromDenoInfo("node:path", { version: 1, roots: ["node:path"], modules: [{ kind: "node", specifier: "node:path" }], redirects: {}, npmPackages: {} }).kind, "node");
  const err = fromDenoInfo("zod", { version: 1, roots: ["file:///nb/zod"], modules: [{ specifier: "file:///nb/zod", error: 'Module not found "file:///nb/zod".' }], redirects: {}, npmPackages: {} });
  assert.equal(err.kind, "error");
  assert.match(err.error!, /Module not found/);
  const missing = fromDenoInfo("https://x.test/gone.ts", { version: 1, roots: ["https://x.test/gone.ts"], modules: [], redirects: {}, npmPackages: {} });
  assert.equal(missing.kind, "error");
});

test("modulePath: remote urls keep host and path, get the media type's extension when they have none; files inside the notebook folder go under local/", () => {
  assert.equal(modulePath("https://jsr.io/@std/expect/1.0.20/mod.ts", "TypeScript"), "remote/jsr.io/@std/expect/1.0.20/mod.ts");
  assert.equal(modulePath("https://esm.sh/nanoid@5.1.16", "JavaScript"), "remote/esm.sh/nanoid@5.1.16.js");
  assert.equal(modulePath("https://esm.sh/nanoid@5.1.16/index.d.ts", "Dts"), "remote/esm.sh/nanoid@5.1.16/index.d.ts");
  assert.equal(modulePath("http://localhost:8000/x", "TypeScript"), "remote/localhost_8000/x.ts");
  const nb = path.join(tmp, "nb");
  assert.equal(modulePath(pathToFileURL(path.join(nb, "lib", "x.ts")).href, "TypeScript", nb), "local/lib/x.ts");
  assert.match(modulePath(pathToFileURL(path.join(tmp, "elsewhere.ts")).href, "TypeScript", nb), /^local\/_abs\/.*elsewhere\.ts$/);
});

const npm = (specifier: string, bare: string, dir: string, name = bare.split("/").slice(0, bare.startsWith("@") ? 2 : 1).join("/")): Resolution => ({
  specifier,
  kind: "npm",
  bare,
  packages: [{ name, version: "1.0.0", dir }],
  modules: [],
  redirects: {},
});

test("shimsFor: npm re-exports, pending shorthand, node: via @types/node, jsr entries and their inner specifiers", () => {
  const zod = fakePackage("zod", { "package.json": '{"name":"zod","types":"index.d.ts"}', "index.d.ts": "export declare const z: 1;\n" });
  const node: Resolution = { specifier: "node:path", kind: "node", packages: [], modules: [], redirects: {} };
  const typesNode = npm(NODE_TYPES, "@types/node", fakePackage("@types/node", { "package.json": "{}", "index.d.ts": 'declare module "node:path" { export const sep: string; }\n' }));
  const jsr: Resolution = { ...fromDenoInfo("jsr:@std/expect", jsrInfo) };
  const text = shimsFor([npm("npm:zod@4", "zod", zod), npm("zod", "zod", zod), npm("npm:zod@4/v4", "zod/v4", zod), node, typesNode, jsr], ["npm:pending@1"]);
  assert.equal(
    text,
    `// Generated by Polyglot Tutor: types for what the notebook's cells import.
/// <reference types="node" />
declare module "npm:zod@4" { export * from "zod"; export { default } from "zod"; }
declare module "npm:zod@4/v4" { export * from "zod/v4"; export { default } from "zod/v4"; }
declare module "jsr:@std/expect" { export * from "./remote/jsr.io/@std/expect/1.0.20/mod.ts"; export { default } from "./remote/jsr.io/@std/expect/1.0.20/mod.ts"; }
declare module "jsr:@std/assert@^1.0.19/equal" { export * from "./remote/jsr.io/@std/assert/1.0.19/equal.ts"; export { default } from "./remote/jsr.io/@std/assert/1.0.19/equal.ts"; }
declare module "npm:pending@1";
`,
  );
  // node: without @types/node in the graph falls back to any
  assert.match(shimsFor([node]), /^declare module "node:path";$/m);
  // @types/node is referenced whenever it resolved, with or without a node: import: Deno's globals include Node's (setTimeout)
  assert.match(shimsFor([typesNode]), /^\/\/\/ <reference types="node" \/>$/m);
  // declaration files are referenced without their extension, .mts/.cts as .mjs/.cjs
  const dts: Resolution = { specifier: "https://x.test/a", kind: "module", entry: "https://x.test/a/index.d.ts", packages: [], modules: [{ url: "https://x.test/a/index.d.ts", local: "/c/a", mediaType: "Dts" }], redirects: {} };
  assert.match(shimsFor([dts]), /export \* from "\.\/remote\/x\.test\/a\/index"/);
  const mts: Resolution = { ...dts, entry: "https://x.test/b.mts", modules: [{ url: "https://x.test/b.mts", local: "/c/b", mediaType: "Mts" }] };
  assert.match(shimsFor([mts]), /export \* from "\.\/remote\/x\.test\/b\.mjs"/);
});

test("writeTypesDir links npm packages into node_modules, copies remote modules, writes modules.d.ts, and is idempotent", () => {
  const zod = fakePackage("zod", { "package.json": '{"name":"zod","types":"index.d.ts"}', "index.d.ts": "export declare const z: 1;\n" });
  const remote = path.join(tmp, "remote-src.ts");
  writeFileSync(remote, "export const e = 1;\n");
  const jsr: Resolution = { specifier: "jsr:@x/y", kind: "module", entry: "https://jsr.io/@x/y/1.0.0/mod.ts", packages: [], modules: [{ url: "https://jsr.io/@x/y/1.0.0/mod.ts", local: remote, mediaType: "TypeScript" }], redirects: {} };
  const dir = path.join(tmp, "types");
  const text = writeTypesDir(dir, [npm("npm:zod@4", "zod", zod), jsr], ["npm:p@1"]);
  const link = path.join(dir, "node_modules", "zod");
  assert.ok(lstatSync(link).isSymbolicLink() || existsSync(path.join(link, "index.d.ts")));
  if (lstatSync(link).isSymbolicLink()) assert.equal(path.resolve(path.dirname(link), readlinkSync(link)), path.resolve(zod));
  assert.equal(readFileSync(path.join(dir, "remote", "jsr.io", "@x", "y", "1.0.0", "mod.ts"), "utf8"), "export const e = 1;\n");
  assert.equal(readFileSync(path.join(dir, "modules.d.ts"), "utf8"), text);
  assert.match(text, /declare module "npm:p@1";/);
  // a second call with the same inputs changes nothing and keeps the links
  assert.equal(writeTypesDir(dir, [npm("npm:zod@4", "zod", zod), jsr], ["npm:p@1"]), text);
  assert.ok(existsSync(path.join(link, "index.d.ts")));
  // a different package folder for the same name replaces the link
  const zod2 = fakePackage("zod2", { "package.json": '{"name":"zod"}', "index.d.ts": "export declare const z: 2;\n" });
  writeTypesDir(dir, [npm("npm:zod@5", "zod", zod2)]);
  assert.equal(readFileSync(path.join(link, "index.d.ts"), "utf8"), "export declare const z: 2;\n");
});

test("collectTypes gathers package.json and *.d.ts files per package (nested node_modules skipped), remote modules, and enforces the size limit", () => {
  const pkg = fakePackage("@scope/pkg", {
    "package.json": '{"name":"@scope/pkg"}',
    "index.d.ts": "export {};\n",
    "lib/deep.d.cts": "export {};\n",
    "lib/code.js": "nope",
    "node_modules/inner/index.d.ts": "nope",
  });
  const remote = path.join(tmp, "collect-remote.ts");
  writeFileSync(remote, "export const r = 1;\n");
  const mod: Resolution = { specifier: "jsr:@a/b", kind: "module", entry: "https://jsr.io/@a/b/1.0.0/mod.ts", packages: [], modules: [{ url: "https://jsr.io/@a/b/1.0.0/mod.ts", local: remote, mediaType: "TypeScript" }, { url: "https://jsr.io/@a/b/1.0.0/x.js", local: remote, mediaType: "JavaScript" }], redirects: {} };
  const files = collectTypes([npm("npm:@scope/pkg@1", "@scope/pkg", pkg), mod]);
  assert.deepEqual(Object.keys(files).sort(), ["node_modules/@scope/pkg/index.d.ts", "node_modules/@scope/pkg/lib/deep.d.cts", "node_modules/@scope/pkg/package.json", "remote/jsr.io/@a/b/1.0.0/mod.ts"]);
  assert.equal(files["remote/jsr.io/@a/b/1.0.0/mod.ts"], "export const r = 1;\n");
  assert.throws(() => collectTypes([npm("npm:@scope/pkg@1", "@scope/pkg", pkg)], undefined, 10), TypesTooLarge);
});

test("DenoResolver caches per folder and specifier, and always adds @types/node", async () => {
  const asked: string[] = [];
  class Stub extends DenoResolver {
    override resolve(cwd: string, specifier: string): Promise<Resolution> {
      asked.push(specifier);
      return Promise.resolve({ specifier, kind: specifier.startsWith("node:") ? "node" : "npm", packages: [], modules: [], redirects: {} });
    }
  }
  const r = new Stub("deno");
  const all = await r.resolveAll("/nb", ["node:path", "npm:zod@4", "node:path"]);
  assert.deepEqual(all.map((x) => x.specifier), ["node:path", "npm:zod@4", NODE_TYPES]);
  assert.deepEqual(asked, ["node:path", "npm:zod@4", NODE_TYPES]);
  assert.deepEqual((await r.resolveAll("/nb", ["npm:zod@4"])).map((x) => x.specifier), ["npm:zod@4", NODE_TYPES], "without a node: import too");
  assert.deepEqual((await r.resolveAll("/nb", [])).map((x) => x.specifier), [NODE_TYPES], "and with no imports at all");
});

test("DenoResolver remembers a result and forgets a failure after retryFailedAfterMs", async () => {
  let calls = 0;
  const fake = path.join(tmp, "nodeno");
  const r = new DenoResolver(fake, { retryFailedAfterMs: 50, log: () => calls++ });
  const first = r.resolve("/nb", "npm:x@1");
  assert.equal(r.resolve("/nb", "npm:x@1"), first, "same promise while in flight");
  assert.equal((await first).kind, "error", "a missing deno is an error, not an exception");
  assert.equal(calls, 1);
  await new Promise((res) => setTimeout(res, 80));
  assert.notEqual(r.resolve("/nb", "npm:x@1"), first, "asked again after the failure expired");
});

const deno = process.env.POLYGLOT_DENO ?? process.env.DENO_BIN ?? defaultDeno();

test("resolveWithDeno with the real Deno: an npm package (network), a bogus one, and a bare name without an import map", { skip: !existsSync(deno) && `no deno at ${deno}` }, async () => {
  const nb = path.join(tmp, "real");
  mkdirSync(nb, { recursive: true });
  const zod = await resolveWithDeno(deno, nb, "npm:zod@4");
  assert.equal(zod.kind, "npm", String(zod.error));
  assert.equal(zod.bare, "zod");
  assert.ok(existsSync(path.join(zod.packages[0].dir, "package.json")), zod.packages[0].dir);
  const bogus = await resolveWithDeno(deno, nb, "npm:polyglot-tutor-no-such-package-zz@1");
  assert.equal(bogus.kind, "error");
  assert.ok(bogus.error, "has a message");
  const bare = await resolveWithDeno(deno, nb, "zod");
  assert.equal(bare.kind, "error");
  // with an import map next to the notebook the bare name resolves
  writeFileSync(path.join(nb, "deno.json"), JSON.stringify({ imports: { zod: "npm:zod@4" } }));
  const mapped = await resolveWithDeno(deno, nb, "zod");
  assert.equal(mapped.kind, "npm", String(mapped.error));
  assert.equal(mapped.bare, "zod");
});
