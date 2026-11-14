// Command implementations.

import * as vscode from "vscode";
import { readFile } from "node:fs/promises";
import { MODELS, newCellId, toIpynb, type KernelLang } from "@polyglot-tutor/core/browser";
import type { ApiKeys } from "./apiKey.ts";
import { setModel, tutorSettings } from "./config.ts";
import { NOTEBOOK_TYPE, PROMPT_LANG, cellFlags, cellId, isCodeLang, toCellData, withFlags, type CellFlags } from "./convert.ts";
import type { RuntimeHost } from "./runtimeHost.ts";
import { reopenWithTutor } from "./reopen.ts";
import { IpynbSerializer, starterNotebook } from "./serializer.ts";
import type { TutorService } from "./tutorService.ts";

export interface CommandDeps {
  context: vscode.ExtensionContext;
  keys: ApiKeys;
  host: RuntimeHost;
  tutor: TutorService;
  log: vscode.LogOutputChannel;
  setupRuntimes: () => Promise<void>;
}

const activeNotebook = () => {
  const ed = vscode.window.activeNotebookEditor;
  return ed?.notebook.notebookType === NOTEBOOK_TYPE ? ed : undefined;
};

/** The cell a command applies to: its argument, or the active cell. */
function targetCell(arg?: unknown): vscode.NotebookCell | undefined {
  if (arg && typeof arg === "object" && "notebook" in arg && "document" in arg) return arg as vscode.NotebookCell;
  const ed = activeNotebook();
  return ed ? ed.notebook.cellAt(ed.selection.start) : undefined;
}

async function setFlags(cell: vscode.NotebookCell, patch: CellFlags) {
  const edit = new vscode.WorkspaceEdit();
  edit.set(cell.notebook.uri, [vscode.NotebookEdit.updateCellMetadata(cell.index, withFlags(cell, patch))]);
  await vscode.workspace.applyEdit(edit);
}

/** Insert a cell after `index` and put the cursor in it. */
export async function insertCellAfter(nb: vscode.NotebookDocument, index: number, data: vscode.NotebookCellData, edit = true) {
  const at = Math.min(index + 1, nb.cellCount);
  const ws = new vscode.WorkspaceEdit();
  ws.set(nb.uri, [vscode.NotebookEdit.insertCells(at, [data])]);
  await vscode.workspace.applyEdit(ws);
  const ed = vscode.window.visibleNotebookEditors.find((e) => e.notebook === nb);
  if (ed) {
    ed.selection = new vscode.NotebookRange(at, at + 1);
    ed.revealRange(ed.selection);
    if (edit) await vscode.commands.executeCommand("notebook.cell.edit");
  }
}

const promptCell = (question: string) => toCellData({ id: newCellId(), type: "prompt", source: question, mode: "hint", outputs: [] });

/** Change the selected cells (or the one given) to a language, as the web app's T / Y / P keys do; a Markdown cell becomes a code cell first. */
async function setCellLanguage(language: string, arg?: unknown) {
  const ed = activeNotebook();
  const given = arg && typeof arg === "object" && "notebook" in arg && "document" in arg ? (arg as vscode.NotebookCell) : undefined;
  const nb = given?.notebook ?? ed?.notebook;
  if (!nb) return;
  const indexes = given ? [given.index] : ed!.selections.flatMap((r) => Array.from({ length: r.end - r.start }, (_, i) => r.start + i));
  for (const index of indexes) {
    if (nb.cellAt(index).kind === vscode.NotebookCellKind.Markup) {
      if (ed) ed.selection = new vscode.NotebookRange(index, index + 1);
      await vscode.commands.executeCommand("notebook.cell.changeToCode");
    }
    const cell = nb.cellAt(index);
    if (cell.document.languageId !== language) await vscode.languages.setTextDocumentLanguage(cell.document, language);
  }
}

async function openNotebook(bytes: Uint8Array) {
  const data = new IpynbSerializer().deserializeNotebook(bytes);
  const doc = await vscode.workspace.openNotebookDocument(NOTEBOOK_TYPE, data);
  await vscode.window.showNotebookDocument(doc);
}

