// Builds the tutor request from the notebook cells above a prompt cell and
// streams Claude's answer.
//
// Request layout (◆ = cache breakpoint, TTL from settings):
//   system [tutor + learner profile]◆
//   user   [summaries of old blocks]…[compact cells]…[full recent cells + charts]◆ [question]
//
// See plan.ts for how blocks are tiered and compressed.

import Anthropic from "@anthropic-ai/sdk";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { blockText, budgetSteps, layoutBlocks, type Part } from "./plan.ts";
import { SUMMARY_PROMPT, TUTOR_PROMPT, profileText } from "./prompts.ts";
import { renderQuestion } from "./render.ts";
import { modelInfo, ttlMs, type AskRequest, type CacheHit, type CacheTtl, type PromptUsage } from "./types.ts";

export interface TutorOptions {
  /** Returns the API key; undefined lets the SDK read ANTHROPIC_API_KEY. */
  apiKey?: () => Promise<string | undefined> | string | undefined;
  /** JSON file where block summaries are cached between sessions. */
  summaryCacheFile: string;
  /** Shown when no API key is configured (differs between web app and extension). */
  missingKeyHelp?: string;
}

export interface AskHandlers {
  onText: (text: string) => void;
  onThinking?: (text: string) => void;
}

export interface AskResult {
  usage: PromptUsage;
  cache: CacheHit | null;
  stopReason: string | null;
}

type Block = Anthropic.TextBlockParam | Anthropic.ImageBlockParam;

interface Built {
  system: Anthropic.TextBlockParam[];
  messages: { role: "user"; content: Block[] }[];
  summaryCostUsd: number;
  summarizedBlocks: number;
}

/** Cache writes cost 1.25× input for the 5-minute lifetime and 2× for 1 hour. */
const WRITE_MULTIPLIER = { "5m": 1.25, "1h": 2 } as const;

/** `ttl` prices cache writes when the response doesn't say which lifetime they used. */
export function costOf(model: string, u: Anthropic.Messages.Usage | Anthropic.Beta.BetaUsage, ttl: CacheTtl = "1h"): PromptUsage {
  const m = modelInfo(model);
  const read = u.cache_read_input_tokens ?? 0;
  const write = u.cache_creation_input_tokens ?? 0;
  const split = u.cache_creation;
  const write5m = split ? split.ephemeral_5m_input_tokens : ttl === "5m" ? write : 0;
  const write1h = split ? split.ephemeral_1h_input_tokens : write - write5m;
  const writeCost = (write5m * WRITE_MULTIPLIER["5m"] + write1h * WRITE_MULTIPLIER["1h"]) * m.inputPerMTok;
  const cost = (u.input_tokens * m.inputPerMTok + writeCost + read * m.cacheReadPerMTok + u.output_tokens * m.outputPerMTok) / 1e6;
  return { model, inputTokens: u.input_tokens, outputTokens: u.output_tokens, cacheReadTokens: read, cacheWriteTokens: write, costUsd: cost };
}

const DEFAULT_KEY_HELP = "No Anthropic API key found. Set ANTHROPIC_API_KEY and try again.";

/** A short, learner-friendly message for an error from the API or a kernel. */
/** The network reason under an error, e.g. "ECONNRESET: socket hang up" (fetch wraps it in `cause`). */
export function networkCause(e: unknown): string {
  const seen: string[] = [];
  for (let c = (e as { cause?: unknown })?.cause, depth = 0; c && depth < 5; c = (c as { cause?: unknown }).cause, depth++) {
    const { code, message } = c as { code?: unknown; message?: unknown };
    const text = [typeof code === "string" ? code : "", typeof message === "string" ? message : ""].filter(Boolean).join(": ");
    if (text && !seen.some((s) => s.includes(text))) seen.push(text);
  }
  return seen.at(-1) ?? "";
}

