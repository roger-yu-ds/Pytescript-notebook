// The notebook controller ("kernel"): runs Python / TypeScript / SQL cells on
// the core runtime and answers prompt cells with the tutor.

import * as vscode from "vscode";
import { RuntimeUnavailableError, type Output } from "@polyglot-tutor/core";
import { NOTEBOOK_TYPE, PROMPT_LANG, answerItems, answerOutput, cellFlags, cellId, isCodeLang, toVsOutput, type Answer } from "./convert.ts";
import type { RuntimeHost } from "./runtimeHost.ts";
import type { TutorService } from "./tutorService.ts";

const STREAM_THROTTLE_MS = 80;

export class TutorController implements vscode.Disposable {
  private readonly controller: vscode.NotebookController;
  private asks = new Map<string, AbortController>(); // notebook uri → running ask
  private warnedRuntime = new Set<string>();

  constructor(
    private host: RuntimeHost,
    private tutor: TutorService,
    private log?: vscode.LogOutputChannel,
  ) {
    this.controller = vscode.notebooks.createNotebookController("polyglot-tutor-kernel", NOTEBOOK_TYPE, "Polyglot Tutor");
    this.controller.supportedLanguages = ["python", "typescript", "sql", PROMPT_LANG];
    this.controller.supportsExecutionOrder = true;
    this.controller.description = "Python · TypeScript (Deno) · SQL (DuckDB) · Tutor";
    this.controller.executeHandler = (cells, nb) => this.execute(cells, nb);
    this.controller.interruptHandler = (nb) => this.interrupt(nb);
  }

  private async execute(cells: vscode.NotebookCell[], _nb: vscode.NotebookDocument) {
    // Run All (or any multi-cell run) skips prompt cells: each would bill the API key for a question the learner didn't just ask.
    if (cells.length > 1 && cells.some((c) => c.document.languageId === PROMPT_LANG)) {
      cells = cells.filter((c) => c.document.languageId !== PROMPT_LANG);
      vscode.window.setStatusBarMessage("$(info) Polyglot Tutor: prompt cells are skipped by Run All. Run them one at a time.", 8000);
    }
    for (const cell of cells) {
      const ok = cell.document.languageId === PROMPT_LANG ? await this.ask(cell) : await this.run(cell);
      if (!ok) break; // like Jupyter: stop "run all" at the first failure
    }
  }

  // ---------- code cells ----------

  private async run(cell: vscode.NotebookCell): Promise<boolean> {
    const exec = this.controller.createNotebookCellExecution(cell);
    exec.start(Date.now());
    await exec.clearOutput();
    const lang = cell.document.languageId;
    if (!isCodeLang(lang)) {
      await exec.replaceOutput([toVsOutput({ kind: "error", ename: "UnsupportedLanguage", evalue: `Polyglot Tutor runs Python, TypeScript, SQL and Tutor Prompt cells, not ${lang}.`, traceback: [] })]);
      exec.end(false, Date.now());
      return false;
    }

    // Kernel output arrives as events; apply it to the cell in order.
    let chain: Thenable<unknown> = Promise.resolve();
    const queue = (f: () => Thenable<unknown>) => (chain = chain.then(f, f));
    let last: { output: vscode.NotebookCellOutput; stream?: "stdout" | "stderr" } | null = null;
    const onOutput = (o: Output) =>
      queue(() => {
        if (o.kind === "stream" && last?.stream === o.name) {
          const item = o.name === "stderr" ? vscode.NotebookCellOutputItem.stderr(o.text) : vscode.NotebookCellOutputItem.stdout(o.text);
          return exec.appendOutputItems(item, last.output);
        }
        const output = toVsOutput(o);
        last = { output, stream: o.kind === "stream" ? o.name : undefined };
        return exec.appendOutput(output);
      });
    const onClear = () =>
      queue(() => {
        last = null;
        return exec.clearOutput();
      });

    try {
      const r = await this.host.session(cell.notebook).run(lang, cell.document.getText(), onOutput, onClear);
      await chain;
      if (r.executionCount != null) exec.executionOrder = r.executionCount;
      exec.end(r.ok, Date.now());
      return r.ok;
    } catch (e) {
      await chain;
      const evalue = e instanceof RuntimeUnavailableError ? this.runtimeHelp(e) : this.tutor.describeError(e);
      await exec.appendOutput(toVsOutput({ kind: "error", ename: "KernelError", evalue, traceback: [] }));
      exec.end(false, Date.now());
      return false;
    }
  }

