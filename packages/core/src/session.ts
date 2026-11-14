// Kernels and shared values for open notebooks.
//
// A Runtime owns one Jupyter server, one share/get hub and one SharedStore.
// Each notebook file gets a NotebookSession with its own Python and Deno
// kernels (started lazily), its own hub namespace, and its own Delta folder:
// <notebook dir>/.data/<notebook name>/.
//
// Kernels start in the folder of the nearest deno.json at or above the notebook
// (the notebook's own folder when there is none), so Deno reads its import map
// and deno.lock at startup; the preludes then chdir to the notebook's folder.
// Jupyter only starts kernels inside its root dir, so each session links
// <stateDir>/nb/<session id> to that folder and starts its kernels at that path.
// (On Windows, Deno looks for the config above the link itself, not above its
// target, so the link has to point at the config's folder.)

import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, rmdirSync, symlinkSync, unlinkSync } from "node:fs";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { Emitter } from "./events.ts";
import { Hub, type HubNamespace } from "./hub.ts";
import { JupyterServer, consoleLogger, type Kernel, type Logger } from "./jupyter.ts";
import { denoPrelude, pythonPrelude, sqlToPython, type PreludeOptions } from "./preludes.ts";
import { DENO_KERNEL, writeDenoKernelSpec } from "./runtimes.ts";
import { SharedStore } from "./shared-store.ts";
import { kernelOf, type KernelLang, type KernelState, type Lang, type Output, type SharedItem } from "./types.ts";

export interface RuntimeOptions {
  /** Python with jupyter_server + ipykernel (+ pandas, duckdb, pyarrow, deltalake). Without it, Python and SQL cells can't run. */
  python?: string;
  /** Deno executable. Without it, TypeScript cells can't run. */
  deno?: string;
  /** A private folder for the Jupyter server root and our kernel spec. */
  stateDir: string;
  /** Extra environment variables for the kernels (e.g. POLYGLOT_TUTOR_MODE). */
  env?: Record<string, string>;
  log?: Logger;
}

/** Where a notebook folder is linked inside the Jupyter root, relative to it. */
export const kernelPathFor = (sessionId: string) => `nb/${sessionId}`;

/** Remove a link made by linkNotebookDir (a junction on Windows needs rmdir). */
function removeLink(link: string) {
  try {
    if (!lstatSync(link).isSymbolicLink()) return;
  } catch {
    return;
  }
  try {
    unlinkSync(link);
  } catch {
    rmdirSync(link);
  }
}

/** The folder of the nearest deno.json / deno.jsonc at or above `dir`; `dir` itself when there is none. */
export function denoConfigDir(dir: string): string {
  for (let d = path.resolve(dir); ; d = path.dirname(d)) {
    if (existsSync(path.join(d, "deno.json")) || existsSync(path.join(d, "deno.jsonc"))) return d;
    if (path.dirname(d) === d) return path.resolve(dir);
  }
}

/** Link `<stateDir>/nb/<id>` to the kernels' starting folder (a junction on Windows). Returns the kernel path, or "" when linking failed. */
export function linkNotebookDir(stateDir: string, id: string, cwd: string, log: Logger): string {
  const link = path.join(stateDir, "nb", id);
  try {
    mkdirSync(path.dirname(link), { recursive: true });
    removeLink(link);
    symlinkSync(denoConfigDir(cwd), link, process.platform === "win32" ? "junction" : "dir");
    return kernelPathFor(id);
  } catch (e) {
    log(`could not link ${cwd} into the kernel root (${e}); kernels start in the root instead`);
    return "";
  }
}

/** Thrown when a cell's language has no runtime configured. */
export class RuntimeUnavailableError extends Error {
  constructor(readonly lang: KernelLang) {
    super(lang === "python" ? "Python isn't set up for Polyglot Tutor." : "Deno isn't set up for Polyglot Tutor.");
    this.name = "RuntimeUnavailableError";
  }
}

export interface RunResult {
  ok: boolean;
  executionCount: number | null;
}

const IDENT = /^[A-Za-z_]\w*$/;

export class Runtime {
  readonly store = new SharedStore();
  readonly hub: Hub;
  private jupyter: JupyterServer | null = null;
  private sessions = new Map<string, NotebookSession>();
  readonly log: Logger;

  constructor(readonly opts: RuntimeOptions) {
    this.log = opts.log ?? consoleLogger;
    this.hub = new Hub(this.store, (id) => this.byId(id));
  }

  /** The Jupyter server, started on first use. */
  server(): JupyterServer {
    if (!this.opts.python) throw new RuntimeUnavailableError("python");
    if (!this.jupyter) {
      const jupyterPath = path.join(this.opts.stateDir, "jupyter");
      if (this.opts.deno) writeDenoKernelSpec(jupyterPath, this.opts.deno);
      this.jupyter = new JupyterServer({ python: this.opts.python, rootDir: this.opts.stateDir, jupyterPath, env: this.opts.env, log: this.log });
    }
    return this.jupyter;
  }

  /** The session for a notebook file (created on first use). */
  session(file: string): NotebookSession {
    const key = path.resolve(file);
    let s = this.sessions.get(key);
    if (!s) this.sessions.set(key, (s = new NotebookSession(this, key)));
    return s;
  }

  /** The session for a file, if one is open. */
  existing(file: string): NotebookSession | undefined {
    return this.sessions.get(path.resolve(file));
  }

  private byId(id: string): NotebookSession | undefined {
    for (const s of this.sessions.values()) if (s.id === id) return s;
    return undefined;
  }

