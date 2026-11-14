// Resolving a cell's imports the way Deno runs them, and laying their type
// declarations out for the checkers.
//
// `deno info --json <specifier>`, run in the notebook's folder so its
// deno.json (import map) and deno.lock apply, fetches what is missing and
// describes the module graph: npm packages with their folder in Deno's cache,
// jsr/https/file modules with their cached file. From that a "types dir" is
// built: node_modules/<name> links to each npm package, remote modules are
// copied under remote/<host>/<path>, and modules.d.ts (see module-shims.ts)
// declares every specifier. The web app's checker runs in the browser, so it
// gets the same layout as file contents instead.

import { execFile } from "node:child_process";
import { copyFileSync, cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { SHIMS_FILE, moduleShims, parseSpecifier, type ModuleShim } from "./module-shims.ts";

const run = promisify(execFile);

export interface NpmPackage {
  name: string;
  version: string;
  /** The package's folder in Deno's npm cache. */
  dir: string;
}

export interface GraphModule {
  url: string;
  /** The cached file (content-addressed for remote modules, the file itself for file: urls). */
  local: string;
  mediaType: string;
}

export interface Resolution {
  specifier: string;
  kind: "npm" | "module" | "node" | "error";
  /** npm: the bare name (+ subpath) to import from node_modules, e.g. `zod/v4`. */
  bare?: string;
  /** module: the url of the entry module, after redirects and its types dependency. */
  entry?: string;
  /** Every npm package in the graph (dependencies included). */
  packages: NpmPackage[];
  /** Every jsr/https/file module in the graph. */
  modules: GraphModule[];
  /** Specifiers written inside the graph → the url they resolve to (import maps, jsr:…, npm:… ranges). */
  redirects: Record<string, string>;
  error?: string;
}

/**
 * Declares the `node:` built-ins and Node's globals. Deno 2 type-checks every program with them (its
 * `setTimeout` returns a Node `Timeout`, and `deno types` leaves the timers out), so it is always resolved.
 */
export const NODE_TYPES = "npm:@types/node";

const EXT: Record<string, string> = { TypeScript: ".ts", Tsx: ".tsx", Mts: ".mts", Cts: ".cts", Dts: ".d.ts", Dmts: ".d.mts", Dcts: ".d.cts", JavaScript: ".js", Jsx: ".jsx", Mjs: ".mjs", Cjs: ".cjs", Json: ".json" };
const TYPED = new Set(["TypeScript", "Tsx", "Mts", "Cts", "Dts", "Dmts", "Dcts"]);

const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

/** The useful line of a failed `deno info`. */
function denoError(stderr: string, fallback: string): string {
  const lines = stripAnsi(stderr).split("\n").map((l) => l.trim()).filter(Boolean);
  return lines.find((l) => /^error/i.test(l)) ?? lines.at(-1) ?? fallback;
}

export interface ResolveOptions {
  timeoutMs?: number;
}

/** Ask Deno what a specifier is and where its files are. Never throws: failures come back as kind "error". */
export async function resolveWithDeno(deno: string, cwd: string, specifier: string, opts: ResolveOptions = {}): Promise<Resolution> {
  const base: Resolution = { specifier, kind: "error", packages: [], modules: [], redirects: {} };
  let stdout: string;
  let stderr = "";
  try {
    ({ stdout, stderr } = await run(deno, ["info", "--json", specifier], { cwd, timeout: opts.timeoutMs ?? 120_000, maxBuffer: 256 * 1024 * 1024, windowsHide: true }));
  } catch (e) {
    const err = e as { stderr?: string; message: string };
    return { ...base, error: denoError(err.stderr ?? "", err.message) };
  }
  let info: unknown;
  try {
    info = JSON.parse(stdout);
  } catch {
    return { ...base, error: denoError(stderr, "deno info printed no JSON") };
  }
  return fromDenoInfo(specifier, info);
}

/** A resolution from the parsed output of `deno info --json <specifier>`. */
export function fromDenoInfo(specifier: string, parsed: unknown): Resolution {
  const base: Resolution = { specifier, kind: "error", packages: [], modules: [], redirects: {} };
  const info = parsed as any;
  const root: string = info.roots?.[0] ?? specifier;
  const redirects: Record<string, string> = info.redirects ?? {};
  const resolved: string = redirects[root] ?? root;
  const byUrl = new Map<string, any>((info.modules ?? []).map((m: any) => [m.specifier, m]));
  const rootModule = byUrl.get(resolved) ?? byUrl.get(root);
  if (rootModule?.error) return { ...base, error: String(rootModule.error) };
  const packages: NpmPackage[] = Object.values<any>(info.npmPackages ?? {})
    .filter((p) => p?.localPath)
    .map((p) => ({ name: p.name, version: p.version, dir: p.localPath }));
  if (rootModule?.kind === "node" || parseSpecifier(resolved).scheme === "node") return { ...base, kind: "node", packages, redirects };
  if (resolved.startsWith("npm:")) {
    const s = parseSpecifier(resolved);
    if (!s.name) return { ...base, error: `unexpected npm specifier ${resolved}` };
    return { ...base, kind: "npm", bare: s.subpath ? `${s.name}/${s.subpath}` : s.name, packages, redirects };
  }
  const modules: GraphModule[] = (info.modules ?? []).filter((m: any) => m.local && m.mediaType).map((m: any) => ({ url: m.specifier, local: m.local, mediaType: m.mediaType }));
  const entry: string = rootModule?.typesDependency?.dependency?.specifier ?? resolved;
  if (!modules.some((m) => m.url === entry)) return { ...base, error: `Deno could not load ${specifier}` };
  return { ...base, kind: "module", entry, packages, modules, redirects };
}

/** Where a graph module goes in a types dir (or, for file: urls inside the notebook's folder, next to the cells). */
export function modulePath(url: string, mediaType: string, cwd?: string): string {
  const ext = EXT[mediaType] ?? "";
  if (url.startsWith("file:")) {
    const file = fileURLToPath(url);
    const rel = cwd ? path.relative(cwd, file) : "";
    if (rel && !rel.startsWith("..") && !path.isAbsolute(rel)) return "local/" + rel.split(path.sep).join("/");
    return "local/_abs/" + file.replace(/^([A-Za-z]):/, "$1").split(path.sep).join("/").replace(/^\/+/, "");
  }
  const u = new URL(url);
  let p = u.pathname.endsWith("/") ? u.pathname + "index" : u.pathname;
  p = decodeURIComponent(p);
  const name = `remote/${u.host.replace(":", "_")}${p}`;
  return !ext || name.endsWith(ext) ? name : name + ext;
}

/** How a declaration file next to the types root refers to a module file: `.ts` as written, `.d.ts` dropped, `.mts`/`.cts` as `.mjs`/`.cjs`. */
function importPath(virtual: string): string {
  return "./" + virtual.replace(/\.d\.ts$/, "").replace(/\.d\.mts$|\.mts$/, ".mjs").replace(/\.d\.cts$|\.cts$/, ".cjs");
}

const isTyped = (m: GraphModule) => TYPED.has(m.mediaType);

/** The declarations for a set of resolutions. Specifiers in `pending` have no types yet. */
export function shimsFor(resolutions: Resolution[], pending: string[] = [], cwd?: string): string {
  const shims: ModuleShim[] = [];
  const typesNode = resolutions.some((r) => r.packages.some((p) => p.name === "@types/node"));
  // Deno's globals include Node's (timers among them), so @types/node is referenced whenever it resolved.
  const nodeTypes = typesNode;
  const fromUrl = (url: string, r: Resolution): string | undefined => {
    if (url.startsWith("npm:")) {
      const s = parseSpecifier(url);
      return s.name ? (s.subpath ? `${s.name}/${s.subpath}` : s.name) : undefined;
    }
    const m = r.modules.find((x) => x.url === url);
    return m && isTyped(m) ? importPath(modulePath(url, m.mediaType, cwd)) : undefined;
  };
  for (const r of resolutions) {
    switch (r.kind) {
      case "npm":
        // A bare name that is the package itself (an import map entry like "zod") resolves from node_modules as is;
        // a shim would re-export the module from itself. @types/node is only ever referenced.
        if (r.specifier !== r.bare && r.specifier !== NODE_TYPES) shims.push({ specifier: r.specifier, from: r.bare });
        break;
      case "node":
        if (!typesNode) shims.push({ specifier: r.specifier });
        break;
      case "module": {
        if (parseSpecifier(r.specifier).scheme !== "file") shims.push({ specifier: r.specifier, from: fromUrl(r.entry!, r) });
        // jsr:/npm: specifiers written inside the graph's own files
        for (const [raw, url] of Object.entries(r.redirects)) {
          const scheme = parseSpecifier(raw).scheme;
          if (scheme === "jsr" || scheme === "npm" || scheme === "remote") shims.push({ specifier: raw, from: fromUrl(url, r) });
        }
        break;
      }
      case "error":
        break;
    }
  }
  for (const p of pending) shims.push({ specifier: p });
  return moduleShims(shims, { nodeTypes });
}

/** `node_modules/<name>` → the package's folder in Deno's cache (a junction on Windows; a copy if linking fails). */
function linkPackage(dir: string, pkg: NpmPackage): void {
  const target = path.join(dir, "node_modules", ...pkg.name.split("/"));
  try {
    if (lstatSync(target).isSymbolicLink() && path.resolve(path.dirname(target), readlinkSync(target)) === path.resolve(pkg.dir)) return;
    rmSync(target, { recursive: true, force: true });
  } catch {
    /* not there yet */
  }
  mkdirSync(path.dirname(target), { recursive: true });
  try {
    symlinkSync(pkg.dir, target, process.platform === "win32" ? "junction" : "dir");
  } catch {
    cpSync(pkg.dir, target, { recursive: true });
  }
}

/** Build (or refresh) the types dir for a notebook and write its modules.d.ts. Returns the declaration text. */
export function writeTypesDir(dir: string, resolutions: Resolution[], pending: string[] = [], cwd?: string): string {
  mkdirSync(path.join(dir, "node_modules"), { recursive: true });
  for (const r of resolutions) {
    for (const p of r.packages) linkPackage(dir, p);
    for (const m of r.modules) {
      if (m.url.startsWith("file:") || !isTyped(m)) continue;
      const dest = path.join(dir, ...modulePath(m.url, m.mediaType).split("/"));
      try {
        if (statSync(dest).size === statSync(m.local).size) continue;
      } catch {
        /* copy below */
      }
      mkdirSync(path.dirname(dest), { recursive: true });
      copyFileSync(m.local, dest);
    }
  }
  const text = shimsFor(resolutions, pending, cwd);
  writeFileSync(path.join(dir, SHIMS_FILE), text);
  return text;
}

export class TypesTooLarge extends Error {
  constructor(readonly specifier: string, readonly limit: number) {
    super(`the types for ${specifier} are larger than ${Math.round(limit / 1e6)} MB`);
    this.name = "TypesTooLarge";
  }
}

const DECLARATION = /\.d\.[cm]?ts$/;

/** Declaration files of an npm package: package.json files and *.d.ts, nested node_modules skipped. Paths relative to the package. */
function declarationFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) {
        if (e.name !== "node_modules" && !e.name.startsWith(".")) walk(path.join(dir, e.name));
      } else if (e.name === "package.json" || DECLARATION.test(e.name)) out.push(path.relative(root, path.join(dir, e.name)).split(path.sep).join("/"));
    }
  };
  walk(root);
  return out;
}

