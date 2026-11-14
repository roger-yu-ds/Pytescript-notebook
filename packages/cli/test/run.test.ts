// `polyglot-tutor run` on real kernels (the repo's .venv and Deno, or POLYGLOT_PYTHON / POLYGLOT_DENO).

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";
import { checkDeno, defaultDeno, toIpynb, venvPython, type Cell } from "@polyglot-tutor/core";
import { main } from "../src/main.ts";
import type { RunReport } from "../src/run.ts";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const python = process.env.POLYGLOT_PYTHON ?? process.env.PYTHON_BIN ?? venvPython(path.join(repo, ".venv"));
const deno = process.env.POLYGLOT_DENO ?? process.env.DENO_BIN ?? defaultDeno();
// Deno is probed by running it: a PATH entry or a Windows path without .exe spawns fine but fails an existence check.
const runtimes = existsSync(python) && (await checkDeno(deno)) ? false : `needs ${python} and a working ${deno}`;

const tmp = mkdtempSync(path.join(os.tmpdir(), "polyglot-cli-"));
after(() => rmSync(tmp, { recursive: true, force: true }));

type Spec = { lang: "python" | "typescript" | "sql"; source: string } | { prompt: string } | { md: string };

/** Write a notebook in the web app's format; returns its path. */
function notebook(name: string, cells: Spec[], dir = tmp): string {
  const file = path.join(dir, name);
  mkdirSync(dir, { recursive: true });
  const nb = {
    name,
    cells: cells.map((c, i): Cell => {
      if ("prompt" in c) return { id: `p${i}`, type: "prompt", source: c.prompt, outputs: [], mode: "hint" };
      if ("md" in c) return { id: `m${i}`, type: "markdown", source: c.md, outputs: [] };
      return { id: `c${i}`, type: "code", lang: c.lang, source: c.source, outputs: [] };
    }),
  };
  writeFileSync(file, JSON.stringify(toIpynb(nb), null, 1));
  return file;
}

/** Run the CLI in-process with captured output. */
async function cli(...args: string[]) {
  let stdout = "";
  let stderr = "";
  const code = await main([...args, "--python", python, "--deno", deno], { stdout: (t) => (stdout += t), stderr: (t) => (stderr += t) }, tmp);
  return { code, stdout, stderr, all: stdout + stderr };
}

test("argument errors exit 2 with the usage; --help exits 0", async () => {
  const io = { stdout: "", stderr: "" };
  const run = (...args: string[]) => main(args, { stdout: (t) => (io.stdout += t), stderr: (t) => (io.stderr += t) }, tmp);
  const nb = notebook("args.ipynb", [{ lang: "python", source: "print(1)" }]);
  assert.equal(await run(), 2);
  assert.match(io.stderr, /missing command/);
  assert.match(io.stderr, /usage: polyglot-tutor run/);
  assert.equal(await run("fly", nb), 2);
  assert.equal(await run("run"), 2);
  assert.equal(await run("run", "nope.ipynb"), 2);
  assert.equal(await run("run", "notes.txt"), 2);
  assert.equal(await run("run", nb, "--mode", "cheat"), 2);
  assert.equal(await run("run", nb, "--env", "novalue"), 2);
  assert.equal(await run("run", nb, "--timeout", "-1"), 2);
  assert.equal(await run("run", nb, "--bogus"), 2);
  assert.match(io.stderr, /--bogus/);
  io.stdout = "";
  assert.equal(await run("--help"), 0);
  assert.match(io.stdout, /--keep-going/);
  assert.equal(io.stdout.includes("polyglot-tutor:"), false, "help is not an error");
});

test("runs Python, SQL and TypeScript cells in order with shared values; prompt cells are skipped", { skip: runtimes }, async () => {
  const nb = notebook("mixed.ipynb", [
    { md: "# Mixed" },
    { lang: "python", source: "import pandas as pd\nsales = pd.DataFrame({'region': ['n', 's', 'n'], 'amt': [1, 2, 3]})\nprint('hi from python')" },
    { lang: "sql", source: "-- as: by_region\nselect region, sum(amt) as total from sales group by region order by region" },
    { lang: "typescript", source: "const rows = await get<{ region: string; total: number }[]>('by_region');\nconsole.log(rows.map((r) => `${r.region}=${r.total}`).join(','));" },
    { prompt: "Why?" },
    { lang: "python", source: "print('after the prompt')" },
  ]);
  const r = await cli("run", nb);
  assert.equal(r.code, 0, r.all);
  const order = ["hi from python", "shared \"by_region\"", "n=4,s=2", "after the prompt"].map((s) => r.stdout.indexOf(s));
  assert.ok(order.every((i) => i >= 0) && order.every((v, i) => i === 0 || v > order[i - 1]), `outputs in cell order:\n${r.stdout}`);
  assert.match(r.stdout, /skipped 1 prompt cell/);
  assert.match(r.stdout, /✓ mixed\.ipynb: 4 cells ran$/m);
});