export function describeError(e: unknown, missingKeyHelp = DEFAULT_KEY_HELP): string {
  if (e instanceof Anthropic.APIConnectionTimeoutError) return "The request to the Anthropic API timed out. Run the cell again.";
  if (e instanceof Anthropic.APIConnectionError) {
    const cause = networkCause(e);
    return `Couldn't reach the Anthropic API${cause ? ` (${cause})` : ""}. Check the internet connection (or VPN / proxy), then run the cell again.`;
  }
  if (e instanceof Anthropic.AuthenticationError) return `The Anthropic API rejected the key. ${missingKeyHelp}`;
  if (e instanceof Anthropic.RateLimitError) return "Rate limited by the API. Try again in a moment.";
  if (e instanceof Anthropic.APIError) return `API error ${e.status ?? ""}: ${e.message}`;
  if (e instanceof Error && /authentication method|apiKey/i.test(e.message)) return missingKeyHelp;
  if (e instanceof Error) return e.message;
  return String(e);
}

/** Block summaries, cached on disk keyed by model + block text. */
class SummaryCache {
  private entries: Record<string, string> | null = null;
  constructor(private file: string) {}

  private load() {
    if (this.entries) return this.entries;
    try {
      this.entries = JSON.parse(readFileSync(this.file, "utf8"));
    } catch {
      this.entries = {};
    }
    return this.entries!;
  }

  static key = (model: string, text: string) => createHash("sha256").update(model + "\0" + text).digest("hex");

  get(key: string): string | undefined {
    return this.load()[key];
  }

  set(key: string, value: string) {
    this.load()[key] = value;
    try {
      mkdirSync(path.dirname(this.file), { recursive: true });
      writeFileSync(this.file, JSON.stringify(this.entries));
    } catch {
      /* the cache is best-effort */
    }
  }
}

export class Tutor {
  private client: { key: string | undefined; sdk: Anthropic } | null = null;
  private summaries: SummaryCache;

  constructor(private opts: TutorOptions) {
    this.summaries = new SummaryCache(opts.summaryCacheFile);
  }

  describeError(e: unknown) {
    return describeError(e, this.opts.missingKeyHelp);
  }

  private async sdk(): Promise<Anthropic> {
    const key = (await this.opts.apiKey?.()) || undefined;
    if (!this.client || this.client.key !== key) this.client = { key, sdk: new Anthropic(key ? { apiKey: key } : {}) };
    return this.client.sdk;
  }

  private async summarize(model: string, text: string): Promise<{ text: string; usage: PromptUsage | null }> {
    const key = SummaryCache.key(model, text);
    const cached = this.summaries.get(key);
    if (cached !== undefined) return { text: cached, usage: null };
    const res = await (await this.sdk()).messages.create({
      model,
      max_tokens: 2000,
      system: SUMMARY_PROMPT,
      output_config: { effort: "low" },
      messages: [{ role: "user", content: text }],
    });
    const out = res.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("").trim();
    this.summaries.set(key, out);
    return { text: out, usage: costOf(model, res.usage) };
  }

  private async build(req: AskRequest, withQuestion: boolean): Promise<Built> {
    // Caching off: no breakpoints, so every token is billed as plain input.
    const cache = req.cacheTtl === "off" ? undefined : { type: "ephemeral" as const, ttl: req.cacheTtl };
    const system: Anthropic.TextBlockParam[] = [{ type: "text", text: TUTOR_PROMPT }];
    if (req.learnerProfile.trim()) system.push({ type: "text", text: profileText(req.learnerProfile) });
    if (cache) system[system.length - 1].cache_control = cache;

    const blocks = layoutBlocks(req.cells, req.context);
    let summaryCostUsd = 0;
    const steps = budgetSteps(blocks, req.context.tokenBudget);
    for (let r = steps.next(); !r.done; ) {
      const s = await this.summarize(req.summaryModel, blockText(blocks[r.value]));
      if (s.usage) summaryCostUsd += s.usage.costUsd;
      r = steps.next(s.text);
    }

    const toBlock = (p: Part): Block =>
      p.type === "text" ? { type: "text", text: p.text } : { type: "image", source: { type: "base64", media_type: "image/png", data: p.data } };
    const content: Block[] = blocks.flatMap((b) => b.parts.map(toBlock));
    if (content.length) {
      if (cache) content[content.length - 1].cache_control = cache;
    } else content.push({ type: "text", text: "(The notebook has no cells above this question.)" });
    if (withQuestion) content.push({ type: "text", text: renderQuestion(req.mode, req.question) });
    return { system, messages: [{ role: "user", content }], summaryCostUsd, summarizedBlocks: blocks.filter((b) => b.tier === "summary").length };
  }

