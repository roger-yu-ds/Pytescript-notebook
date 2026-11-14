// Runs notebooks headless on core's runtime: type check first, then every code
// cell in order. Prompt cells are skipped (they would bill the API key).

import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  CellChecker,
  DenoResolver,
  HELPER_TYPES_SOURCE,
  Runtime,
  RuntimeUnavailableError,
  checkDeno,
  defaultDeno,
  defaultLibDir,
  denoTypes,
  formatDiagnostic,
  fromIpynb,
  kernelOf,
  venvPython,
  writeTypesDir,
  type Cell,
  type Lang,
  type Notebook,
  type Output,
} from "@polyglot-tutor/core";
import type { RunOptions } from "./args.ts";

export interface Io {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}

export type CellStatus = "ok" | "error" | "timeout" | "skipped" | "not-run";

export interface CellReport {
  id: string;
  /** 1-based position in the notebook. */
  index: number;
  lang?: Lang;
  type: Cell["type"];
  status: CellStatus;
  ms?: number;
  outputs: Output[];
  /** The cell timed out and its interrupt didn't take, so the kernel was restarted for the cells after it. */
  restarted?: boolean;
}

export interface TypeErrorReport {
  cellId: string;
  index: number;
  messages: string[];
}

export interface NotebookReport {
  file: string;
  ok: boolean;
  typeErrors: TypeErrorReport[];
  cells: CellReport[];
  skippedPrompts: number;
  /** Set when the notebook could not be loaded or its kernels could not start. */
  error?: string;
}

export interface RunReport {
  ok: boolean;
  mode: string;
  python?: string;
  deno?: string;
  notebooks: NotebookReport[];
}

const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");

/** `--python`, then $POLYGLOT_PYTHON, $PYTHON_BIN, then a .venv in the working directory. */
export function findPython(explicit: string | undefined, cwd: string, env = process.env): string | undefined {
  const fromEnv = env.POLYGLOT_PYTHON || env.PYTHON_BIN;
  if (explicit) return explicit;
  if (fromEnv) return fromEnv;
  const venv = venvPython(path.join(cwd, ".venv"));
  return existsSync(venv) ? venv : undefined;
}

/** `--deno`, then $POLYGLOT_DENO, $DENO_BIN, Deno's default install dir, then `deno` on PATH. */
export async function findDeno(explicit: string | undefined, env = process.env): Promise<string | undefined> {
  const candidates = [explicit, env.POLYGLOT_DENO, env.DENO_BIN, defaultDeno(), "deno"].filter((c): c is string => !!c);
  for (const c of candidates) if (await checkDeno(c)) return c;
  return undefined;
}

/** The notebook's cells as "line N: message" errors per TypeScript cell. */
async function typecheck(nb: Notebook, file: string, typesDir: string, deno: string | undefined, denoTypesText: () => Promise<string | undefined>): Promise<TypeErrorReport[]> {
  const cells = nb.cells.map((c, i) => ({ cell: c, index: i + 1 })).filter(({ cell }) => cell.type === "code" && cell.lang === "typescript");
  if (cells.length === 0) return [];
  const cwd = path.dirname(file);
  const checker = new CellChecker({ libDir: defaultLibDir(), cwd });
  try {
    checker.setGlobal("/polyglot/helpers.d.ts", HELPER_TYPES_SOURCE);
    const denoLib = await denoTypesText();
    if (denoLib) checker.setGlobal("/polyglot/lib.deno.d.ts", denoLib);
    checker.update(cells.map(({ cell }) => ({ id: cell.id, text: cell.source })));
    // Imports Deno resolves (npm:, jsr:, node:, import-map names, urls) get a types dir; failures stay unresolved so they report "Cannot find module".
    const failed = new Map<string, string>();
    const imports = checker.imports();
    // With Deno there is always a types dir: it brings @types/node, whose globals (setTimeout) every cell sees.
    if (imports.length || deno) {
      if (deno) {
        const resolutions = await new DenoResolver(deno).resolveAll(cwd, imports);
        for (const r of resolutions) if (r.kind === "error") failed.set(r.specifier, r.error ?? "unknown error");
        writeTypesDir(typesDir, resolutions.filter((r) => r.kind !== "error"), [], cwd);
      } else {
        for (const s of imports) failed.set(s, "Deno isn't set up, so imports can't be resolved (see --deno).");
        writeTypesDir(typesDir, [], [], cwd);
      }
      checker.setTypesDir(typesDir);
    }
    const out: TypeErrorReport[] = [];
    const diagnostics = checker.diagnostics();
    for (const { cell, index } of cells) {
      const d = diagnostics.get(cell.id);
      if (!d) continue;
      const messages = [...d.syntactic, ...d.semantic].map((diag) => {
        let text = formatDiagnostic(diag);
        const spec = diag.code === 2307 || diag.code === 2792 ? /Cannot find module '([^']+)'/.exec(text)?.[1] : undefined;
        if (spec && failed.has(spec)) text += `\nDeno: ${failed.get(spec)}`;
        return text;
      });
      if (messages.length) out.push({ cellId: cell.id, index, messages });
    }
    return out;
  } finally {
    checker.dispose();
  }
}

