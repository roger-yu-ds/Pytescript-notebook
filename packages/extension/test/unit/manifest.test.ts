import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { DEFAULT_SETTINGS, MODELS } from "@polyglot-tutor/core/browser";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
const source = readdirSync(path.join(root, "src"))
  .map((f) => readFileSync(path.join(root, "src", f), "utf8"))
  .join("\n");

test("every declared command is registered, and every registered command is declared", () => {
  const declared = new Set<string>(pkg.contributes.commands.map((c: any) => c.command));
  const registered = new Set([...source.matchAll(/reg\("(\w+)"/g)].map((m) => `polyglotTutor.${m[1]}`));
  assert.deepEqual([...declared].sort(), [...registered].sort());
});

test("commands and settings used in code exist", () => {
  const declared = new Set<string>([
    ...pkg.contributes.commands.map((c: any) => c.command),
    ...Object.keys(pkg.contributes.configuration.properties),
    ...pkg.contributes.colors.map((c: any) => c.id),
  ]);
  for (const m of source.matchAll(/"(polyglotTutor\.[a-zA-Z.]+)"/g)) {
    // Ids of status bar items, views, storage keys and context keys.
    if (/^polyglotTutor\.(model|context|cache|kernel\.|shared|anthropicApiKey|reopenDeclined|pythonEnvAsked|notebookActive)$/.test(m[1])) continue;
    assert.ok(declared.has(m[1]), `${m[1]} is not declared`);
  }
});

test("settings defaults match core's defaults and model list", () => {
  const props = pkg.contributes.configuration.properties;
  assert.equal(props["polyglotTutor.model"].default, DEFAULT_SETTINGS.model);
  assert.equal(props["polyglotTutor.summaryModel"].default, DEFAULT_SETTINGS.summaryModel);
  assert.equal(props["polyglotTutor.context.tokenBudget"].default, DEFAULT_SETTINGS.context.tokenBudget);
  assert.equal(props["polyglotTutor.context.blockSize"].default, DEFAULT_SETTINGS.context.blockSize);
  assert.equal(props["polyglotTutor.cacheLifetime"].default, DEFAULT_SETTINGS.cacheTtl);
  assert.deepEqual([...props["polyglotTutor.model"].enum].sort(), MODELS.map((m) => m.id).sort());
});

test("ring icons point at the bundled font", () => {
  const icons = pkg.contributes.icons;
  assert.equal(Object.keys(icons).length, 9);
  for (const icon of Object.values<any>(icons)) assert.ok(existsSync(path.join(root, icon.default.fontPath)));
  assert.match(source, /\$\(polyglot-ring-\$\{/);
});

test("the renderer, grammar and tsserver plugin entries exist", () => {
  assert.equal(pkg.contributes.notebookRenderer[0].entrypoint, "./dist/renderer.js");
  assert.ok(existsSync(path.join(root, pkg.contributes.grammars[0].path)));
  // The plugin is bundled by build.mjs into node_modules/<name>/index.js, which scripts/package.mjs ships.
  const plugin = JSON.parse(readFileSync(path.join(root, "ts-plugin/package.json"), "utf8"));
  assert.ok(existsSync(path.join(root, "ts-plugin", "index.ts")));
  assert.equal(plugin.main, "index.js");
  assert.equal(pkg.contributes.typescriptServerPlugins[0].name, plugin.name);
  const build = readFileSync(path.join(root, "build.mjs"), "utf8");
  assert.match(build, /entryPoints: \["ts-plugin\/index\.ts"\], outfile: "node_modules\/polyglot-tutor-ts-plugin\/index\.js"/);
  assert.match(build, /external: \["typescript", "typescript-6"\]/, "tsserver supplies its own TypeScript");
  assert.match(readFileSync(path.join(root, "scripts/package.mjs"), "utf8"), /node_modules\/polyglot-tutor-ts-plugin/);
});

test("the T / Y / P cell-language keys are bound in notebook command mode only", () => {
  const keys = pkg.contributes.keybindings as { command: string; key: string; when: string }[];
  assert.deepEqual(
    keys.map((k) => [k.key, k.command]),
    [["t", "polyglotTutor.cellToTypeScript"], ["y", "polyglotTutor.cellToPython"], ["p", "polyglotTutor.cellToPrompt"]],
  );
  for (const k of keys) {
    assert.match(k.when, /notebookEditorFocused/, "only while a notebook has focus");
    assert.match(k.when, /!inputFocus/, "never while typing in a cell");
    assert.match(k.when, /notebookType == polyglot-tutor/, "only in our notebooks, so Jupyter's own keys are untouched");
  }
});

test("the prompt-cell tint colours are declared for every kind of theme, and a setting turns the tint off", () => {
  const colors = new Map<string, any>(pkg.contributes.colors.map((c: any) => [c.id, c]));
  for (const id of ["polyglotTutor.promptCellBackground", "polyglotTutor.promptCellRuler"]) {
    const c = colors.get(id);
    assert.ok(c, `${id} is not declared`);
    for (const kind of ["dark", "light", "highContrast", "highContrastLight"]) assert.match(c.defaults[kind], /^#[0-9a-f]{6}([0-9a-f]{2})?$/i, `${id}: ${kind}`);
    assert.ok(source.includes(`"${id}"`), `${id} is not used`);
  }
  // A background must stay translucent so the selection and text stay readable.
  for (const kind of ["dark", "light"]) assert.equal(colors.get("polyglotTutor.promptCellBackground").defaults[kind].length, 9);
  assert.equal(pkg.contributes.configuration.properties["polyglotTutor.tintPromptCells"].default, true);
});
