// Runs the extension's integration tests in a downloaded VS Code with real
// kernels and a mock Anthropic API.
//
//   npm test -w polyglot-tutor
//
// Needs a display (WSLg, a desktop, or xvfb-run on CI). Runtime paths come from
// POLYGLOT_PYTHON / POLYGLOT_DENO, defaulting to the repo's .venv and ~/.deno.
// With --vsix, the tests run against the packaged extension (what users install).
import { downloadAndUnzipVSCode, runTests } from "@vscode/test-electron";
import * as esbuild from "esbuild";
import { spawn, execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const ext = path.resolve(here, "..");
const repo = path.resolve(ext, "../..");
const win = process.platform === "win32";

const python = process.env.POLYGLOT_PYTHON ?? path.join(repo, ".venv", win ? "Scripts/python.exe" : "bin/python");
const deno = process.env.POLYGLOT_DENO ?? path.join(os.homedir(), ".deno", "bin", win ? "deno.exe" : "deno");

const tmp = mkdtempSync(path.join(os.tmpdir(), "polyglot-ext-test-"));
let extensionDevelopmentPath = ext;
if (process.argv.includes("--vsix")) {
  const vsix = path.join(tmp, "polyglot-tutor.vsix");
  execFileSync(process.execPath, [path.join(ext, "scripts/package.mjs"), "--out", vsix], { stdio: "inherit" });
  const unpacked = path.join(tmp, "vsix");
  execFileSync(win ? "python" : "python3", ["-c", "import sys, zipfile; zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])", vsix, unpacked]);
  extensionDevelopmentPath = path.join(unpacked, "extension");
} else {
  execFileSync(process.execPath, [path.join(ext, "build.mjs")], { stdio: "inherit" });
}
await esbuild.build({
  entryPoints: [path.join(here, "integration/suite.ts")],
  outfile: path.join(ext, "dist-test/suite.js"),
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node20",
  external: ["vscode"],
  logLevel: "warning",
});

const workspace = path.join(tmp, "workspace");
mkdirSync(path.join(workspace, ".vscode"), { recursive: true });
writeFileSync(path.join(workspace, ".vscode", "settings.json"), JSON.stringify({ "polyglotTutor.pythonPath": python, "polyglotTutor.denoPath": deno, ...(process.env.TSSERVER_LOG ? { "typescript.tsserver.log": "verbose" } : {}) }, null, 2));

const mockLog = path.join(tmp, "mock.log");
const mockPort = 18797;
const mock = spawn(process.execPath, [path.join(repo, "tests/mock-anthropic.cjs"), mockLog, String(mockPort)], { stdio: "ignore" });

let code = 1;
try {
  const vscodeExecutablePath = await downloadAndUnzipVSCode({ version: process.env.VSCODE_VERSION ?? "stable", cachePath: path.join(ext, ".vscode-test") });
  await runTests({
    vscodeExecutablePath,
    extensionDevelopmentPath,
    extensionTestsPath: path.join(ext, "dist-test/suite.js"),
    launchArgs: [workspace, "--disable-extensions", "--disable-gpu", "--disable-workspace-trust", `--user-data-dir=${path.join(tmp, "user-data")}`, "--skip-welcome", "--skip-release-notes"],
    extensionTestsEnv: {
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${mockPort}`,
      ANTHROPIC_API_KEY: "test-key",
      MOCK_LOG: mockLog,
    },
  });
  code = 0;
} catch (e) {
  console.error(String(e));
} finally {
  mock.kill();
  if (code === 0 && !process.env.KEEP) rmSync(tmp, { recursive: true, force: true });
  else console.log(`artifacts kept in ${tmp}`);
}
process.exit(code);
