// Per-notebook UI state: kernel states, shared values, and the prompt cache
// (one per model). Cache info survives window reloads via workspaceState.

import * as vscode from "vscode";
import type { CacheInfo, KernelLang, KernelState, SharedItem } from "@polyglot-tutor/core/browser";

export interface NotebookUiState {
  kernels: Record<KernelLang, KernelState>;
  shared: SharedItem[];
  cache: Record<string, CacheInfo>; // by model
}

const CACHE_KEY = "polyglotTutor.cache";

export class NotebookStates implements vscode.Disposable {
  private states = new Map<string, NotebookUiState>();
  private changed = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.changed.event;

  constructor(private memento: vscode.Memento) {}

  get(uri: vscode.Uri): NotebookUiState {
    const key = uri.toString();
    let s = this.states.get(key);
    if (!s) {
      const saved = this.memento.get<Record<string, Record<string, CacheInfo>>>(CACHE_KEY, {})[key] ?? {};
      s = { kernels: { python: "off", typescript: "off" }, shared: [], cache: saved };
      this.states.set(key, s);
    }
    return s;
  }

  setKernel(uri: vscode.Uri, lang: KernelLang, state: KernelState) {
    this.get(uri).kernels[lang] = state;
    this.changed.fire(uri);
  }

  setShared(uri: vscode.Uri, items: SharedItem[]) {
    this.get(uri).shared = items;
    this.changed.fire(uri);
  }

  setCache(uri: vscode.Uri, info: CacheInfo) {
    const s = this.get(uri);
    s.cache[info.model] = info;
    // Persist only caches that are still warm, so workspace state doesn't grow forever.
    const now = Date.now();
    const all: Record<string, Record<string, CacheInfo>> = {};
    for (const [key, byModel] of Object.entries({ ...this.memento.get<Record<string, Record<string, CacheInfo>>>(CACHE_KEY, {}), [uri.toString()]: s.cache })) {
      const warm = Object.fromEntries(Object.entries(byModel).filter(([, c]) => c.startedAt + c.ttlMs > now));
      if (Object.keys(warm).length) all[key] = warm;
    }
    void this.memento.update(CACHE_KEY, all);
    this.changed.fire(uri);
  }

  /** Kernels stopped (notebook closed or runtimes reset). */
  resetKernels(uri?: vscode.Uri) {
    for (const [key, s] of this.states) {
      if (uri && key !== uri.toString()) continue;
      s.kernels = { python: "off", typescript: "off" };
      s.shared = [];
      this.changed.fire(vscode.Uri.parse(key));
    }
  }

  dispose() {
    this.changed.dispose();
  }
}
