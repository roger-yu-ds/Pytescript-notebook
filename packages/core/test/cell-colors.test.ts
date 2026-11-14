import assert from "node:assert/strict";
import { test } from "node:test";
import { CELL_COLOR_KINDS, DEFAULT_CELL_COLORS, cellColorVars, resolveCellColors } from "../src/cell-colors.ts";

test("resolveCellColors fills in the defaults and keeps valid saved colours", () => {
  assert.deepEqual(resolveCellColors(undefined), DEFAULT_CELL_COLORS);
  assert.deepEqual(resolveCellColors(null), DEFAULT_CELL_COLORS);
  const c = resolveCellColors({ python: "#ABCDEF", enabled: false });
  assert.equal(c.python, "#abcdef");
  assert.equal(c.enabled, false);
  assert.equal(c.typescript, DEFAULT_CELL_COLORS.typescript);
});

test("resolveCellColors drops anything that is not a #rrggbb colour", () => {
  const c = resolveCellColors({ python: "red", sql: "#12345", prompt: "#1234567", promptBackground: "url(x)", enabled: "yes" as never });
  assert.equal(c.python, DEFAULT_CELL_COLORS.python);
  assert.equal(c.sql, DEFAULT_CELL_COLORS.sql);
  assert.equal(c.prompt, DEFAULT_CELL_COLORS.prompt);
  assert.equal(c.promptBackground, DEFAULT_CELL_COLORS.promptBackground);
  assert.equal(c.enabled, true);
});

test("cellColorVars gives one CSS variable per cell kind plus the prompt background", () => {
  const vars = cellColorVars(resolveCellColors({ sql: "#000000" }));
  assert.deepEqual(Object.keys(vars).sort(), [...CELL_COLOR_KINDS.map((k) => `--lang-${k}`), "--prompt-bg"].sort());
  assert.equal(vars["--lang-sql"], "#000000");
  assert.equal(vars["--prompt-bg"], DEFAULT_CELL_COLORS.promptBackground);
});

test("every default colour is a valid #rrggbb", () => {
  for (const [k, v] of Object.entries(DEFAULT_CELL_COLORS)) if (k !== "enabled") assert.match(v as string, /^#[0-9a-f]{6}$/);
});
