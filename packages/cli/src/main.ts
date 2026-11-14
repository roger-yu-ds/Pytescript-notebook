// polyglot-tutor: run notebooks headless (type check, then every code cell in order).
//
//   polyglot-tutor run <notebook.ipynb>... [--mode learner|solutions] [--env K=V]
//     [--python <path>] [--deno <path>] [--timeout <s>] [--keep-going] [--json] [--no-typecheck]
//
// Exit codes: 0 everything passed, 1 a cell or type check failed, 2 bad arguments.

import { USAGE, UsageError, parseCli } from "./args.ts";
import { runNotebooks, type Io } from "./run.ts";

export { USAGE, UsageError, parseCli } from "./args.ts";
export { findDeno, findPython, runNotebooks } from "./run.ts";
export type { CellReport, CellStatus, Io, NotebookReport, RunReport, TypeErrorReport } from "./run.ts";
export type { Mode, RunOptions } from "./args.ts";

const processIo: Io = { stdout: (t) => void process.stdout.write(t), stderr: (t) => void process.stderr.write(t) };

/** The CLI entry point; returns the exit code. */
export async function main(argv: string[], io: Io = processIo, cwd = process.cwd()): Promise<number> {
  let opts;
  try {
    opts = parseCli(argv, cwd);
  } catch (e) {
    if (!(e instanceof UsageError)) throw e;
    io.stderr(`polyglot-tutor: ${e.message}\n\n${USAGE}`);
    return 2;
  }
  if (opts.command === "help") {
    io.stdout(USAGE);
    return 0;
  }
  const report = await runNotebooks(opts, io, cwd);
  return report.ok ? 0 : 1;
}
