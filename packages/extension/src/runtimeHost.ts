// Owns the core Runtime (Jupyter server, hub, kernels) and maps open notebooks
// to kernel sessions. Recreated when the runtime settings change.

import * as vscode from "vscode";
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { Emitter, Runtime, defaultDeno, venvPython, type KernelLang, type KernelState, type NotebookSession, type SharedItem } from "@polyglot-tutor/core";
import { runtimeSettings } from "./config.ts";

/** Where "Set Up Runtimes" installs things (inside the extension's global storage). */
export function managedPaths(storage: vscode.Uri) {
  const root = path.join(storage.fsPath, "runtimes");
  return {
    root,
    venv: path.join(root, "venv"),
    python: venvPython(path.join(root, "venv")),
    deno: path.join(root, "deno", process.platform === "win32" ? "deno.exe" : "deno"),
  };
}

export interface ResolvedRuntimes {
  python?: string;
  deno?: string;
  pythonSource: "setting" | "managed" | "none";
  denoSource: "setting" | "managed" | "default" | "none";
}

/** Settings first, then the managed install, then (Deno only) the default install location. */
export function resolveRuntimes(storage: vscode.Uri): ResolvedRuntimes {
  const s = runtimeSettings();
  const managed = managedPaths(storage);
  const r: ResolvedRuntimes = { pythonSource: "none", denoSource: "none" };
  if (s.python) Object.assign(r, { python: s.python, pythonSource: "setting" });
  else if (existsSync(managed.python)) Object.assign(r, { python: managed.python, pythonSource: "managed" });
  if (s.deno) Object.assign(r, { deno: s.deno, denoSource: "setting" });
  else if (existsSync(managed.deno)) Object.assign(r, { deno: managed.deno, denoSource: "managed" });
  else if (existsSync(defaultDeno())) Object.assign(r, { deno: defaultDeno(), denoSource: "default" });
  return r;
}

export interface KernelEvent {
  notebook: vscode.NotebookDocument;
  lang: KernelLang;
  state: KernelState;
}

export class RuntimeHost implements vscode.Disposable {
  private runtime: Runtime | null = null;
  private wired = new WeakSet<NotebookSession>();
  readonly onKernel = new Emitter<KernelEvent>();
  readonly onShared = new Emitter<{ notebook: vscode.NotebookDocument; items: SharedItem[] }>();
  resolved: ResolvedRuntimes;

  constructor(
    private context: vscode.ExtensionContext,
    private log: vscode.LogOutputChannel,
  ) {
    this.resolved = resolveRuntimes(context.globalStorageUri);
  }

  private get(): Runtime {
    if (!this.runtime) {
      this.resolved = resolveRuntimes(this.context.globalStorageUri);
      const stateDir = path.join(this.context.globalStorageUri.fsPath, "state");
      mkdirSync(stateDir, { recursive: true });
      this.log.info(`runtimes: python=${this.resolved.python ?? "—"} (${this.resolved.pythonSource}), deno=${this.resolved.deno ?? "—"} (${this.resolved.denoSource})`);
      this.runtime = new Runtime({ python: this.resolved.python, deno: this.resolved.deno, stateDir, log: (m, level) => (level === "info" ? this.log.info(m) : this.log.warn(m)) });
    }
    return this.runtime;
  }

  /** The file a notebook's kernels belong to. Untitled notebooks live in extension storage. */
  fileOf(nb: vscode.NotebookDocument): string {
    if (nb.uri.scheme === "file") return nb.uri.fsPath;
    const name = path.basename(nb.uri.path).replace(/[^\w.-]/g, "_") || "untitled";
    const dir = path.join(this.context.globalStorageUri.fsPath, "untitled");
    mkdirSync(dir, { recursive: true });
    return path.join(dir, name.endsWith(".ipynb") ? name : `${name}.ipynb`);
  }

  /** The kernel session for a notebook (created on first use). */
  session(nb: vscode.NotebookDocument): NotebookSession {
    const s = this.get().session(this.fileOf(nb));
    if (!this.wired.has(s)) {
      this.wired.add(s);
      s.onKernelState.on(({ lang, state }) => this.onKernel.fire({ notebook: nb, lang, state }));
      s.onShared.on((items) => this.onShared.fire({ notebook: nb, items }));
    }
    return s;
  }

  /** The session if kernels were started for this notebook. */
  existing(nb: vscode.NotebookDocument): NotebookSession | undefined {
    return this.runtime?.existing(this.fileOf(nb));
  }

  async close(nb: vscode.NotebookDocument) {
    await this.runtime?.close(this.fileOf(nb));
  }

  /** Drop the runtime (e.g. after settings changed); kernels restart on next run. */
  async reset() {
    const old = this.runtime;
    this.runtime = null;
    this.resolved = resolveRuntimes(this.context.globalStorageUri);
    await old?.dispose();
  }

  dispose() {
    void this.runtime?.dispose();
    this.runtime = null;
    this.onKernel.clear();
    this.onShared.clear();
  }
}
