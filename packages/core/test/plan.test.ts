import assert from "node:assert/strict";
import { test } from "node:test";
import { budgetSteps, estimateContext, layoutBlocks } from "../src/plan.ts";
import { DEFAULT_SETTINGS, type ContextCell } from "../src/types.ts";

const cells = (n: number, outLen = 400): ContextCell[] =>
  Array.from({ length: n }, (_, i) => ({
    id: `c${i + 1}`,
    index: i + 1,
    type: "code",
    lang: "python",
    source: `x${i + 1} = ${i + 1}`,
    outputs: [{ kind: "stream", name: "stdout", text: "v".repeat(outLen) + "\n" }],
  }));

const ctx = { recentCells: 5, blockSize: 5, tokenBudget: 1_000_000, outputLimit: 2000 };

test("recent window = ceil(recent/B) + 1 blocks; older blocks are compact", () => {
  const blocks = layoutBlocks(cells(23), ctx);
  assert.deepEqual(blocks.map((b) => b.tier), ["compact", "compact", "compact", "recent", "recent"]);
  assert.deepEqual([blocks[0].first, blocks[0].last, blocks[4].first, blocks[4].last], [1, 5, 21, 23]);
  assert.match((blocks[0].parts[0] as any).text, /<output_summary>/);
  assert.match((blocks[4].parts[0] as any).text, /<output>\n/);
});

test("over budget: oldest compact blocks are summarised first, recent never", () => {
  const blocks = layoutBlocks(cells(23, 3000), { ...ctx, tokenBudget: 10 });
  const asked: number[] = [];
  const steps = budgetSteps(blocks, 10);
  for (let r = steps.next(); !r.done; ) {
    asked.push(r.value);
    r = steps.next("short");
  }
  assert.deepEqual(asked, [0, 1, 2]);
  assert.equal(blocks[0].tier, "summary");
  assert.equal((blocks[0].parts[0] as any).text, '<summary cells="1-5">\nshort\n</summary>');
  assert.equal(blocks[3].tier, "recent");
});

test("stops summarising once under budget", () => {
  const blocks = layoutBlocks(cells(23, 3000), ctx);
  const total = blocks.reduce((a, b) => a + b.tokens, 0);
  const steps = budgetSteps(blocks, total - 1); // one summary is enough
  let n = 0;
  for (let r = steps.next(); !r.done; r = steps.next("s")) n++;
  assert.equal(n, 1);
});

test("charts in recent cells count as images", () => {
  const c = cells(2);
  c[1].outputs = [{ kind: "display", data: { "image/png": "AAAA" } }];
  const blocks = layoutBlocks(c, ctx);
  assert.equal(blocks[0].images, 1);
  assert.ok(blocks[0].parts.some((p) => p.type === "image"));
});

test("estimate breaks the context down and reports budget + window", () => {
  const e = estimateContext(cells(23), { context: ctx, learnerProfile: "new to TS", model: DEFAULT_SETTINGS.model }, "why?");
  assert.equal(e.budget, ctx.tokenBudget);
  assert.equal(e.window, 1_000_000);
  assert.ok(e.parts.system > 500 && e.parts.compact > 0 && e.parts.recent > 0 && e.parts.question > 0);
  assert.equal(e.tokens, Object.values(e.parts).reduce((a, b) => a + b, 0));
  const tight = estimateContext(cells(23, 3000), { context: { ...ctx, tokenBudget: 3000 }, learnerProfile: "", model: "x" });
  assert.equal(tight.summarizedBlocks, 3);
  assert.ok(tight.parts.summaries > 0);
});