/**
 * The same layout as writeTypesDir, as file contents for a checker that can't
 * read the disk (the web app): `node_modules/zod/index.d.ts` → text, …
 * File modules inside the notebook's folder come back under `local/`.
 */
export function collectTypes(resolutions: Resolution[], cwd?: string, limit = 32 * 1024 * 1024): Record<string, string> {
  const files: Record<string, string> = {};
  let bytes = 0;
  const put = (key: string, file: string, specifier: string) => {
    if (key in files) return;
    const text = readFileSync(file, "utf8");
    bytes += text.length;
    if (bytes > limit) throw new TypesTooLarge(specifier, limit);
    files[key] = text;
  };
  for (const r of resolutions) {
    for (const p of r.packages) {
      if (!existsSync(p.dir)) continue;
      for (const rel of declarationFiles(p.dir)) put(`node_modules/${p.name}/${rel}`, path.join(p.dir, rel), r.specifier);
    }
    for (const m of r.modules) if (isTyped(m)) put(modulePath(m.url, m.mediaType, cwd), m.local, r.specifier);
  }
  return files;
}

export interface ResolverOptions extends ResolveOptions {
  log?: (message: string) => void;
  /** How long a failed resolution is remembered before Deno is asked again. */
  retryFailedAfterMs?: number;
}

