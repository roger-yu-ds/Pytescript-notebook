// Installs the runtimes "Set Up Runtimes" manages, into a folder the extension
// owns. No VS Code dependency, so it can be tested and run on its own.

import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { venvPython } from "@polyglot-tutor/core";
import { downloadVerified, extractExecutables, readArchive } from "./archive.ts";

export const UV_VERSION = "0.12.2";
export const DENO_VERSION = "2.9.8";
export const PYTHON_VERSION = "3.13";
/** What the kernels need, pinned to versions tested together. */
export const PYTHON_PACKAGES = [
  "jupyter_server==2.21.1",
  "ipykernel==7.4.0",
  "pandas==3.1.0",
  "matplotlib==3.11.2",
  "plotly==7.1.0",
  "duckdb==2.0.0",
  "pyarrow==26.0.0",
  "deltalake==1.6.6",
];

const exe = (name: string, platform = process.platform) => (platform === "win32" ? `${name}.exe` : name);

/** Rust target triple for a Node platform/arch, or null if there are no builds for it. */
export function targetTriple(platform: NodeJS.Platform = process.platform, arch: string = process.arch): string | null {
  const cpu = arch === "x64" ? "x86_64" : arch === "arm64" ? "aarch64" : null;
  if (!cpu) return null;
  if (platform === "linux") return `${cpu}-unknown-linux-gnu`;
  if (platform === "darwin") return `${cpu}-apple-darwin`;
  if (platform === "win32") return `${cpu}-pc-windows-msvc`;
  return null;
}

export interface Asset {
  url: string;
  checksumUrl: string;
  executables: string[];
}

export function uvAsset(platform: NodeJS.Platform = process.platform, arch: string = process.arch): Asset | null {
  const triple = targetTriple(platform, arch);
  if (!triple) return null;
  const file = `uv-${triple}.${platform === "win32" ? "zip" : "tar.gz"}`;
  const url = `https://github.com/astral-sh/uv/releases/download/${UV_VERSION}/${file}`;
  return { url, checksumUrl: `${url}.sha256`, executables: [exe("uv", platform)] };
}

export function denoAsset(platform: NodeJS.Platform = process.platform, arch: string = process.arch): Asset | null {
  const triple = targetTriple(platform, arch);
  if (!triple || (platform === "win32" && arch !== "x64")) return null;
  const url = `https://github.com/denoland/deno/releases/download/v${DENO_VERSION}/deno-${triple}.zip`;
  return { url, checksumUrl: `${url}.sha256sum`, executables: [exe("deno", platform)] };
}

export interface InstallContext {
  /** The managed runtimes folder (contains uv/, python/, venv/, deno/). */
  root: string;
  log: (line: string) => void;
  progress?: (message: string) => void;
  signal?: AbortSignal;
}

async function fetchExecutable(asset: Asset | null, dir: string, what: string, ctx: InstallContext): Promise<string> {
  if (!asset) throw new Error(`No ${what} build for ${process.platform}/${process.arch}.`);
  ctx.progress?.(`Downloading ${what}…`);
  ctx.log(`downloading ${asset.url}`);
  const data = await downloadVerified(asset.url, asset.checksumUrl, ctx.signal);
  ctx.log(`checksum ok (${(data.length / 1e6).toFixed(1)} MB)`);
  return extractExecutables(readArchive(asset.url, data), asset.executables, dir)[0];
}

/** Run a command, streaming its output to the log. */
function run(cmd: string, args: string[], ctx: InstallContext, env: NodeJS.ProcessEnv = {}): Promise<void> {
  return new Promise((resolve, reject) => {
    ctx.log(`$ ${cmd} ${args.join(" ")}`);
    const p = spawn(cmd, args, { env: { ...process.env, ...env }, windowsHide: true, signal: ctx.signal });
    const forward = (d: Buffer) => d.toString().split(/\r?\n/).filter(Boolean).forEach(ctx.log);
    p.stdout.on("data", forward);
    p.stderr.on("data", forward);
    p.on("error", reject);
    p.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`${path.basename(cmd)} exited with code ${code}`))));
  });
}

/** uv from PATH, or our own copy (downloaded if needed). */
export async function ensureUv(ctx: InstallContext): Promise<string> {
  try {
    await promisify(execFile)("uv", ["--version"], { windowsHide: true });
    return "uv";
  } catch {
    /* not on PATH */
  }
  const own = path.join(ctx.root, "uv", exe("uv"));
  return existsSync(own) ? own : fetchExecutable(uvAsset(), path.join(ctx.root, "uv"), `uv ${UV_VERSION}`, ctx);
}

/** Create the managed venv (Python via uv) and install the kernel packages. Returns its python. */
export async function installPython(ctx: InstallContext): Promise<string> {
  const uv = await ensureUv(ctx);
  const venv = path.join(ctx.root, "venv");
  // uv keeps the Python it downloads inside our folder, not in the user's uv directory.
  const env = { UV_PYTHON_INSTALL_DIR: path.join(ctx.root, "python") };
  ctx.progress?.(`Creating a Python ${PYTHON_VERSION} environment…`);
  await run(uv, ["venv", "--allow-existing", "--python", PYTHON_VERSION, venv], ctx, env);
  ctx.progress?.("Installing Jupyter, pandas, DuckDB and Delta Lake…");
  const python = venvPython(venv);
  await run(uv, ["pip", "install", "--python", python, ...PYTHON_PACKAGES], ctx, env);
  return python;
}

/** Download Deno into the managed folder. Returns its path. */
export function installDeno(ctx: InstallContext): Promise<string> {
  return fetchExecutable(denoAsset(), path.join(ctx.root, "deno"), `Deno ${DENO_VERSION}`, ctx);
}
