import assert from "node:assert/strict";
import { test } from "node:test";
import { cacheInfoFor, formatCountdown, hashCell, staleFrom, toContextCells } from "../src/context.ts";
import type { Cell } from "../src/types.ts";

const nb = (): Cell[] => [
  { id: "a", type: "markdown", source: "# hi", outputs: [] },
  { id: "b", type: "code", lang: "python", source: "1", outputs: [], hidden: true },
  { id: "c", type: "code", lang: "typescript", source: "2", outputs: [] },
  { id: "d", type: "prompt", source: "q", response: "r", outputs: [] },
];

test("context skips hidden cells but keeps notebook numbering", () => {
  const ctx = toContextCells(nb(), 3);
  assert.deepEqual(ctx.map((c) => [c.id, c.index]), [["a", 1], ["c", 3]]);
});

test("cache goes stale from the first edited cell", () => {
  const cells = nb();
  const cache = cacheInfoFor({ cells: toContextCells(cells, 4) }, { model: "m", ttlMs: 1000, startedAt: 0, readTokens: 1, writeTokens: 0 })!;
  assert.equal(staleFrom(cells, cache), null);
  cells[2] = { ...cells[2], source: "3" };
  assert.equal(staleFrom(cells, cache), 3);
  assert.equal(cacheInfoFor({ cells: [] }, null), null);
});

test("hash ignores type errors", () => {
  const [c] = toContextCells(nb(), 1);
  assert.equal(hashCell(c), hashCell({ ...c, typeErrors: ["x"] }));
});

test("countdown formatting", () => {
  assert.equal(formatCountdown(3_599_000), "59:59");
  assert.equal(formatCountdown(-5), "0:00");
});
