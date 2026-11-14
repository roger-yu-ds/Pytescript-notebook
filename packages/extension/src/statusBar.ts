// Status bar items for the active Polyglot Tutor notebook:
//   left:  Python / TypeScript kernel state
//   right: model · context ring · prompt-cache countdown (deliberately quiet)

import * as vscode from "vscode";
import {
  cacheTimeLeft,
  describeEstimate,
  estimateContext,
  formatCountdown,
  modelInfo,
  staleFrom,
  toContextCells,
  type KernelLang,
  type KernelState,
} from "@polyglot-tutor/core/browser";
import { affectsTutor, tutorSettings } from "./config.ts";
import { NOTEBOOK_TYPE, fromCell } from "./convert.ts";
import type { NotebookStates } from "./notebookState.ts";

const KERNEL_ICON: Record<KernelState, string> = {
  off: "$(circle-outline)",
  starting: "$(sync~spin)",
  idle: "$(circle-filled)",
  busy: "$(loading~spin)",
  dead: "$(error)",
};
const LABEL: Record<KernelLang, string> = { python: "Python", typescript: "TypeScript" };

/** Ring glyphs from our icon font, one per eighth (see media/ring-font). */
export const ringIcon = (fraction: number) => `$(polyglot-ring-${Math.max(0, Math.min(8, Math.round(fraction * 8)))})`;

export class StatusBar implements vscode.Disposable {
  private kernels: Record<KernelLang, vscode.StatusBarItem>;
  private model = vscode.window.createStatusBarItem("polyglotTutor.model", vscode.StatusBarAlignment.Right, 103);
  private ring = vscode.window.createStatusBarItem("polyglotTutor.context", vscode.StatusBarAlignment.Right, 102);
  private cache = vscode.window.createStatusBarItem("polyglotTutor.cache", vscode.StatusBarAlignment.Right, 101);
  private disposables: vscode.Disposable[] = [];
  private ticker: ReturnType<typeof setInterval>;
  private ringTimer: ReturnType<typeof setTimeout> | null = null;
  /** First edited cell inside the cached prefix (recomputed when the notebook changes, not every tick). */
  private stale: number | null = null;

  constructor(private states: NotebookStates) {
    const kernel = (lang: KernelLang, priority: number) => {
      const item = vscode.window.createStatusBarItem(`polyglotTutor.kernel.${lang}`, vscode.StatusBarAlignment.Left, priority);
      item.name = `Polyglot Tutor: ${LABEL[lang]} kernel`;
      item.command = { title: "Kernel actions", command: "polyglotTutor.kernelMenu", arguments: [lang] };
      return item;
    };
    this.kernels = { python: kernel("python", 50), typescript: kernel("typescript", 49) };
    this.model.name = "Polyglot Tutor: model";
    this.model.command = "polyglotTutor.selectModel";
    this.ring.name = "Polyglot Tutor: context";
    this.cache.name = "Polyglot Tutor: prompt cache";
    this.cache.command = "polyglotTutor.keepWarm";

    this.disposables.push(
      vscode.window.onDidChangeActiveNotebookEditor(() => this.refresh()),
      states.onDidChange((uri) => uri.toString() === this.active()?.uri.toString() && this.refresh()),
      vscode.workspace.onDidChangeNotebookDocument((e) => e.notebook === this.active() && this.refreshRingSoon()),
      vscode.workspace.onDidChangeConfiguration((e) => affectsTutor(e) && this.refresh()),
    );
    this.ticker = setInterval(() => this.renderCache(), 1000);
    this.refresh();
  }

  private active(): vscode.NotebookDocument | undefined {
    const nb = vscode.window.activeNotebookEditor?.notebook;
    return nb?.notebookType === NOTEBOOK_TYPE ? nb : undefined;
  }

  private all() {
    return [this.kernels.python, this.kernels.typescript, this.model, this.ring, this.cache];
  }

  refresh() {
    const nb = this.active();
    if (!nb) {
      for (const i of this.all()) i.hide();
      return;
    }
    const state = this.states.get(nb.uri);
    for (const lang of ["python", "typescript"] as const) {
      const item = this.kernels[lang];
      const s = state.kernels[lang];
      item.text = `${KERNEL_ICON[s]} ${LABEL[lang]}`;
      item.tooltip = `${LABEL[lang]} kernel: ${s}${lang === "python" ? " (also runs SQL cells)" : ""}. Click to interrupt or restart.`;
      item.show();
    }
    const settings = tutorSettings();
    this.model.text = `$(sparkle) ${modelInfo(settings.model).label}`;
    this.model.tooltip = "Tutor model. Click to change.";
    this.model.show();
    this.recompute();
  }

  private refreshRingSoon() {
    if (this.ringTimer) clearTimeout(this.ringTimer);
    this.ringTimer = setTimeout(() => this.recompute(), 300);
  }

  /** Re-derive the context estimate and cache staleness from the notebook's cells. */
  private recompute() {
    const nb = this.active();
    if (!nb) return;
    const settings = tutorSettings();
    const cells = nb.getCells().map(fromCell);
    const cache = this.states.get(nb.uri).cache[settings.model];
    this.stale = cache ? staleFrom(cells, cache) : null;
    const e = estimateContext(toContextCells(cells), settings);
    const fraction = Math.min(1, e.tokens / e.budget);
    this.ring.text = `${ringIcon(fraction)} ${Math.round(fraction * 100)}%`;
    this.ring.tooltip = new vscode.MarkdownString(describeEstimate(e).map((l) => l || " ").join("  \n"));
    this.ring.color = fraction >= 0.9 ? new vscode.ThemeColor("editorWarning.foreground") : undefined;
    this.ring.show();
    this.renderCache();
  }

  /** The countdown: muted, coloured only when it needs attention. */
  private renderCache() {
    const nb = this.active();
    if (!nb) return;
    const settings = tutorSettings();
    const label = modelInfo(settings.model).label;
    const cache = this.states.get(nb.uri).cache[settings.model];
    this.cache.color = undefined;
    if (!cache) {
      this.cache.text = "cache —";
      this.cache.tooltip = `No ${label} prompt cache yet. Ask a question to create one (needs ~512+ tokens of context).`;
      this.cache.show();
      return;
    }
    const left = cacheTimeLeft(cache);
    const detail = `${label} prompt cache · ${cache.cells.length} cells · last request: ${cache.readTokens.toLocaleString()} tokens read, ${cache.writeTokens.toLocaleString()} written`;
    if (left <= 0) {
      this.cache.text = "cache cold";
      this.cache.tooltip = `${detail}\nExpired: the next question re-writes the cache (2× input price once).`;
    } else {
      const stale = this.stale;
      if (stale !== null) {
        this.cache.text = `cache stale from cell ${stale}`;
        this.cache.tooltip = `${detail}\nYou edited cell ${stale}, which is inside the cached context. Cells from there on will be re-sent at full price on the next question.`;
        this.cache.color = new vscode.ThemeColor("editorWarning.foreground");
      } else {
        this.cache.text = `cache ${formatCountdown(left)}`;
        this.cache.tooltip = `${detail}\nTime until the cache expires. Every question that reuses it resets the timer. Click to keep it warm (re-reads the cache without generating an answer).`;
        if (left < Math.min(5 * 60_000, cache.ttlMs / 5)) this.cache.color = new vscode.ThemeColor("editorWarning.foreground");
      }
    }
    this.cache.show();
  }

  dispose() {
    clearInterval(this.ticker);
    if (this.ringTimer) clearTimeout(this.ringTimer);
    for (const d of [...this.disposables, ...this.all()]) d.dispose();
  }
}
