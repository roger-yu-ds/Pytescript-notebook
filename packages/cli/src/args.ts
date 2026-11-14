// Command-line parsing for `polyglot-tutor run`.

import { existsSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";

export const MODES = ["learner", "solutions"] as const;
export type Mode = (typeof MODES)[number];

export interface RunOptions {
  command: "run";
  /** Absolute paths of the notebooks to run, in order. */
  notebooks: string[];
  mode: Mode;
  /** Extra environment variables for the kernels. */
  env: Record<string, string>;
  python?: string;
  deno?: string;
  /** Per-cell timeout in seconds. */
  timeout: number;
  keepGoing: boolean;
  json: boolean;
  typecheck: boolean;
}

export interface HelpOptions {
  command: "help";
}

/** Bad arguments: the message is printed and the process exits with 2. */
export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

export const USAGE = `usage: polyglot-tutor run <notebook.ipynb>... [options]

Runs notebooks headless: type-checks the TypeScript cells, then runs the code
cells in order on real kernels (Python, Deno, SQL on DuckDB). Prompt cells are
skipped. Exits 0 when every cell passed, 1 when any failed, 2 on bad arguments.

options:
  --mode <learner|solutions>  sets POLYGLOT_TUTOR_MODE for the kernels (default: learner)
  --env KEY=VALUE             extra environment variable for the kernels (repeatable)
  --python <path>             Python with jupyter_server + ipykernel (default: $POLYGLOT_PYTHON, $PYTHON_BIN, ./.venv)
  --deno <path>               Deno executable (default: $POLYGLOT_DENO, $DENO_BIN, ~/.deno/bin/deno, deno on PATH)
  --timeout <seconds>         per-cell time limit (default: 600)
  --keep-going                carry on after a failing cell or type error
  --json                      print a JSON report instead of plain text
  --no-typecheck              skip the TypeScript type check
  -h, --help                  show this help
`;

const ENV_ENTRY = /^([A-Za-z_]\w*)=([\s\S]*)$/;

export function parseCli(argv: string[], cwd = process.cwd()): RunOptions | HelpOptions {
  let parsed: ReturnType<typeof parseArgs<{ options: typeof OPTIONS; allowPositionals: true; allowNegative: true }>>;
  try {
    parsed = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true, allowNegative: true, strict: true });
  } catch (e) {
    throw new UsageError((e as Error).message);
  }
  const { values, positionals } = parsed;
  if (values.help) return { command: "help" };
  const [command, ...files] = positionals;
  if (!command) throw new UsageError("missing command: expected `run`");
  if (command !== "run") throw new UsageError(`unknown command "${command}": expected \`run\``);
  if (files.length === 0) throw new UsageError("no notebooks given");
  const notebooks = files.map((f) => {
    const abs = path.resolve(cwd, f);
    if (!/\.ipynb$/i.test(abs)) throw new UsageError(`${f} is not an .ipynb file`);
    if (!existsSync(abs)) throw new UsageError(`${f} does not exist`);
    return abs;
  });
  const mode = values.mode ?? "learner";
  if (!(MODES as readonly string[]).includes(mode)) throw new UsageError(`--mode must be one of ${MODES.join(", ")}, not "${mode}"`);
  const env: Record<string, string> = {};
  for (const entry of values.env ?? []) {
    const m = ENV_ENTRY.exec(entry);
    if (!m) throw new UsageError(`--env expects KEY=VALUE, not "${entry}"`);
    env[m[1]] = m[2];
  }
  const timeout = values.timeout === undefined ? 600 : Number(values.timeout);
  if (!Number.isFinite(timeout) || timeout <= 0) throw new UsageError(`--timeout must be a positive number of seconds, not "${values.timeout}"`);
  return {
    command: "run",
    notebooks,
    mode: mode as Mode,
    env,
    python: values.python,
    deno: values.deno,
    timeout,
    keepGoing: values["keep-going"] ?? false,
    json: values.json ?? false,
    typecheck: values.typecheck ?? true,
  };
}

const OPTIONS = {
  mode: { type: "string" },
  env: { type: "string", multiple: true },
  python: { type: "string" },
  deno: { type: "string" },
  timeout: { type: "string" },
  "keep-going": { type: "boolean" },
  json: { type: "boolean" },
  typecheck: { type: "boolean" },
  help: { type: "boolean", short: "h" },
} as const;