export function registerCommands(d: CommandDeps): vscode.Disposable[] {
  const reg = (id: string, f: (...args: any[]) => unknown) => vscode.commands.registerCommand(`polyglotTutor.${id}`, f);

  const kernelAction = async (action: "interrupt" | "restart", langs: KernelLang[]) => {
    const ed = activeNotebook();
    const s = ed && d.host.existing(ed.notebook);
    if (!s) return;
    await Promise.all(langs.map((l) => (action === "interrupt" ? s.interrupt(l) : s.restart(l))));
  };

  return [
    reg("newNotebook", async () => {
      await openNotebook(new TextEncoder().encode(JSON.stringify(toIpynb(starterNotebook()))));
    }),

    reg("openWelcome", async () => {
      const uri = vscode.Uri.joinPath(d.context.extensionUri, "media", "welcome.ipynb");
      await openNotebook(await readFile(uri.fsPath));
    }),

    reg("setApiKey", () => d.keys.prompt()),
    reg("clearApiKey", () => d.keys.clear()),

    reg("insertPromptCell", async () => {
      const ed = activeNotebook();
      if (!ed) return;
      await insertCellAfter(ed.notebook, ed.selection.end - 1, promptCell(""));
    }),

    reg("cellToTypeScript", (arg?: unknown) => setCellLanguage("typescript", arg)),
    reg("cellToPython", (arg?: unknown) => setCellLanguage("python", arg)),
    reg("cellToPrompt", (arg?: unknown) => setCellLanguage(PROMPT_LANG, arg)),

    reg("kernelMenu", async (lang?: KernelLang) => {
      const langs: KernelLang[] = lang ? [lang] : ["python", "typescript"];
      const name = lang === "python" ? "Python" : lang === "typescript" ? "TypeScript" : "all";
      const pick = await vscode.window.showQuickPick(
        [
          { label: `$(debug-stop) Interrupt ${name} kernel${lang ? "" : "s"}`, action: "interrupt" as const },
          { label: `$(debug-restart) Restart ${name} kernel${lang ? "" : "s"}`, action: "restart" as const, detail: "Clears variables. Shared Delta tables stay." },
        ],
        { title: "Polyglot Tutor kernels" },
      );
      if (pick) await kernelAction(pick.action, langs);
    }),
    reg("restartKernels", () => kernelAction("restart", ["python", "typescript"])),
    reg("interruptKernels", () => kernelAction("interrupt", ["python", "typescript"])),

    reg("keepWarm", async () => {
      const ed = activeNotebook();
      if (!ed) return;
      try {
        const ok = await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: "Keeping the prompt cache warm" }, () => d.tutor.keepWarm(ed.notebook));
        if (!ok) vscode.window.showInformationMessage("Nothing cached yet: ask the tutor a question first.");
      } catch (e) {
        vscode.window.showErrorMessage(`Keep warm failed: ${d.tutor.describeError(e)}`);
      }
    }),

    reg("selectModel", async () => {
      const current = tutorSettings().model;
      const pick = await vscode.window.showQuickPick(
        MODELS.map((m) => ({
          label: `${m.id === current ? "$(check) " : ""}${m.label}`,
          description: `$${m.inputPerMTok} / $${m.outputPerMTok} per million tokens`,
          id: m.id,
        })),
        { title: "Tutor model" },
      );
      if (pick) await setModel(pick.id);
    }),

    reg("toggleMode", async (arg?: unknown) => {
      const cell = targetCell(arg);
      if (cell?.document.languageId === PROMPT_LANG) await setFlags(cell, { mode: cellFlags(cell).mode === "answer" ? "hint" : "answer" });
    }),
    reg("toggleHidden", async (arg?: unknown) => {
      const cell = targetCell(arg);
      if (cell) await setFlags(cell, { hidden: !cellFlags(cell).hidden });
    }),
    reg("togglePinned", async (arg?: unknown) => {
      const cell = targetCell(arg);
      if (cell) await setFlags(cell, { pinned: !cellFlags(cell).pinned });
    }),

    reg("askAboutError", async (arg?: unknown, kind?: "type" | "run") => {
      const cell = targetCell(arg);
      if (!cell) return;
      const typeError = kind === "type" || (kind === undefined && cell.executionSummary?.success !== false);
      const question = typeError ? `What does the type error in cell ${cell.index + 1} mean?` : `Why did cell ${cell.index + 1} fail?`;
      await insertCellAfter(cell.notebook, cell.index, promptCell(question));
    }),

    reg("reopenWithTutor", async (arg?: vscode.Uri) => {
      const uri = arg instanceof vscode.Uri ? arg : vscode.window.activeNotebookEditor?.notebook.uri;
      if (uri) await reopenWithTutor(uri);
    }),

    reg("setupRuntimes", () => d.setupRuntimes()),
    reg("showLog", () => d.log.show()),
  ];
}

/** Insert a code block from an answer as a new cell below its prompt cell. */
export async function insertFromAnswer(editor: vscode.NotebookEditor, promptCellId: string, code: string, lang: string) {
  const nb = editor.notebook;
  const cell = nb.getCells().find((c) => cellId(c) === promptCellId);
  const data = new vscode.NotebookCellData(vscode.NotebookCellKind.Code, code, isCodeLang(lang) ? lang : "python");
  data.metadata = { id: newCellId(), polyglot: {} };
  await insertCellAfter(nb, cell ? cell.index : nb.cellCount - 1, data, false);
}
