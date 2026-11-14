// Test coverage with c8: runs the Node test suites (unit, CLI and, with --web,
// the web app's e2e) under V8 coverage, prints a report for everything, and
// gates per-file thresholds on the files that are new or changed in this branch
// (GATED below). The VS Code extension's host code runs inside Electron, so it
// is reported but not gated.
//
//   npm run coverage          # unit + CLI
//   npm run coverage -- --web # plus the web e2e (CI)

import { spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const web = process.argv.includes("--web");
const c8 = path.join(root, "node_modules", "c8", "bin", "c8.js");
const npm = process.env.npm_execpath;

/** Files whose coverage is gated, with the minimum % of lines each must reach (c8 attributes lines a little differently per OS, so each has room below its lowest measurement). */
const GATED = {
  "packages/core/src/cell-links.ts": 80,
  "packages/core/src/checker.ts": 90,
  "packages/core/src/deno-resolver.ts": 70, // the rest is Windows copy fallbacks and the size-limit path

  "packages/core/src/module-shims.ts": 95,
  "packages/core/src/typescript.ts": 90,
  "packages/core/src/jupyter.ts": 60,
  "packages/core/src/session.ts": 75, // the link fallback and junction paths differ per OS
  "packages/cli/src/args.ts": 90,
  "packages/cli/src/run.ts": 90,
  "packages/cli/src/main.ts": 90,
  "packages/extension/ts-plugin/index.ts": 80,
  ...(web ? { "packages/server/src/index.ts": 70 } : {}),
};

function run(args, label) {
  console.log(`\n── ${label} ──`);
  const r = spawnSync(process.execPath, args, { cwd: root, stdio: "inherit" });
  if (r.status !== 0) {
    console.error(`✗ ${label} failed (exit ${r.status ?? r.signal})`);
    process.exit(r.status ?? 1);
  }
}

const under = (script) => (npm ? [c8, "--no-clean", "--reporter=none", process.execPath, npm, "run", script] : [c8, "--no-clean", "--reporter=none", "npm", "run", script]);

rmSync(path.join(root, "coverage"), { recursive: true, force: true });
run(under("test:unit"), "unit tests (core + extension)");
run(under("test:cli"), "CLI tests (real kernels)");
if (web) run(under("test:web"), "web app e2e");

run([c8, "report"], "coverage (all source files, informational)");

// Gate: one c8 check per threshold group, so each file gets its own bar.
const groups = new Map();
for (const [file, lines] of Object.entries(GATED)) groups.set(lines, [...(groups.get(lines) ?? []), file]);
let failed = false;
for (const [lines, files] of groups) {
  const r = spawnSync(process.execPath, [c8, "report", "--reporter=text-summary", "--check-coverage", "--per-file", `--lines=${lines}`, "--functions=0", "--branches=0", "--statements=0", ...files.flatMap((f) => ["--include", f])], { cwd: root, stdio: "pipe", encoding: "utf8" });
  if (r.status !== 0) {
    failed = true;
    console.error(`\n✗ below ${lines}% lines:\n${(r.stderr || r.stdout).trim()}`);
  }
}
if (failed) process.exit(1);
console.log(`\n✓ coverage gate passed for ${Object.keys(GATED).length} new or changed files`);