  private static params(req: AskRequest) {
    return {
      model: req.model,
      output_config: { effort: req.effort },
      // Summarised reasoning only when the learner turned it on. Same value on
      // keep-warm requests, so thinking settings never split the cache.
      ...(req.showThinking ? { thinking: { type: "adaptive" as const, display: "summarized" as const } } : {}),
      // Refusal fallback: on a policy decline the API re-runs the request on a suitable model.
      ...(modelInfo(req.model).id === req.model && modelInfo(req.model).serverFallback
        ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const }
        : {}),
    };
  }

  private static cacheHit(req: AskRequest, startedAt: number, usage: PromptUsage): CacheHit | null {
    if (req.cacheTtl === "off" || usage.cacheReadTokens + usage.cacheWriteTokens === 0) return null; // off, or prefix too small to cache
    return { model: req.model, ttlMs: ttlMs(req.cacheTtl), startedAt, readTokens: usage.cacheReadTokens, writeTokens: usage.cacheWriteTokens };
  }

  private static withSummaries(usage: PromptUsage, b: Built): PromptUsage {
    return b.summarizedBlocks
      ? { ...usage, costUsd: usage.costUsd + b.summaryCostUsd, summaryCostUsd: b.summaryCostUsd, summarizedBlocks: b.summarizedBlocks }
      : usage;
  }

  /** Stream an answer. */
  async ask(req: AskRequest, h: AskHandlers, signal?: AbortSignal): Promise<AskResult> {
    const built = await this.build(req, true);
    const startedAt = Date.now();
    const stream = (await this.sdk()).beta.messages.stream(
      { ...Tutor.params(req), max_tokens: 32000, system: built.system, messages: built.messages },
      { signal },
    );
    for await (const event of stream) {
      if (event.type !== "content_block_delta") continue;
      if (event.delta.type === "text_delta") h.onText(event.delta.text);
      else if (event.delta.type === "thinking_delta") h.onThinking?.(event.delta.thinking);
    }
    const final = await stream.finalMessage();
    if (final.stop_reason === "refusal") h.onText("\n\n_(The model declined to answer this one.)_");
    const usage = costOf(req.model, final.usage, req.cacheTtl);
    return { usage: Tutor.withSummaries(usage, built), cache: Tutor.cacheHit(req, startedAt, usage), stopReason: final.stop_reason };
  }

  /** Re-send the cached prefix with max_tokens 0: a cache read that resets the timer. */
  async keepWarm(req: AskRequest): Promise<{ usage: PromptUsage; cache: CacheHit | null }> {
    if (req.cacheTtl === "off") throw new Error("Prompt caching is off, so there is no cache to keep warm.");
    const built = await this.build(req, false);
    const startedAt = Date.now();
    // Same params as ask() (minus streaming) so the prefix and cache key match.
    const res = await (await this.sdk()).beta.messages.create({ ...Tutor.params(req), max_tokens: 0, system: built.system, messages: built.messages });
    const usage = costOf(req.model, res.usage, req.cacheTtl);
    return { usage, cache: Tutor.cacheHit(req, startedAt, usage) };
  }
}
