import assert from "node:assert/strict";
import { test } from "node:test";
import { fromIpynb, isPolyglotIpynb, toIpynb } from "../src/ipynb.ts";
import type { Notebook } from "../src/types.ts";

const nb: Notebook = {
  name: "t.ipynb",
  cells: [
    { id: "m1", type: "markdown", source: "# Title", outputs: [] },
    {
      id: "c1",
      type: "code",
      lang: "typescript",
      source: "console.log(1)\nconst x = 2;",
      outputs: [{ kind: "stream", name: "stdout", text: "1\n" }],
      executionCount: 3,
      pinned: true,
    },
    { id: "c2", type: "code", lang: "sql", source: "select 1", outputs: [{ kind: "display", data: { "text/plain": "1", "text/html": "<table/>" } }], executionCount: null },
    { id: "c3", type: "code", lang: "python", source: "1/0", outputs: [{ kind: "error", ename: "ZeroDivisionError", evalue: "division by zero", traceback: ["a", "b"] }], executionCount: null },
    {
      id: "p1",
      type: "prompt",
      source: "Why?",
      response: "Because.",
      mode: "answer",
      outputs: [],
      hidden: true,
      thinking: "hmm",
      usage: { model: "m", inputTokens: 1, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.1 },
    },
  ],
};

test("round-trips every cell kind", () => {
  const raw = JSON.parse(JSON.stringify(toIpynb(nb)));
  assert.ok(isPolyglotIpynb(raw));
  const back = fromIpynb("t.ipynb", raw);
  assert.deepEqual(back.cells, nb.cells);
  assert.equal((back.meta?.kernelspec as any).name, "python3");
  assert.deepEqual(toIpynb(back), toIpynb(nb), "second save is identical");
});

test("prompt cells are readable markdown elsewhere", () => {
  const raw = toIpynb(nb);
  const p = raw.cells[4];
  assert.equal(p.cell_type, "markdown");
  assert.match(p.source.join(""), /Prompt \(answer\):\*\* Why\?[\s\S]*Because\./);
  assert.equal(p.metadata.polyglot.type, "prompt");
});

test("keeps foreign metadata (tags, kernelspec) and defaults the language from the kernelspec", () => {
  const foreign = {
    nbformat: 4,
    nbformat_minor: 5,
    metadata: { kernelspec: { name: "deno", display_name: "Deno", language: "typescript" }, custom: { a: 1 } },
    cells: [{ id: "x", cell_type: "code", metadata: { tags: ["t"] }, source: ["let a = 1"], outputs: [], execution_count: null }],
  };
  const parsed = fromIpynb("f.ipynb", foreign);
  assert.equal(parsed.cells[0].lang, "typescript");
  assert.deepEqual(parsed.cells[0].meta, { tags: ["t"] });
  assert.equal(isPolyglotIpynb(foreign), false);
  const back = toIpynb(parsed);
  assert.deepEqual(back.metadata.custom, { a: 1 });
  assert.equal(back.metadata.kernelspec.name, "deno");
  assert.deepEqual(back.cells[0].metadata.tags, ["t"]);
});

test("cells without ids get one", () => {
  const parsed = fromIpynb("x.ipynb", { cells: [{ cell_type: "markdown", source: "hi" }] });
  assert.match(parsed.cells[0].id, /^[a-z0-9]{8}$/);
});