function outputText(o: Output): string {
  switch (o.kind) {
    case "stream":
      return o.text;
    case "display": {
      const text = o.data["text/plain"];
      if (typeof text === "string") return text.endsWith("\n") ? text : text + "\n";
      const mimes = Object.keys(o.data);
      return mimes.length ? `[${mimes.join(", ")}]\n` : "";
    }
    case "error":
      return (o.traceback.length ? o.traceback.map(stripAnsi).join("\n") : `${o.ename}: ${o.evalue}`) + "\n";
  }
}

const indent = (text: string, by = "    ") => text.replace(/^(?=.)/gm, by);

export async function runNotebooks(opts: RunOptions, io: Io, cwd = process.cwd()): Promise<RunReport> {
  const python = findPython(opts.python, cwd);
  const deno = await findDeno(opts.deno);
  const say = (text: string) => !opts.json && io.stdout(text);
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "polyglot-tutor-run-"));
  const runtime = new Runtime({
    python,
    deno,
    stateDir,
    env: { ...opts.env, POLYGLOT_TUTOR_MODE: opts.mode },
    log: (m, level) => level !== "info" && io.stderr(`${m}\n`),
  });
  let denoLib: Promise<string | undefined> | undefined;
  const denoTypesText = () => (denoLib ??= deno ? denoTypes(deno).catch(() => undefined) : Promise.resolve(undefined));
  const report: RunReport = { ok: true, mode: opts.mode, python, deno, notebooks: [] };
  try {
    for (const file of opts.notebooks) {
      const rel = path.relative(cwd, file) || file;
      say(`▶ ${rel}\n`);
      const nbReport: NotebookReport = { file, ok: true, typeErrors: [], cells: [], skippedPrompts: 0 };
      report.notebooks.push(nbReport);
      let nb: Notebook;
      try {
        nb = fromIpynb(path.basename(file), JSON.parse(readFileSync(file, "utf8")));
      } catch (e) {
        nbReport.ok = false;
        nbReport.error = `could not read ${rel}: ${(e as Error).message}`;
        say(`  ✗ ${nbReport.error}\n`);
        continue;
      }
      nbReport.cells = nb.cells.map((c, i) => ({ id: c.id, index: i + 1, lang: c.lang, type: c.type, status: c.type === "code" ? "not-run" : "skipped", outputs: [] }));
      nbReport.skippedPrompts = nb.cells.filter((c) => c.type === "prompt").length;

      if (opts.typecheck) {
        try {
          nbReport.typeErrors = await typecheck(nb, file, path.join(stateDir, "types", path.basename(file, ".ipynb")), deno, denoTypesText);
        } catch (e) {
          nbReport.typeErrors = [{ cellId: "", index: 0, messages: [`type check failed: ${(e as Error).message}`] }];
        }
        for (const t of nbReport.typeErrors) {
          say(`  ✗ cell ${t.index} (typescript): ${t.messages.length} type error${t.messages.length === 1 ? "" : "s"}\n`);
          for (const m of t.messages) say(indent(m) + "\n");
        }
        if (nbReport.typeErrors.length) {
          nbReport.ok = false;
          if (!opts.keepGoing) {
            say(`  ✗ ${rel}: type errors; not running its cells (use --keep-going to run anyway)\n`);
            continue;
          }
        }
      }

      const session = runtime.session(file);
      for (const [i, cell] of nb.cells.entries()) {
        const cr = nbReport.cells[i];
        if (cell.type !== "code" || !cell.lang) continue;
        const lang = cell.lang;
        say(`  [${cr.index}] ${lang}\n`);
        const started = Date.now();
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          // Start the kernel first: its start-up doesn't count against the cell, and an interrupt only takes effect while a cell is executing.
          await session.kernel(kernelOf(lang));
          const timeout = new Promise<"timeout">((resolve) => (timer = setTimeout(() => resolve("timeout"), opts.timeout * 1000)));
          const run = session.run(lang, cell.source, (o) => {
            cr.outputs.push(o);
            say(indent(outputText(o)));
          });
          const r = await Promise.race([run, timeout]);
          if (r === "timeout") {
            cr.status = "timeout";
            await session.interrupt(kernelOf(lang)).catch(() => {});
            // Give the kernel a moment to report the interrupt, so its output is captured and the next cell starts on an idle kernel.
            const settled = await Promise.race([run.then(() => true), new Promise<false>((resolve) => setTimeout(() => resolve(false), 5_000))]);
            if (!settled) {
              // The interrupt didn't take (kernels on Windows sometimes ignore it): restart the kernel so the cells after this one can run.
              await session.restart(kernelOf(lang)).catch(() => {});
              cr.restarted = true;
            }
            say(`  ✗ cell ${cr.index} timed out after ${opts.timeout} s${cr.restarted ? " (the interrupt didn't take; kernel restarted)" : ""}\n`);
          } else {
            cr.status = r.ok ? "ok" : "error";
            if (!r.ok) say(`  ✗ cell ${cr.index} failed\n`);
          }
        } catch (e) {
          cr.status = "error";
          const message = e instanceof RuntimeUnavailableError ? `${e.message} Pass --${e.lang === "python" ? "python" : "deno"} or set ${e.lang === "python" ? "POLYGLOT_PYTHON" : "POLYGLOT_DENO"}.` : (e as Error).message;
          cr.outputs.push({ kind: "error", ename: "KernelError", evalue: message, traceback: [] });
          say(`  ✗ cell ${cr.index}: ${message}\n`);
        } finally {
          clearTimeout(timer);
        }
        cr.ms = Date.now() - started;
        if (cr.status !== "ok") {
          nbReport.ok = false;
          if (!opts.keepGoing) {
            say(`  ✗ ${rel}: stopped at cell ${cr.index} (use --keep-going to run the rest)\n`);
            break;
          }
        }
      }
      if (nbReport.skippedPrompts) say(`  skipped ${nbReport.skippedPrompts} prompt cell${nbReport.skippedPrompts === 1 ? "" : "s"}\n`);
      const ran = nbReport.cells.filter((c) => c.status !== "not-run" && c.status !== "skipped");
      const failed = ran.filter((c) => c.status !== "ok");
      say(`${nbReport.ok ? "✓" : "✗"} ${rel}: ${ran.length} cell${ran.length === 1 ? "" : "s"} ran${failed.length ? `, ${failed.length} failed` : ""}${nbReport.typeErrors.length ? `, ${nbReport.typeErrors.length} with type errors` : ""}\n`);
    }
  } finally {
    await runtime.dispose().catch(() => {});
    rmSync(stateDir, { recursive: true, force: true });
  }
  report.ok = report.notebooks.every((n) => n.ok);
  if (opts.json) io.stdout(JSON.stringify(report, null, 2) + "\n");
  else if (opts.notebooks.length > 1) {
    const bad = report.notebooks.filter((n) => !n.ok).length;
    io.stdout(`${report.ok ? "✓" : "✗"} ${report.notebooks.length} notebooks${bad ? `, ${bad} failed` : ""}\n`);
  }
  return report;
}