test("a runtime error fails the notebook and stops it; --keep-going runs the remaining cells", { skip: runtimes }, async () => {
  const nb = notebook("boom.ipynb", [
    { lang: "python", source: "print('one')" },
    { lang: "python", source: "1/0" },
    { lang: "python", source: "print('three')" },
  ]);
  let r = await cli("run", nb);
  assert.equal(r.code, 1);
  assert.match(r.stdout, /one/);
  assert.match(r.stdout, /ZeroDivisionError/);
  assert.doesNotMatch(r.stdout, /three/, "stops at the failing cell");
  assert.match(r.stdout, /stopped at cell 2/);
  r = await cli("run", nb, "--keep-going");
  assert.equal(r.code, 1, "still a failure");
  assert.match(r.stdout, /three/);
  assert.match(r.stdout, /✗ boom\.ipynb: 3 cells ran, 1 failed/);
});

test("TypeScript cells are type-checked before anything runs: cross-cell globals, Deno and share/get are known; --no-typecheck runs anyway", { skip: runtimes }, async () => {
  const good = notebook("typed-ok.ipynb", [
    { lang: "typescript", source: "const greeting = 'hi';\nlet count = 0;" },
    { lang: "typescript", source: "count = count + 1;\nconst cwd = Deno.cwd();\nawait share('g', { greeting });\nconst back = await get<{ greeting: string }>('g');\nconsole.log(greeting.toUpperCase(), back.greeting, typeof cwd);" },
  ]);
  let r = await cli("run", good);
  assert.equal(r.code, 0, r.all);
  assert.match(r.stdout, /HI hi string/);

  const bad = notebook("typed-bad.ipynb", [
    { lang: "typescript", source: "interface User { name: string; age: number }\nconst ada: User = { name: 'Ada', age: '36' };\nconsole.log('ran anyway');" },
    { lang: "python", source: "print('python ran')" },
  ]);
  r = await cli("run", bad);
  assert.equal(r.code, 1);
  assert.match(r.stdout, /cell 1 \(typescript\): 1 type error\n\s+line 2: Type 'string' is not assignable to type 'number'/);
  assert.doesNotMatch(r.stdout, /ran anyway|python ran/, "type errors stop the notebook before it runs");
  r = await cli("run", bad, "--no-typecheck");
  assert.equal(r.code, 0, r.all);
  assert.match(r.stdout, /ran anyway/);
  assert.match(r.stdout, /python ran/);
  r = await cli("run", bad, "--keep-going");
  assert.equal(r.code, 1, "type errors still fail the run");
  assert.match(r.stdout, /python ran/, "--keep-going runs the cells despite type errors");
});

test("--mode sets POLYGLOT_TUTOR_MODE and --env adds variables in both kernels", { skip: runtimes }, async () => {
  const nb = notebook("mode.ipynb", [
    { lang: "typescript", source: "console.log('ts', Deno.env.get('POLYGLOT_TUTOR_MODE'), Deno.env.get('COURSE') ?? '-');" },
    { lang: "python", source: "import os\nprint('py', os.environ.get('POLYGLOT_TUTOR_MODE'), os.environ.get('COURSE', '-'))" },
  ]);
  let r = await cli("run", nb);
  assert.equal(r.code, 0, r.all);
  assert.match(r.stdout, /ts learner -/);
  assert.match(r.stdout, /py learner -/);
  r = await cli("run", nb, "--mode", "solutions", "--env", "COURSE=aef");
  assert.equal(r.code, 0, r.all);
  assert.match(r.stdout, /ts solutions aef/);
  assert.match(r.stdout, /py solutions aef/);
});

test("a deno.json in a parent folder of the notebook applies too, and relative paths still resolve from the notebook's folder", { skip: runtimes }, async () => {
  const root = path.join(tmp, "course-parent");
  const nbDir = path.join(root, "notebooks");
  mkdirSync(nbDir, { recursive: true });
  writeFileSync(path.join(root, "deno.json"), JSON.stringify({ imports: { zod: "npm:zod@4" } }));
  writeFileSync(path.join(nbDir, "here.txt"), "beside the notebook");
  const nb = notebook(
    "parent.ipynb",
    [
      {
        lang: "typescript",
        source: "import { z } from 'zod';\nimport { readFileSync } from 'node:fs';\nconsole.log(typeof z.object, readFileSync('here.txt', 'utf8'));",
      },
    ],
    nbDir,
  );
  const r = await cli("run", nb);
  assert.equal(r.code, 0, r.all);
  assert.match(r.stdout, /function beside the notebook/);
});

