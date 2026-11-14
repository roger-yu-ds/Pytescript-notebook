// Integration tests: run inside a real VS Code with the extension loaded,
// real Jupyter/Deno kernels and a mock Anthropic API.

import * as assert from "node:assert/strict";
import { cpSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import * as vscode from "vscode";
import { test, runAll, until } from "./harness.ts";

const ANSWER_MIME = "application/vnd.polyglot-tutor.answer+json";
const ws = () => vscode.workspace.workspaceFolders![0].uri.fsPath;
const dec = new TextDecoder();
const mockRequests = () =>
  existsSync(process.env.MOCK_LOG!) ? readFileSync(process.env.MOCK_LOG!, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];

/** An .ipynb in the web app's format. */
function ipynb(cells: { type: "markdown" | "code" | "prompt"; lang?: string; source: string; mode?: string }[]) {
  return {
    nbformat: 4,
    nbformat_minor: 5,
    metadata: { kernelspec: { name: "python3", display_name: "Python 3", language: "python" }, language_info: { name: "python", file_extension: ".py" }, polyglot: { version: 1 } },
    cells: cells.map((c, i) =>
      c.type === "prompt"
        ? { id: `p${i}`, cell_type: "markdown", metadata: { polyglot: { type: "prompt", question: c.source, response: "", mode: c.mode ?? "hint" } }, source: [`**🧑 Prompt (hint):** ${c.source}\n\n---\n\n`] }
        : c.type === "code"
          ? { id: `c${i}`, cell_type: "code", metadata: { polyglot: { lang: c.lang } }, execution_count: null, outputs: [], source: [c.source] }
          : { id: `m${i}`, cell_type: "markdown", metadata: { polyglot: {} }, source: [c.source] },
    ),
  };
}

async function openWithTutor(name: string, content: object): Promise<vscode.NotebookEditor> {
  const file = path.join(ws(), name);
  writeFileSync(file, JSON.stringify(content, null, 1) + "\n");
  await vscode.commands.executeCommand("vscode.openWith", vscode.Uri.file(file), "polyglot-tutor");
  return until(() => {
    const ed = vscode.window.activeNotebookEditor;
    return ed?.notebook.uri.fsPath === file && ed.notebook.notebookType === "polyglot-tutor" ? ed : undefined;
  }, `${name} to open with Polyglot Tutor`);
}

async function runCell(nb: vscode.NotebookDocument, index: number) {
  await vscode.commands.executeCommand("notebook.cell.execute", { ranges: [{ start: index, end: index + 1 }], document: nb.uri });
  const cell = nb.cellAt(index);
  await until(() => cell.executionSummary?.success !== undefined && cell.executionSummary?.timing?.endTime, `cell ${index + 1} to finish`, 120_000);
  return cell;
}

const text = (cell: vscode.NotebookCell) =>
  cell.outputs
    .flatMap((o) => o.items)
    .map((i) => (i.mime.startsWith("image/") ? `[${i.mime}]` : dec.decode(i.data)))
    .join("\n");

const answerOf = (cell: vscode.NotebookCell) => {
  const item = cell.outputs.flatMap((o) => o.items).find((i) => i.mime === ANSWER_MIME);
  return item ? JSON.parse(dec.decode(item.data)) : null;
};

const api = () => vscode.extensions.getExtension("roger-yu-ds.polyglot-tutor")!.exports;
let smoke: vscode.NotebookEditor;

test("opens .ipynb files with Polyglot Tutor and maps cell kinds and languages", async () => {
  smoke = await openWithTutor(
    "smoke.ipynb",
    ipynb([
      { type: "markdown", source: "# Smoke" },
      { type: "code", lang: "python", source: "import pandas as pd\nsales = pd.DataFrame({'region': ['n', 's', 'n'], 'amt': [1, 2, 3]})\nprint('hi from python')" },
      { type: "code", lang: "typescript", source: "const greet = (n: string): string => `hello ${n}`;\nconsole.log(greet('deno'));" },
      { type: "code", lang: "sql", source: "-- as: by_region\nselect region, sum(amt) as total from sales group by region order by region" },
      { type: "code", lang: "typescript", source: "const rows = await get<{ region: string; total: number }[]>('by_region');\nconsole.log(rows.map((r) => `${r.region}=${r.total}`).join(','));\nawait share('ts_rows', [{ a: 1 }, { a: 2 }], { persist: true });" },
      { type: "code", lang: "python", source: "print(int(get('ts_rows')['a'].sum()))" },
      { type: "code", lang: "python", source: "1/0" },
      { type: "prompt", source: "Why does cell 7 fail?" },
    ]),
  );
  const nb = smoke.notebook;
  assert.equal(nb.cellCount, 8);
  assert.equal(nb.cellAt(0).kind, vscode.NotebookCellKind.Markup);
  assert.deepEqual(
    nb.getCells().slice(1).map((c) => c.document.languageId),
    ["python", "typescript", "sql", "typescript", "python", "python", "tutor-prompt"],
  );
});

test("runs Python", async () => {
  const cell = await runCell(smoke.notebook, 1);
  assert.equal(cell.executionSummary?.success, true, text(cell));
  assert.match(text(cell), /hi from python/);
  assert.ok((cell.executionSummary?.executionOrder ?? 0) >= 1);
});

test("runs TypeScript on Deno", async () => {
  const cell = await runCell(smoke.notebook, 2);
  assert.equal(cell.executionSummary?.success, true, text(cell));
  assert.match(text(cell), /hello deno/);
});

test("runs SQL on DuckDB over a Python DataFrame, and shares the result", async () => {
  const cell = await runCell(smoke.notebook, 3);
  assert.equal(cell.executionSummary?.success, true, text(cell));
  assert.match(text(cell), /total/);
  const t = await runCell(smoke.notebook, 4);
  assert.equal(t.executionSummary?.success, true, text(t));
  assert.match(text(t), /n=4,s=2/);
});

test("share/get across languages, with Delta persistence next to the notebook", async () => {
  const cell = await runCell(smoke.notebook, 5);
  assert.equal(cell.executionSummary?.success, true, text(cell));
  assert.match(text(cell), /^3/m);
  assert.ok(existsSync(path.join(ws(), ".data", "smoke", "ts_rows", "_delta_log")), "Delta table written under .data/smoke/");
});

test("shared values (and Delta tables from earlier sessions) are listed for the notebook", async () => {
  const items = api().states.get(smoke.notebook.uri).shared;
  const names = items.map((i: any) => i.name);
  assert.ok(names.includes("by_region") && names.includes("ts_rows"), names.join(","));
  assert.equal(items.find((i: any) => i.name === "ts_rows").persisted, true);
  // Opening a notebook lists its Delta tables from earlier sessions before any kernel starts.
  cpSync(path.join(ws(), ".data", "smoke"), path.join(ws(), ".data", "again"), { recursive: true });
  const again = await openWithTutor("again.ipynb", ipynb([{ type: "markdown", source: "# again" }]));
  const listed = await until(() => api().states.get(again.notebook.uri).shared.find((i: any) => i.name === "ts_rows"), "persisted table listed");
  assert.equal(listed.persisted, true);
  assert.equal(api().states.get(again.notebook.uri).kernels.python, "off");
  await vscode.window.showNotebookDocument(smoke.notebook);
});

test("errors fail the cell; 'Ask about this error' inserts a prompt cell", async () => {
  const nb = smoke.notebook;
  const cell = await runCell(nb, 6);
  assert.equal(cell.executionSummary?.success, false);
  assert.match(text(cell), /ZeroDivisionError/);
  await vscode.commands.executeCommand("polyglotTutor.askAboutError", cell);
  const inserted = nb.cellAt(7);
  assert.equal(inserted.document.languageId, "tutor-prompt");
  assert.equal(inserted.document.getText(), "Why did cell 7 fail?");
  // Remove it again to keep the layout predictable.
  const edit = new vscode.WorkspaceEdit();
  edit.set(nb.uri, [vscode.NotebookEdit.deleteCells(new vscode.NotebookRange(7, 8))]);
  await vscode.workspace.applyEdit(edit);
});

test("prompt cells stream the tutor's answer with the cells above as context", async () => {
  const nb = smoke.notebook;
  const before = mockRequests().length;
  const cell = await runCell(nb, 7);
  assert.equal(cell.executionSummary?.success, true, JSON.stringify(answerOf(cell)));
  const answer = answerOf(cell);
  assert.equal(answer.status, "done");
  assert.match(answer.response, /cell 2/);
  assert.ok(answer.usage?.costUsd > 0);
  assert.equal(answer.cellId, "p7");
  const req = mockRequests().slice(before).find((r) => r.body.stream)!.body;
  const content: { text?: string }[] = req.messages[0].content;
  assert.match(content.at(-1)!.text!, /<learner_question mode="hint">\nWhy does cell 7 fail\?/);
  assert.ok(content.some((b) => /ZeroDivisionError/.test(b.text ?? "")), "error output is in the context");
  assert.ok(content.some((b) => /index="3" type="code" lang="typescript"/.test(b.text ?? "")));
  assert.equal(req.model, "claude-sonnet-5-5");
});

test("the prompt cache is recorded and keep-warm re-reads it", async () => {
  const cache = api().states.get(smoke.notebook.uri).cache["claude-sonnet-5-5"];
  assert.ok(cache, "cache info recorded");
  assert.equal(cache.ttlMs, 3_600_000);
  const before = mockRequests().length;
  await vscode.commands.executeCommand("polyglotTutor.keepWarm");
  const warm = mockRequests().slice(before);
  assert.equal(warm.length, 1);
  assert.equal(warm[0].body.max_tokens, 0);
});

test("Hint/Answer toggle and 🙈/📌 flags are saved in the web app's format", async () => {
  const nb = smoke.notebook;
  await vscode.commands.executeCommand("polyglotTutor.toggleMode", nb.cellAt(7));
  await vscode.commands.executeCommand("polyglotTutor.toggleHidden", nb.cellAt(6));
  await vscode.commands.executeCommand("polyglotTutor.togglePinned", nb.cellAt(1));
  await nb.save();
  const saved = JSON.parse(readFileSync(nb.uri.fsPath, "utf8"));
  const prompt = saved.cells[7];
  assert.equal(prompt.cell_type, "markdown");
  assert.equal(prompt.metadata.polyglot.type, "prompt");
  assert.equal(prompt.metadata.polyglot.mode, "answer");
  assert.match(prompt.metadata.polyglot.response, /cell 2/);
  assert.equal(saved.cells[6].metadata.polyglot.hidden, true);
  assert.equal(saved.cells[1].metadata.polyglot.pinned, true);
  assert.equal(saved.cells[3].metadata.polyglot.lang, "sql");
  assert.match(saved.cells[1].outputs.map((o: any) => o.text?.join?.("") ?? "").join(""), /hi from python/);
  assert.equal(saved.cells[6].outputs[0].output_type, "error");
});

test("hidden cells are left out of the tutor's context", async () => {
  const nb = smoke.notebook;
  const before = mockRequests().length;
  await runCell(nb, 7);
  const req = mockRequests().slice(before).find((r) => r.body.stream)!.body;
  const texts: string[] = req.messages[0].content.map((b: any) => b.text ?? "");
  assert.ok(!texts.some((t) => /index="7"/.test(t)), "cell 7 (hidden) not sent");
  assert.match(texts.at(-1)!, /mode="answer"/);
});

test("a saved notebook reopens identically (outputs, answers, flags)", async () => {
  const file = smoke.notebook.uri.fsPath;
  const first = readFileSync(file, "utf8");
  await vscode.commands.executeCommand("workbench.action.closeActiveEditor");
  const ed = await openWithTutor("copy.ipynb", JSON.parse(first));
  await ed.notebook.save();
  // A no-op save must not change anything (ids, outputs, answers, metadata).
  const a = JSON.parse(first);
  const b = JSON.parse(readFileSync(ed.notebook.uri.fsPath, "utf8"));
  assert.deepEqual(b.cells, a.cells);
  await vscode.commands.executeCommand("workbench.action.closeActiveEditor");
});

test("Python missing: cells explain how to set it up", async () => {
  const cfg = vscode.workspace.getConfiguration("polyglotTutor");
  const original = cfg.get<string>("pythonPath");
  await cfg.update("pythonPath", "", vscode.ConfigurationTarget.Workspace);
  try {
    const ed = await openWithTutor("nopython.ipynb", ipynb([{ type: "code", lang: "python", source: "print(1)" }]));
    const cell = await runCell(ed.notebook, 0);
    assert.equal(cell.executionSummary?.success, false);
    assert.match(text(cell), /isn't set up.*Set Up Runtimes/s);
  } finally {
    await cfg.update("pythonPath", original, vscode.ConfigurationTarget.Workspace);
  }
});

test("New Notebook and Welcome Tour commands open Polyglot Tutor notebooks", async () => {
  await vscode.commands.executeCommand("polyglotTutor.newNotebook");
  let nb = await until(() => vscode.window.activeNotebookEditor?.notebook, "new notebook");
  assert.equal(nb.notebookType, "polyglot-tutor");
  assert.equal(nb.isUntitled, true);
  await vscode.commands.executeCommand("polyglotTutor.openWelcome");
  nb = await until(() => (vscode.window.activeNotebookEditor?.notebook.cellCount === 17 ? vscode.window.activeNotebookEditor.notebook : undefined), "welcome tour");
  assert.equal(nb.cellAt(2).document.languageId, "typescript");
  assert.equal(nb.cellAt(4).document.languageId, "tutor-prompt");
});

test("Insert prompt cell command adds a tutor-prompt cell below the selection", async () => {
  const ed = await openWithTutor("insert.ipynb", ipynb([{ type: "markdown", source: "# x" }]));
  ed.selection = new vscode.NotebookRange(0, 1);
  await vscode.commands.executeCommand("polyglotTutor.insertPromptCell");
  await until(() => ed.notebook.cellCount === 2, "inserted cell");
  assert.equal(ed.notebook.cellAt(1).document.languageId, "tutor-prompt");
});

test("the T / Y / P commands change the selected cells' language, turning a Markdown cell into code first, and the change is saved", async () => {
  const ed = await openWithTutor(
    "celltype.ipynb",
    ipynb([
      { type: "markdown", source: "# notes" },
      { type: "code", lang: "python", source: "print(1)" },
      { type: "code", lang: "typescript", source: "console.log(2);" },
      { type: "code", lang: "sql", source: "select 1" },
    ]),
  );
  const nb = ed.notebook;
  const language = (i: number) => nb.cellAt(i).document.languageId;
  const run = async (command: string, from: number, to = from + 1) => {
    ed.selection = new vscode.NotebookRange(from, to);
    await vscode.commands.executeCommand(command);
  };

  await run("polyglotTutor.cellToTypeScript", 1);
  assert.equal(language(1), "typescript");
  await run("polyglotTutor.cellToPython", 2);
  assert.equal(language(2), "python");
  await run("polyglotTutor.cellToPrompt", 3);
  assert.equal(language(3), "tutor-prompt");
  assert.equal(nb.cellAt(3).kind, vscode.NotebookCellKind.Code, "a prompt cell is a code cell with the prompt language");

  await run("polyglotTutor.cellToPython", 0);
  assert.equal(nb.cellAt(0).kind, vscode.NotebookCellKind.Code, "a Markdown cell becomes code first");
  assert.equal(language(0), "python");
  assert.equal(nb.cellAt(0).document.getText(), "# notes", "and keeps its text");

  await run("polyglotTutor.cellToTypeScript", 0, 3); // a multi-cell selection changes every cell in it
  assert.deepEqual([0, 1, 2].map(language), ["typescript", "typescript", "typescript"]);
  assert.equal(language(3), "tutor-prompt", "cells outside the selection are untouched");

  await nb.save();
  const saved = JSON.parse(readFileSync(nb.uri.fsPath, "utf8"));
  assert.deepEqual(saved.cells.slice(0, 3).map((c: any) => [c.cell_type, c.metadata.polyglot.lang]), [["code", "typescript"], ["code", "typescript"], ["code", "typescript"]]);
  assert.equal(saved.cells[3].metadata.polyglot.type, "prompt");
});

const ourDiagnostics = (cell: vscode.NotebookCell) => vscode.languages.getDiagnostics(cell.document.uri).filter((d) => d.source === "Polyglot Tutor (TypeScript)");

let typed: vscode.NotebookEditor;

test("TypeScript cells are type-checked across cells, with Deno and share/get types", async () => {
  await api().denoTypesReady();
  typed = await openWithTutor(
    "typed.ipynb",
    ipynb([
      { type: "code", lang: "typescript", source: "interface User { name: string; age: number }\nconst ada: User = { name: 'Ada', age: '36' };" },
      { type: "code", lang: "typescript", source: "const later = ada.age + 1;\nconst text = Deno.readTextFileSync('x');\nconst n = await get<number>('n');\nn.toFixed(1);" },
      { type: "code", lang: "typescript", source: "notDefinedAnywhere();\nDeno.noSuchApi();" },
      { type: "prompt", source: "What is wrong in cell 1?" },
    ]),
  );
  const [c1, c2, c3] = typed.notebook.getCells();
  const d1 = await until(() => (ourDiagnostics(c1).length ? ourDiagnostics(c1) : undefined), "type error on cell 1");
  assert.match(d1[0].message, /'string' is not assignable to type 'number'/);
  assert.equal(d1[0].range.start.line, 1);
  await until(() => ourDiagnostics(c3).length === 2, "two errors on cell 3");
  assert.deepEqual(ourDiagnostics(c2).map((d) => d.message), [], "cross-cell globals, Deno APIs and get<T>() all resolve");
  assert.match(ourDiagnostics(c3).map((d) => d.message).join("\n"), /notDefinedAnywhere[\s\S]*noSuchApi/);
});

test("type errors go to the tutor with the cell", async () => {
  const before = mockRequests().length;
  await runCell(typed.notebook, 3);
  const req = mockRequests().slice(before).find((r) => r.body.stream)!.body;
  const cell1 = req.messages[0].content.find((b: any) => /index="1"/.test(b.text ?? "")).text;
  assert.match(cell1, /<type_errors>\nline 2: Type 'string' is not assignable to type 'number'/);
});

test("type errors offer an 'Ask the tutor' quick fix", async () => {
  const c1 = typed.notebook.cellAt(0);
  const d = ourDiagnostics(c1)[0];
  const actions = await vscode.commands.executeCommand<vscode.CodeAction[]>("vscode.executeCodeActionProvider", c1.document.uri, d.range);
  const ask = actions.find((a) => a.title === "Ask the tutor about this type error");
  assert.ok(ask, actions.map((a) => a.title).join(", "));
  await vscode.commands.executeCommand(ask.command!.command, ...(ask.command!.arguments ?? []));
  assert.equal(typed.notebook.cellAt(1).document.getText(), "What does the type error in cell 1 mean?");
});

const labels = async (doc: vscode.TextDocument, pos: vscode.Position) =>
  ((await vscode.commands.executeCommand<vscode.CompletionList>("vscode.executeCompletionItemProvider", doc.uri, pos))?.items ?? []).map((i) =>
    typeof i.label === "string" ? i.label : i.label.label,
  );

test("completions know Deno and share/get in cells (tsserver plugin)", async () => {
  const ed = await openWithTutor("complete.ipynb", ipynb([{ type: "code", lang: "typescript", source: "Deno." }, { type: "code", lang: "typescript", source: "sha" }]));
  const deno = ed.notebook.cellAt(0).document;
  let seen: string[] = [];
  const got = await until(async () => {
    const l = (seen = await labels(deno, new vscode.Position(0, 5)));
    return l.includes("readTextFile") ? l : undefined;
  }, "Deno completions", 90_000).catch((e) => {
    throw new Error(`${e.message}; got ${seen.length}: ${seen.slice(0, 15).join(",")}`);
  });
  assert.ok(got.includes("env"));
  const helpers = await labels(ed.notebook.cellAt(1).document, new vscode.Position(0, 3));
  assert.ok(helpers.includes("share"), helpers.slice(0, 20).join(","));
});

let imported: vscode.NotebookEditor;

test("imports in TypeScript cells: Deno resolves npm: packages, their real types reach later cells, and a bogus package reports Deno's error", async () => {
  await api().denoTypesReady();
  imported = await openWithTutor(
    "imports.ipynb",
    ipynb([
      // process is a global already: without healing, this import would make every name of the cell `any` in later cells.
      { type: "code", lang: "typescript", source: 'import process from "node:process";\nimport { z } from "npm:zod@4";\nconst schema = z.string();\nconst exe: string = process.execPath;' },
      { type: "code", lang: "typescript", source: 'const bad: number = schema.parse("x");\nconst fine: string = schema.parse("y");' },
      { type: "code", lang: "typescript", source: 'import nope from "npm:polyglot-tutor-no-such-package-zz@1";\nconsole.log(nope);' },
      { type: "code", lang: "typescript", source: "sche" },
    ]),
  );
  const [c1, c2, c3] = imported.notebook.getCells();
  // Until Deno has fetched zod, the import is typed as any and nothing is reported; then schema.parse() is known to return a string.
  const d2 = await until(() => (ourDiagnostics(c2).length ? ourDiagnostics(c2) : undefined), "zod's types to arrive for cell 2", 180_000);
  assert.deepEqual(
    d2.map((d) => [d.range.start.line, d.message]),
    [[0, "Type 'string' is not assignable to type 'number'."]],
  );
  assert.deepEqual(ourDiagnostics(c1).map((d) => d.message), [], "the module cell itself is fine");
  const d3 = await until(() => ourDiagnostics(c3).find((d) => /\nDeno: /.test(d.message)), "Deno's error for the bogus package", 180_000);
  assert.match(d3.message, /^Cannot find module 'npm:polyglot-tutor-no-such-package-zz@1'/);
  assert.equal(d3.range.start.line, 0);
}, 240_000);

test("names from a module cell complete in later cells (tsserver plugin)", async () => {
  const c4 = imported.notebook.cellAt(3).document;
  let seen: string[] = [];
  const got = await until(async () => {
    const l = (seen = await labels(c4, new vscode.Position(0, 4)));
    return l.includes("schema") ? l : undefined;
  }, "cross-cell completions", 90_000).catch((e) => {
    throw new Error(`${e.message}; got ${seen.length}: ${seen.slice(0, 15).join(",")}`);
  });
  assert.ok(got.includes("z"), "the import itself is known too");
});

test("Run All skips prompt cells (no API request) and runs the code cells", async () => {
  const ed = await openWithTutor(
    "runall.ipynb",
    ipynb([
      { type: "code", lang: "typescript", source: "console.log('first');" },
      { type: "prompt", source: "Explain this notebook." },
      { type: "code", lang: "python", source: "print('second')" },
    ]),
  );
  const nb = ed.notebook;
  const before = mockRequests().length;
  await vscode.commands.executeCommand("notebook.cell.execute", { ranges: [{ start: 0, end: nb.cellCount }], document: nb.uri });
  await until(() => nb.cellAt(2).executionSummary?.success !== undefined && nb.cellAt(2).executionSummary?.timing?.endTime, "the last code cell to finish", 120_000);
  assert.equal(nb.cellAt(0).executionSummary?.success, true, text(nb.cellAt(0)));
  assert.match(text(nb.cellAt(0)), /first/);
  assert.match(text(nb.cellAt(2)), /second/);
  assert.ok(!nb.cellAt(1).executionSummary?.timing, "the prompt cell was not executed");
  assert.equal(answerOf(nb.cellAt(1)), null, "no answer was produced");
  assert.equal(mockRequests().length, before, "nothing was sent to the API");
});

test("Reopen with Polyglot Tutor replaces the Jupyter editor", async () => {
  const file = path.join(ws(), "made-elsewhere.ipynb");
  writeFileSync(file, JSON.stringify(ipynb([{ type: "code", lang: "sql", source: "select 1" }])));
  const doc = await vscode.workspace.openNotebookDocument(vscode.Uri.file(file));
  assert.equal(doc.notebookType, "jupyter-notebook");
  await vscode.window.showNotebookDocument(doc);
  await vscode.commands.executeCommand("polyglotTutor.reopenWithTutor", doc.uri);
  const ed = await until(() => (vscode.window.activeNotebookEditor?.notebook.notebookType === "polyglot-tutor" ? vscode.window.activeNotebookEditor : undefined), "reopened");
  assert.equal(ed.notebook.cellAt(0).document.languageId, "sql");
  const jupyterTabs = vscode.window.tabGroups.all.flatMap((g) => g.tabs).filter((t) => t.input instanceof vscode.TabInputNotebook && t.input.notebookType === "jupyter-notebook");
  assert.equal(jupyterTabs.length, 0);
});

export function run(): Promise<void> {
  return runAll();
}
