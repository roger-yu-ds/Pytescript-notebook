// Locating and checking the Python and Deno runtimes the kernels run on.

import { execFile } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const isWindows = process.platform === "win32";

/** The Python executable inside a virtual environment. */
export const venvPython = (venv: string) => (isWindows ? path.join(venv, "Scripts", "python.exe") : path.join(venv, "bin", "python"));

/** Deno's default install location (the official install script). */
export const defaultDeno = () => path.join(os.homedir(), ".deno", "bin", isWindows ? "deno.exe" : "deno");

/** Python packages the kernels need (import names). */
export const REQUIRED_PYTHON_MODULES = ["jupyter_server", "ipykernel", "pandas", "duckdb", "pyarrow", "deltalake"] as const;

export interface PythonCheck {
  ok: boolean;
  version?: string;
  missing: string[];
  error?: string;
}

/** Can this Python run our kernels? Reports which modules are missing. */
export async function checkPython(python: string): Promise<PythonCheck> {
  if (!existsSync(python)) return { ok: false, missing: [...REQUIRED_PYTHON_MODULES], error: `${python} does not exist` };
  const probe = `import importlib.util, json, sys
print(json.dumps({"version": sys.version.split()[0], "missing": [m for m in ${JSON.stringify(REQUIRED_PYTHON_MODULES)} if importlib.util.find_spec(m) is None]}))`;
  try {
    const { stdout } = await run(python, ["-c", probe], { timeout: 30_000, windowsHide: true });
    const r = JSON.parse(stdout.trim().split("\n").pop()!) as { version: string; missing: string[] };
    return { ok: r.missing.length === 0, version: r.version, missing: r.missing };
  } catch (e) {
    return { ok: false, missing: [...REQUIRED_PYTHON_MODULES], error: (e as Error).message };
  }
}

/** Deno's version, or null if it can't run. */
export async function checkDeno(deno: string): Promise<string | null> {
  try {
    const { stdout } = await run(deno, ["--version"], { timeout: 30_000, windowsHide: true });
    return /deno (\S+)/.exec(stdout)?.[1] ?? null;
  } catch {
    return null;
  }
}

/** Name of the kernel spec we write for Deno (kept apart from a global `deno jupyter --install`). */
export const DENO_KERNEL = "polyglot-tutor-deno";

/**
 * Write a Jupyter kernel spec for Deno into `<jupyterDir>/kernels/`, so the
 * server (with `jupyterDir` on JUPYTER_PATH) can start it without a global
 * `deno jupyter --install`.
 */
export function writeDenoKernelSpec(jupyterDir: string, deno: string): void {
  const dir = path.join(jupyterDir, "kernels", DENO_KERNEL);
  mkdirSync(dir, { recursive: true });
  const spec = { argv: [deno, "jupyter", "--kernel", "--conn", "{connection_file}"], display_name: "Deno (Polyglot Tutor)", language: "typescript" };
  writeFileSync(path.join(dir, "kernel.json"), JSON.stringify(spec, null, 2));
}

/**
 * Deno's runtime type declarations (`deno types`), with the lib references
 * stripped so they can be added to any TypeScript program.
 */
export async function denoTypes(deno: string): Promise<string> {
  const { stdout } = await run(deno, ["types"], { maxBuffer: 64 * 1024 * 1024, windowsHide: true });
  return stdout.replace(/^\/\/\/ <reference (no-default-lib|lib)=.*$/gm, "");
}
