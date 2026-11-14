// Bundles the extension (Node, CommonJS) and the answer renderer (browser, ESM).
//   node build.mjs [--production] [--watch]
import * as esbuild from "esbuild";
import { copyFileSync, mkdirSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const production = process.argv.includes("--production");
const watch = process.argv.includes("--watch");

const common = { bundle: true, minify: production, sourcemap: production ? false : "linked", logLevel: "info", absWorkingDir: here };

// The tsserver plugin must live in the extension's own node_modules. tsserver hands it its own `typescript`, so that stays external.
const pluginDir = path.join(here, "node_modules/polyglot-tutor-ts-plugin");

const builds = [
  { ...common, entryPoints: ["src/extension.ts"], outfile: "dist/extension.js", platform: "node", format: "cjs", target: "node20", external: ["vscode"] },
  { ...common, entryPoints: ["renderer/answer.ts"], outfile: "dist/renderer.js", platform: "browser", format: "esm", target: "es2022" },
  { ...common, entryPoints: ["ts-plugin/index.ts"], outfile: "node_modules/polyglot-tutor-ts-plugin/index.js", platform: "node", format: "cjs", target: "node20", external: ["typescript", "typescript-6"] },
];

// TypeScript's standard library declarations for the cell type checker.
const tsLib = path.join(path.dirname(require.resolve("typescript-6/package.json")), "lib");
mkdirSync(path.join(here, "dist/ts-lib"), { recursive: true });
for (const f of readdirSync(tsLib)) if (/^lib\.(es\d+|esnext|decorators)[\w.]*\.d\.ts$|^lib\.d\.ts$/.test(f)) copyFileSync(path.join(tsLib, f), path.join(here, "dist/ts-lib", f));

mkdirSync(pluginDir, { recursive: true });
copyFileSync(path.join(here, "ts-plugin", "package.json"), path.join(pluginDir, "package.json"));

// The license ships with the extension (single source at the repo root).
copyFileSync(path.join(here, "../../LICENSE"), path.join(here, "LICENSE"));

// The welcome tour ships inside the extension.
mkdirSync(path.join(here, "media"), { recursive: true });
copyFileSync(path.join(here, "../../examples/welcome.ipynb"), path.join(here, "media/welcome.ipynb"));

if (watch) {
  for (const b of builds) await (await esbuild.context(b)).watch();
} else {
  await Promise.all(builds.map((b) => esbuild.build(b)));
}
