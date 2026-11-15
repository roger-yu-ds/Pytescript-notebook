// Polyglot Tutor for VS Code: wires the notebook serializer, controller,
// renderer messaging, type checker, status bars, views and commands together.

import * as vscode from "vscode";
import path from "node:path";
import { ApiKeys } from "./apiKey.ts";
import { CellStatusBar } from "./cellStatusBar.ts";
import { registerPromptTint } from "./promptTint.ts";
import { insertFromAnswer, registerCommands } from "./commands.ts";
import { affectsRuntimes } from "./config.ts";
import { TutorController } from "./controller.ts";
import { NOTEBOOK_TYPE } from "./convert.ts";
import { TsPluginConfig, loadDenoTypes } from "./denoTypes.ts";
import { NotebookStates } from "./notebookState.ts";
import { offerPythonEnvironment } from "./pythonEnv.ts";
import { offerReopen } from "./reopen.ts";
import { RuntimeHost } from "./runtimeHost.ts";
import { IpynbSerializer } from "./serializer.ts";
import { SHARED_VIEW, SharedValuesView } from "./sharedView.ts";
import { StatusBar } from "./statusBar.ts";
import { AskAboutTypeError, NotebookTypeChecker } from "./typecheck.ts";
import { TutorService } from "./tutorService.ts";
import { setupRuntimes } from "./setup.ts";

/** What tests (and other extensions) can reach. */
export interface PolyglotTutorApi {
  host: RuntimeHost;
  states: NotebookStates;
  tutor: TutorService;
  checker: NotebookTypeChecker;
  /** Resolves once Deno's types are loaded into the checker (or failed to load). */
  denoTypesReady: () => Promise<void>;
}

export function activate(context: vscode.ExtensionContext): PolyglotTutorApi {
  const log = vscode.window.createOutputChannel("Polyglot Tutor", { log: true });
  const storage = context.globalStorageUri.fsPath;
  const keys = new ApiKeys(context.secrets);
  const states = new NotebookStates(context.workspaceState);
  const host = new RuntimeHost(context, log);
  const tsPlugin = new TsPluginConfig(log);
  const checker = new NotebookTypeChecker({
    libDir: path.join(context.extensionPath, "dist", "ts-lib"),
    storage: path.join(storage, "types"),
    log,
    fileOf: (nb) => host.fileOf(nb),
    deno: () => host.resolved.deno,
    plugin: tsPlugin,
  });
  const tutor = new TutorService(context.globalStorageUri, keys, states, (cell) => checker.errorsFor(cell));
  const cellBar = new CellStatusBar();

  context.subscriptions.push(
    log,
    states,
    host,
    checker,
    vscode.workspace.registerNotebookSerializer(NOTEBOOK_TYPE, new IpynbSerializer(), { transientOutputs: false }),
    new TutorController(host, tutor, log),
    new StatusBar(states),
    registerPromptTint(),
    vscode.notebooks.registerNotebookCellStatusBarItemProvider(NOTEBOOK_TYPE, cellBar),
    vscode.languages.registerCodeActionsProvider({ notebookType: NOTEBOOK_TYPE, language: "typescript" }, new AskAboutTypeError(), {
      providedCodeActionKinds: AskAboutTypeError.kinds,
    }),
    vscode.window.registerTreeDataProvider(SHARED_VIEW, new SharedValuesView(states)),
    offerReopen(context.workspaceState),
    ...registerCommands({ context, keys, host, tutor, log, setupRuntimes: () => setupRuntimes(context, log, runtimesChanged) }),
  );

  // Kernel and shared-value events → UI state.
  host.onKernel.on(({ notebook, lang, state }) => states.setKernel(notebook.uri, lang, state));
  host.onShared.on(({ notebook, items }) => states.setShared(notebook.uri, items));

  // "Insert as cell" from code blocks in answers.
  const messaging = vscode.notebooks.createRendererMessaging("polyglot-tutor.answer");
  context.subscriptions.push(
    messaging.onDidReceiveMessage(async ({ editor, message }) => {
      if (message?.type === "insertCell" && typeof message.code === "string") {
        await insertFromAnswer(editor, String(message.cellId ?? ""), message.code, String(message.lang ?? ""));
      }
    }),
  );

  // Deno types for the checker and tsserver plugin, loaded when the first notebook of ours opens.
  let denoTypes: Promise<void> | null = null;

  /** Python/Deno paths changed (settings or setup): restart kernels on next run, reload Deno types. */
  async function runtimesChanged() {
    await host.reset();
    states.resetKernels();
    denoTypes = null;
    checker.runtimesChanged();
    if (vscode.workspace.notebookDocuments.some((nb) => nb.notebookType === NOTEBOOK_TYPE)) void loadTypes();
    log.info("runtimes changed; kernels will restart on the next run");
  }
  const loadTypes = () =>
    (denoTypes ??= (async () => {
      const deno = host.resolved.deno;
      const source = deno ? await loadDenoTypes(deno, path.join(storage, "types")).catch((e) => void log.warn(`deno types: ${e}`)) : undefined;
      if (source) checker.setDenoTypes(source);
      await tsPlugin.setGlobals(path.join(storage, "types"), source ?? undefined);
    })());

  const onOurs = (nb: vscode.NotebookDocument) => {
    if (nb.notebookType !== NOTEBOOK_TYPE) return;
    void loadTypes();
    void offerPythonEnvironment(context.workspaceState, nb, host.resolved.python);
    // Delta tables saved in earlier sessions show up before any kernel starts.
    host
      .session(nb)
      .index()
      .then((items) => states.setShared(nb.uri, items))
      .catch(() => {});
  };
  vscode.workspace.notebookDocuments.forEach(onOurs);

  const setActiveContext = () =>
    vscode.commands.executeCommand("setContext", "polyglotTutor.notebookActive", vscode.window.activeNotebookEditor?.notebook.notebookType === NOTEBOOK_TYPE);
  void setActiveContext();

  context.subscriptions.push(
    vscode.window.onDidChangeActiveNotebookEditor(() => void setActiveContext()),
    vscode.workspace.onDidOpenNotebookDocument(onOurs),
    vscode.workspace.onDidChangeNotebookDocument((e) => e.notebook.notebookType === NOTEBOOK_TYPE && cellBar.refresh()),
    vscode.workspace.onDidCloseNotebookDocument(async (nb) => {
      if (nb.notebookType !== NOTEBOOK_TYPE) return;
      await host.close(nb);
      states.resetKernels(nb.uri);
    }),
    vscode.workspace.onDidChangeConfiguration((e) => affectsRuntimes(e) && void runtimesChanged()),
  );

  return { host, states, tutor, checker, denoTypesReady: () => loadTypes() };
}

export function deactivate() {
  /* disposables handle cleanup */
}