test("a deno.json import map next to the notebook applies to type checking (real package types) and to running; a bogus package reports Deno's error", { skip: runtimes }, async () => {
  const dir = path.join(tmp, "course");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "deno.json"), JSON.stringify({ imports: { zod: "npm:zod@4" } }));
  const nb = notebook(
    "mapped.ipynb",
    [
      { lang: "typescript", source: "import { z } from 'zod';\nconst schema = z.string();\nconsole.log(schema.parse('mapped'), typeof z.object);" },
      { lang: "typescript", source: "const n: number = schema.parse('x');\nconsole.log(n);" },
    ],
    dir,
  );
  let r = await cli("run", nb);
  assert.equal(r.code, 1, r.all);
  assert.match(r.stdout, /cell 2 \(typescript\): 1 type error\n\s+line 1: Type 'string' is not assignable to type 'number'/, "Zod's real types reach the next cell");
  r = await cli("run", nb, "--no-typecheck", "--keep-going");
  assert.match(r.stdout, /mapped function/, "the kernel resolves the bare name through the notebook folder's deno.json");

  const bogus = notebook("bogus.ipynb", [{ lang: "typescript", source: "import x from 'npm:polyglot-tutor-no-such-package-zz@1';\nconsole.log(x);" }], dir);
  r = await cli("run", bogus);
  assert.equal(r.code, 1);
  assert.match(r.stdout, /line 1: Cannot find module 'npm:polyglot-tutor-no-such-package-zz@1'[^\n]*\n\s+Deno: /);
});

test("--timeout interrupts a cell that runs too long", { skip: runtimes }, async () => {
  const nb = notebook("slow.ipynb", [
    { lang: "python", source: "import time\ntime.sleep(60)" },
    { lang: "python", source: "print('later')" },
  ]);
  const r = await cli("run", nb, "--timeout", "2", "--keep-going");
  assert.equal(r.code, 1);
  assert.match(r.stdout, /cell 1 timed out after 2 s/);
  assert.match(r.stdout, /later/, "the kernel is usable after the interrupt");
  assert.doesNotMatch(r.stdout, /KernelDead/);
  const j = await cli("run", nb, "--timeout", "2", "--json");
  const report = JSON.parse(j.stdout) as RunReport;
  assert.deepEqual(report.notebooks[0].cells.map((c) => c.status), ["timeout", "not-run"]);
  const slow = report.notebooks[0].cells[0];
  assert.ok(slow.outputs.some((o) => o.kind === "error" && o.ename === "KeyboardInterrupt") || slow.restarted, "the interrupt reached the kernel, or the kernel was restarted");
});

test("--json prints a report with per-cell status and outputs, and nothing else on stdout", { skip: runtimes }, async () => {
  const nb = notebook("json.ipynb", [
    { lang: "python", source: "print('out')" },
    { lang: "typescript", source: "const s: string = 1;" },
    { prompt: "skip me" },
    { lang: "sql", source: "select 1 as one" },
  ]);
  let r = await cli("run", nb, "--json", "--keep-going", "--mode", "solutions");
  assert.equal(r.code, 1);
  const report = JSON.parse(r.stdout) as RunReport;
  assert.equal(report.ok, false);
  assert.equal(report.mode, "solutions");
  const [n] = report.notebooks;
  assert.equal(n.file, nb);
  assert.equal(n.skippedPrompts, 1);
  assert.deepEqual(n.typeErrors, [{ cellId: "c1", index: 2, messages: ["line 1: Type 'number' is not assignable to type 'string'."] }]);
  assert.deepEqual(n.cells.map((c) => [c.index, c.type, c.status]), [[1, "code", "ok"], [2, "code", "ok"], [3, "prompt", "skipped"], [4, "code", "ok"]]);
  assert.deepEqual(n.cells[0].outputs, [{ kind: "stream", name: "stdout", text: "out\n" }]);
  assert.ok(n.cells[3].outputs.some((o) => o.kind === "display" && "text/html" in o.data), "SQL result captured");
  assert.ok(n.cells.every((c) => c.status !== "ok" || typeof c.ms === "number"));
  r = await cli("run", nb, "--json");
  const stopped = JSON.parse(r.stdout) as RunReport;
  assert.deepEqual(stopped.notebooks[0].cells.map((c) => c.status), ["not-run", "not-run", "skipped", "not-run"], "type errors keep the cells from running without --keep-going");
});

test("a notebook that can't be read is reported, and the other notebooks still run", { skip: runtimes }, async () => {
  const broken = path.join(tmp, "broken.ipynb");
  writeFileSync(broken, "{not json");
  const ok = notebook("fine.ipynb", [{ lang: "python", source: "print('fine')" }]);
  const r = await cli("run", broken, ok);
  assert.equal(r.code, 1);
  assert.match(r.stdout, /could not read broken\.ipynb/);
  assert.match(r.stdout, /fine\n/);
  assert.match(r.stdout, /✗ 2 notebooks, 1 failed/);
});
