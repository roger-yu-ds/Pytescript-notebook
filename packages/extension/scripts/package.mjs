// Packages the extension as a .vsix from a clean staging folder, so the
// tsserver plugin can ship in node_modules (vsce only includes node_modules
// entries it can see as production dependencies, which npm workspaces hide).
//   node scripts/package.mjs [--out file.vsix]
import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ext = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const outArg = process.argv.indexOf("--out");
const out = path.resolve(outArg > 0 ? process.argv[outArg + 1] : path.join(ext, "polyglot-tutor.vsix"));

execFileSync(process.execPath, [path.join(ext, "build.mjs"), "--production"], { stdio: "inherit" });

const stage = mkdtempSync(path.join(os.tmpdir(), "polyglot-tutor-vsix-"));
try {
  for (const f of ["README.md", "CHANGELOG.md", "LICENSE", ".vscodeignore", "dist", "media", "syntaxes", "node_modules/polyglot-tutor-ts-plugin"]) {
    cpSync(path.join(ext, f), path.join(stage, f), { recursive: true });
  }
  const pkg = JSON.parse(readFileSync(path.join(ext, "package.json"), "utf8"));
  const plugin = JSON.parse(readFileSync(path.join(ext, "ts-plugin/package.json"), "utf8"));
  delete pkg.devDependencies;
  pkg.scripts = {};
  pkg.dependencies = { [plugin.name]: plugin.version };
  writeFileSync(path.join(stage, "package.json"), JSON.stringify(pkg, null, 2));
  // Within the stage, node_modules holds only the plugin.
  writeFileSync(path.join(stage, ".vscodeignore"), readFileSync(path.join(ext, ".vscodeignore"), "utf8").replace(/^node_modules\/\*\*\n!node_modules\/polyglot-tutor-ts-plugin\/\*\*\n/m, ""));
  const vsce = path.join(path.dirname(require.resolve("@vscode/vsce/package.json")), "vsce");
  execFileSync(process.execPath, [vsce, "package", "--out", out], { cwd: stage, stdio: "inherit" });
} finally {
  rmSync(stage, { recursive: true, force: true });
}
