// "Polyglot Tutor: Set Up Runtimes": checks Python and Deno, and installs the
// missing ones into the extension's storage after the user confirms each download.

import * as vscode from "vscode";
import { checkDeno, checkPython, type PythonCheck } from "@polyglot-tutor/core";
import { SECTION } from "./config.ts";
import { DENO_VERSION, PYTHON_PACKAGES, PYTHON_VERSION, installDeno, installPython, type InstallContext } from "./installers.ts";
import { managedPaths, resolveRuntimes } from "./runtimeHost.ts";

export interface RuntimeStatus {
  python: { path?: string; source: string; check: PythonCheck | null };
  deno: { path?: string; source: string; version: string | null };
}

/** What Python and Deno would be used now (re-resolved: an install may have just finished). */
export async function runtimeStatus(storage: vscode.Uri): Promise<RuntimeStatus> {
  const r = resolveRuntimes(storage);
  return {
    python: { path: r.python, source: r.pythonSource, check: r.python ? await checkPython(r.python) : null },
    deno: { path: r.deno, source: r.denoSource, version: r.deno ? await checkDeno(r.deno) : null },
  };
}

async function confirm(message: string, detail: string, action: string): Promise<boolean> {
  return (await vscode.window.showInformationMessage(message, { modal: true, detail }, action)) === action;
}

/** A misconfigured explicit setting wins over the managed install, so offer to clear it. */
async function clearBrokenSetting(key: "pythonPath" | "denoPath", value: string, problem: string): Promise<boolean> {
  const choice = await vscode.window.showWarningMessage(
    `polyglotTutor.${key} is set to ${value}, but ${problem}.`,
    { modal: true, detail: "Clear the setting to let Polyglot Tutor install and use its own copy, or fix the setting yourself." },
    "Clear Setting and Install",
  );
  if (choice !== "Clear Setting and Install") return false;
  for (const target of [vscode.ConfigurationTarget.Global, vscode.ConfigurationTarget.Workspace, vscode.ConfigurationTarget.WorkspaceFolder]) {
    await vscode.workspace.getConfiguration(SECTION).update(key, undefined, target).then(undefined, () => {});
  }
  return true;
}

export async function setupRuntimes(context: vscode.ExtensionContext, log: vscode.LogOutputChannel, onChanged: () => Promise<void>): Promise<void> {
  const storage = context.globalStorageUri;
  const root = managedPaths(storage).root;
  let status = await runtimeStatus(storage);
  let changed = false;

  const install = (title: string, work: (ctx: InstallContext) => Promise<string>) =>
    vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title, cancellable: true }, async (progress, token) => {
      const abort = new AbortController();
      token.onCancellationRequested(() => abort.abort());
      log.show(true);
      const result = await work({ root, log: (l) => log.info(l), progress: (message) => progress.report({ message }), signal: abort.signal });
      changed = true;
      return result;
    });

  try {
    // ---- Python ----
    const py = status.python;
    if (!py.check?.ok) {
      const problem = py.check ? (py.check.error ?? `it lacks ${py.check.missing.join(", ")}`) : "";
      const proceed =
        py.source === "setting"
          ? await clearBrokenSetting("pythonPath", py.path!, problem)
          : await confirm(
              "Install Python for Polyglot Tutor?",
              `Python and SQL cells need Python ${PYTHON_VERSION} with Jupyter, pandas, DuckDB and Delta Lake.\n\nThis downloads uv (if not installed) from github.com/astral-sh/uv, Python ${PYTHON_VERSION} via uv, and these packages from PyPI (about 300 MB):\n${PYTHON_PACKAGES.join(", ")}\n\nEverything goes into ${root} and doesn't change your other Python installations.`,
              "Install Python",
            );
      if (proceed) await install("Polyglot Tutor: installing Python", installPython);
    }

    // ---- Deno ----
    status = changed ? await runtimeStatus(storage) : status;
    const deno = status.deno;
    if (!deno.version) {
      const proceed =
        deno.source === "setting"
          ? await clearBrokenSetting("denoPath", deno.path!, "it doesn't run")
          : await confirm(
              "Install Deno for Polyglot Tutor?",
              `TypeScript cells run on Deno. This downloads Deno ${DENO_VERSION} (about 45 MB) from github.com/denoland/deno, checks its SHA-256, and puts it in ${root}.`,
              "Install Deno",
            );
      if (proceed) await install("Polyglot Tutor: installing Deno", installDeno);
    }
  } catch (e) {
    const message = (e as Error).name === "AbortError" ? "Setup cancelled." : `Setup failed: ${(e as Error).message}`;
    log.error(message);
    void vscode.window.showErrorMessage(`Polyglot Tutor: ${message}`, "Show Log").then((c) => c && log.show());
  }

  if (changed) await onChanged();
  status = await runtimeStatus(storage);
  const pyLine = status.python.check?.ok ? `Python ${status.python.check.version} ✓` : "Python ✗";
  const denoLine = status.deno.version ? `Deno ${status.deno.version} ✓` : "Deno ✗";
  const ready = status.python.check?.ok && status.deno.version;
  const choice = await vscode.window.showInformationMessage(
    `Polyglot Tutor runtimes: ${pyLine} · ${denoLine}${ready ? "" : " (run setup again to install what's missing)"}`,
    ...(ready ? ["Open Welcome Tour"] : ["Show Log"]),
  );
  if (choice === "Open Welcome Tour") await vscode.commands.executeCommand("polyglotTutor.openWelcome");
  if (choice === "Show Log") log.show();
}