/** Caches resolutions per notebook folder, and adds @types/node when a `node:` import appears. */
export class DenoResolver {
  private cache = new Map<string, { at: number; result: Promise<Resolution> }>();

  constructor(
    readonly deno: string,
    private opts: ResolverOptions = {},
  ) {}

  resolve(cwd: string, specifier: string): Promise<Resolution> {
    const key = `${cwd}\0${specifier}`;
    const hit = this.cache.get(key);
    if (hit) return hit.result;
    const result = resolveWithDeno(this.deno, cwd, specifier, this.opts).then((r) => {
      if (r.kind === "error") {
        this.opts.log?.(`could not resolve ${specifier}: ${r.error}`);
        setTimeout(() => this.cache.delete(key), this.opts.retryFailedAfterMs ?? 60_000).unref?.();
      }
      return r;
    });
    this.cache.set(key, { at: Date.now(), result });
    return result;
  }

  /** Resolutions for a set of specifiers, in order, plus @types/node (Deno's checker always has Node's globals). */
  async resolveAll(cwd: string, specifiers: string[]): Promise<Resolution[]> {
    const wanted = [...new Set(specifiers)];
    if (!wanted.includes(NODE_TYPES)) wanted.push(NODE_TYPES);
    return Promise.all(wanted.map((s) => this.resolve(cwd, s)));
  }
}