  /** Shut down a notebook's kernels and forget its shared values. */
  async close(file: string) {
    const key = path.resolve(file);
    const s = this.sessions.get(key);
    this.sessions.delete(key);
    await s?.dispose();
  }

  async dispose() {
    await Promise.all([...this.sessions.keys()].map((k) => this.close(k)));
    this.jupyter?.stop();
    this.jupyter = null;
    this.hub.close();
  }
}

export class NotebookSession implements HubNamespace {
  /** Hub namespace: a short hash of the file path. */
  readonly id: string;
  /** Where persisted (Delta) tables live. */
  readonly dataDir: string;
  /** The notebook's folder: kernels chdir here. */
  readonly cwd: string;
  readonly onKernelState = new Emitter<{ lang: KernelLang; state: KernelState }>();
  readonly onShared = new Emitter<SharedItem[]>();

  private kernels = new Map<KernelLang, Promise<Kernel>>();
  private states: Record<KernelLang, KernelState> = { python: "off", typescript: "off" };
  /** The kernels' working directory inside the Jupyter root (see linkNotebookDir); set on first kernel start. */
  private kernelPath: string | undefined;

  constructor(
    private runtime: Runtime,
    readonly file: string,
  ) {
    this.id = createHash("sha256").update(file).digest("hex").slice(0, 16);
    this.cwd = path.dirname(file);
    this.dataDir = path.join(this.cwd, ".data", path.basename(file).replace(/\.ipynb$/i, ""));
  }

  kernelState(lang: KernelLang): KernelState {
    return this.states[lang];
  }

  private setState(lang: KernelLang, state: KernelState) {
    this.states[lang] = state;
    this.onKernelState.fire({ lang, state });
  }

  /** The kernel for a language, started on first use. */
  kernel(lang: KernelLang): Promise<Kernel> {
    let k = this.kernels.get(lang);
    if (!k) {
      k = this.startKernel(lang);
      this.kernels.set(lang, k);
      k.catch((e) => {
        this.kernels.delete(lang);
        this.setState(lang, e instanceof RuntimeUnavailableError ? "off" : "dead");
      });
    }
    return k;
  }

  private async startKernel(lang: KernelLang): Promise<Kernel> {
    if (lang === "typescript" && !this.runtime.opts.deno) throw new RuntimeUnavailableError("typescript");
    const server = this.runtime.server();
    // Linked once per session, before the first await, so both kernels share it.
    this.kernelPath ??= linkNotebookDir(this.runtime.opts.stateDir, this.id, this.cwd, this.runtime.log);
    this.setState(lang, "starting");
    const opts: PreludeOptions = { hubUrl: await this.runtime.hub.urlFor(this.id), token: this.runtime.hub.token, dataDir: this.dataDir, cwd: this.cwd };
    const kernel = await server.startKernel(
      lang,
      lang === "python" ? "python3" : DENO_KERNEL,
      lang === "python" ? pythonPrelude(opts) : denoPrelude(opts),
      this.kernelPath,
    );
    kernel.onState = (state) => this.setState(lang, state);
    this.setState(lang, kernel.state);
    return kernel;
  }

  /** Run a cell. SQL runs on DuckDB inside the Python kernel. */
  async run(lang: Lang, code: string, onOutput: (o: Output) => void, onClear: () => void = () => {}): Promise<RunResult> {
    const k = await this.kernel(kernelOf(lang));
    return k.execute(lang === "sql" ? sqlToPython(code) : code, onOutput, onClear);
  }

  async interrupt(lang: KernelLang) {
    const k = this.kernels.get(lang);
    if (k) await (await k).interrupt();
  }

  async restart(lang: KernelLang) {
    const k = this.kernels.get(lang);
    if (k) await (await k).restart();
  }

  // ---- HubNamespace ----

  isPersisted(name: string): boolean {
    return IDENT.test(name) && existsSync(path.join(this.dataDir, name, "_delta_log"));
  }

  async persist(name: string): Promise<number> {
    const out = await (await this.kernel("python")).runSilent(`print(__pn_persist(${JSON.stringify(name)}))`);
    return Number(out.trim());
  }

  async publish(name: string): Promise<void> {
    await (await this.kernel("python")).runSilent(`__pn_publish(${JSON.stringify(name)})`);
  }

  /** Values shared in this session plus Delta tables persisted earlier. */
  async index(): Promise<SharedItem[]> {
    const items = this.runtime.store.list(this.id).map((i) => ({ ...i, persisted: this.isPersisted(i.name) }));
    const names = await readdir(this.dataDir).catch(() => [] as string[]);
    for (const name of names.sort()) {
      if (!items.some((i) => i.name === name) && this.isPersisted(name)) {
        items.push({ name, kind: "table", version: 0, from: "delta", summary: "Delta table (saved earlier)", persisted: true });
      }
    }
    return items;
  }

  changed() {
    this.index().then(
      (items) => this.onShared.fire(items),
      (e) => this.runtime.log(`could not list shared values: ${e}`),
    );
  }

  async dispose() {
    const kernels = [...this.kernels.values()];
    this.kernels.clear();
    await Promise.all(kernels.map((k) => k.then((x) => x.shutdown()).catch(() => {})));
    if (this.kernelPath) removeLink(path.join(this.runtime.opts.stateDir, "nb", this.id));
    this.kernelPath = undefined;
    this.runtime.store.clear(this.id);
    this.onKernelState.clear();
    this.onShared.clear();
  }
}
