// Frozen-block context planning, shared by the tutor (which sends the request)
// and the context ring (which estimates it). Browser-safe.
//
// Cells are grouped into fixed blocks of `blockSize`. The last `recentBlocks`
// blocks are sent verbatim (with chart images); older blocks are sent compact
// (source + one-line output stubs); if the total is over the token budget, the
// oldest compact blocks are replaced by summaries. A block's rendering only
// changes when the window moves (every `blockSize` cells) or the budget is
// crossed, so the cached prefix stays valid in between.

import { IMAGE_TOKENS, MAX_IMAGE_B64, estTokens, pngs, renderCell, renderQuestion } from "./render.ts";
import { TUTOR_PROMPT, profileText } from "./prompts.ts";
import { modelInfo, type ContextCell, type ContextEstimate, type ContextSettings } from "./types.ts";

export type Part = { type: "text"; text: string } | { type: "image"; data: string };
export type Tier = "recent" | "compact" | "summary";

export interface PlannedBlock {
  first: number; // notebook index of the first cell
  last: number;
  tier: Tier;
  parts: Part[];
  tokens: number;
  images: number;
}

/** Lay cells out into blocks (recent / compact), before any budget is applied. */
export function layoutBlocks(cells: ContextCell[], ctx: ContextSettings): PlannedBlock[] {
  const B = Math.max(1, Math.floor(ctx.blockSize));
  const nBlocks = Math.ceil(cells.length / B);
  const recentBlocks = Math.ceil(Math.max(0, ctx.recentCells) / B) + 1;
  const firstRecent = Math.max(0, nBlocks - recentBlocks);
  const blocks: PlannedBlock[] = [];
  for (let k = 0; k < nBlocks; k++) {
    const blockCells = cells.slice(k * B, (k + 1) * B);
    const recent = k >= firstRecent;
    const parts: Part[] = [];
    let tokens = 0;
    let images = 0;
    for (const c of blockCells) {
      const imgs = recent ? pngs(c).filter((b) => b.length <= MAX_IMAGE_B64) : [];
      const text = renderCell(c, recent ? "full" : "compact", ctx.outputLimit, imgs.length);
      parts.push({ type: "text", text });
      tokens += estTokens(text);
      for (const data of imgs) {
        parts.push({ type: "image", data });
        tokens += IMAGE_TOKENS;
        images++;
      }
    }
    blocks.push({ first: blockCells[0].index, last: blockCells[blockCells.length - 1].index, tier: recent ? "recent" : "compact", parts, tokens, images });
  }
  return blocks;
}

/** The text a compact block is summarised from. */
export const blockText = (b: PlannedBlock) => b.parts.map((p) => (p.type === "text" ? p.text : "")).join("\n");

export const summaryBlockText = (b: Pick<PlannedBlock, "first" | "last">, summary: string) =>
  `<summary cells="${b.first}-${b.last}">\n${summary}\n</summary>`;

/**
 * Applies the token budget: while over budget, the oldest compact block is
 * replaced by its summary. Yields the index of each block to summarise and
 * expects the summary text back, so callers can produce summaries however they
 * like (the tutor asks the model; the estimate uses a stand-in).
 */
export function* budgetSteps(blocks: PlannedBlock[], budget: number): Generator<number, void, string> {
  let total = blocks.reduce((a, b) => a + b.tokens, 0);
  for (let k = 0; k < blocks.length && blocks[k].tier === "compact" && total > budget; k++) {
    const summary: string = yield k;
    const text = summaryBlockText(blocks[k], summary);
    const tokens = estTokens(text);
    total += tokens - blocks[k].tokens;
    blocks[k] = { ...blocks[k], tier: "summary", parts: [{ type: "text", text }], tokens, images: 0 };
  }
}

/** Typical summary length (the summary prompt asks for under 250 words). */
const SUMMARY_ESTIMATE = "x".repeat(1_400);

export interface EstimateOptions {
  context: ContextSettings;
  learnerProfile: string;
  model: string;
  /** Known summaries by block range ("first-last"), e.g. from an earlier answer. */
  summaries?: Map<string, string>;
}

/** Estimate what the next question would send, for the context ring. */
export function estimateContext(cells: ContextCell[], opts: EstimateOptions, question = ""): ContextEstimate {
  const blocks = layoutBlocks(cells, opts.context);
  const steps = budgetSteps(blocks, opts.context.tokenBudget);
  for (let r = steps.next(); !r.done; ) {
    const b = blocks[r.value];
    r = steps.next(opts.summaries?.get(`${b.first}-${b.last}`) ?? SUMMARY_ESTIMATE);
  }
  const parts = { system: estTokens(TUTOR_PROMPT), summaries: 0, compact: 0, recent: 0, images: 0, question: estTokens(renderQuestion("hint", question)) };
  if (opts.learnerProfile.trim()) parts.system += estTokens(profileText(opts.learnerProfile));
  for (const b of blocks) {
    const imageTokens = b.images * IMAGE_TOKENS;
    parts.images += imageTokens;
    if (b.tier === "summary") parts.summaries += b.tokens;
    else if (b.tier === "compact") parts.compact += b.tokens - imageTokens;
    else parts.recent += b.tokens - imageTokens;
  }
  const tokens = Object.values(parts).reduce((a, b) => a + b, 0);
  return {
    tokens,
    budget: opts.context.tokenBudget,
    window: modelInfo(opts.model).contextWindow,
    parts,
    summarizedBlocks: blocks.filter((b) => b.tier === "summary").length,
  };
}

/** Human-readable lines describing an estimate (tooltips in both front ends). */
export function describeEstimate(e: ContextEstimate): string[] {
  const pct = (n: number, of: number) => `${Math.round((100 * n) / of)}%`;
  const k = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
  return [
    `Context for the next question: ~${k(e.tokens)} tokens`,
    `${pct(e.tokens, e.budget)} of your ${k(e.budget)}-token budget (older cells get summarised above it)`,
    `${pct(e.tokens, e.window)} of the model's ${k(e.window)}-token context window`,
    "",
    `System prompt ${k(e.parts.system)} · summaries ${k(e.parts.summaries)}${e.summarizedBlocks ? ` (${e.summarizedBlocks} blocks)` : ""}`,
    `Older cells (compact) ${k(e.parts.compact)} · recent cells ${k(e.parts.recent)} · charts ${k(e.parts.images)}`,
  ];
}