  private runtimeHelp(e: RuntimeUnavailableError): string {
    const what = e.lang === "python" ? "Python (with Jupyter, pandas and DuckDB)" : "Deno";
    const setting = e.lang === "python" ? "polyglotTutor.pythonPath" : "polyglotTutor.denoPath";
    if (!this.warnedRuntime.has(e.lang)) {
      this.warnedRuntime.add(e.lang);
      void vscode.window
        .showWarningMessage(`Polyglot Tutor needs ${what} to run ${e.lang === "python" ? "Python and SQL" : "TypeScript"} cells.`, "Set Up Runtimes", "Open Settings")
        .then((choice) => {
          if (choice === "Set Up Runtimes") void vscode.commands.executeCommand("polyglotTutor.setupRuntimes");
          if (choice === "Open Settings") void vscode.commands.executeCommand("workbench.action.openSettings", setting);
        });
    }
    return `${what} isn't set up. Run "Polyglot Tutor: Set Up Runtimes" from the Command Palette, or set ${setting}.`;
  }

  // ---------- prompt cells ----------

  private async ask(cell: vscode.NotebookCell): Promise<boolean> {
    const exec = this.controller.createNotebookCellExecution(cell);
    const key = cell.notebook.uri.toString();
    const abort = new AbortController();
    this.asks.get(key)?.abort();
    this.asks.set(key, abort);
    exec.token.onCancellationRequested(() => abort.abort());
    exec.start(Date.now());

    const answer: Answer = { cellId: cellId(cell), response: "", mode: cellFlags(cell).mode ?? "hint", status: "streaming" };
    const output = answerOutput(answer);
    await exec.replaceOutput([output]);

    // Stream into the output, at most every STREAM_THROTTLE_MS.
    let timer: ReturnType<typeof setTimeout> | null = null;
    let pending: Thenable<void> = Promise.resolve();
    const flush = () => {
      timer = null;
      pending = exec.replaceOutputItems(answerItems(answer), output);
    };
    const schedule = () => (timer ??= setTimeout(flush, STREAM_THROTTLE_MS));

    try {
      if (!cell.document.getText().trim()) throw new Error("Type a question first.");
      const r = await this.tutor.ask(
        cell,
        answer.mode,
        {
          onText: (t) => ((answer.response += t), schedule()),
          onThinking: (t) => ((answer.thinking = (answer.thinking ?? "") + t), schedule()),
        },
        abort.signal,
      );
      Object.assign(answer, { status: "done", usage: r.usage });
      if (timer) clearTimeout(timer);
      await pending;
      await exec.replaceOutputItems(answerItems(answer), output);
      exec.end(true, Date.now());
      return true;
    } catch (e) {
      if (timer) clearTimeout(timer);
      await pending;
      const message = abort.signal.aborted ? "Stopped." : this.tutor.describeError(e);
      if (!abort.signal.aborted) this.log?.error(`[tutor] ${message}`, e);
      Object.assign(answer, { status: "error", error: message });
      await exec.replaceOutputItems(answerItems(answer), output);
      exec.end(false, Date.now());
      if (/API key/i.test(message) && !abort.signal.aborted) {
        void vscode.window.showErrorMessage(message, "Set API Key").then((c) => c && vscode.commands.executeCommand("polyglotTutor.setApiKey"));
      }
      return false;
    } finally {
      if (this.asks.get(key) === abort) this.asks.delete(key);
    }
  }

  private async interrupt(nb: vscode.NotebookDocument) {
    this.asks.get(nb.uri.toString())?.abort();
    const s = this.host.existing(nb);
    if (s) await Promise.all([s.interrupt("python"), s.interrupt("typescript")]);
  }

  dispose() {
    for (const a of this.asks.values()) a.abort();
    this.controller.dispose();
  }
}
