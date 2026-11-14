// Types shared by every Polyglot Tutor front end (web app and VS Code extension).

import type { CellColors } from "./cell-colors.ts";

export type CellType = "markdown" | "code" | "prompt";
export type Lang = "python" | "typescript" | "sql";
/** Which kernel runs a language: SQL runs on DuckDB inside the Python kernel. */
export type KernelLang = "python" | "typescript";
export const kernelOf = (l: Lang): KernelLang => (l === "typescript" ? "typescript" : "python");
export type PromptMode = "hint" | "answer";
export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

export type Output =
  | { kind: "stream"; name: "stdout" | "stderr"; text: string }
  | { kind: "display"; data: Record<string, unknown> }
  | { kind: "error"; ename: string; evalue: string; traceback: string[] };

export interface PromptUsage {
  model: string;
  summaryCostUsd?: number; // cost of summarising old context blocks (included in costUsd)
  summarizedBlocks?: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number;
}

export interface Cell {
  id: string;
  type: CellType;
  lang?: Lang; // code cells only
  source: string; // code, markdown, or the prompt question
  outputs: Output[]; // code cells only
  executionCount?: number | null;
  response?: string; // prompt cells only: the AI answer (markdown)
  mode?: PromptMode; // prompt cells only
  usage?: PromptUsage; // prompt cells only
  thinking?: string; // prompt cells only: summarised reasoning (when "show thinking" is on)
  hidden?: boolean; // 🙈 excluded from AI context
  pinned?: boolean; // 📌 never truncated in AI context
  /** Other .ipynb cell metadata (tags, …), kept so foreign notebooks round-trip. */
  meta?: Record<string, unknown>;
}

export interface Notebook {
  name: string; // file name, e.g. "learning-ts.ipynb"
  cells: Cell[];
  /** Other .ipynb notebook metadata, kept so foreign notebooks round-trip. */
  meta?: Record<string, unknown>;
}

export interface ContextSettings {
  recentCells: number; // cells sent verbatim (rounded up to whole blocks, plus the current block)
  blockSize: number; // cells per frozen block
  tokenBudget: number; // above this, the oldest blocks are replaced by summaries
  outputLimit: number; // characters kept per verbatim output (head + tail)
}

export type CacheTtl = "5m" | "1h";

export interface Settings {
  model: string;
  effort: Effort;
  learnerProfile: string;
  context: ContextSettings;
  cacheTtl: CacheTtl;
  summaryModel: string;
  showThinking: boolean;
  /** Web app: colours per cell type (see cell-colors.ts); missing values use the defaults. */
  cellColors?: Partial<CellColors>;
}

export const DEFAULT_SETTINGS: Settings = {
  model: "claude-sonnet-5-5",
  effort: "medium",
  learnerProfile: "",
  context: { recentCells: 10, blockSize: 10, tokenBudget: 40_000, outputLimit: 2_000 },
  cacheTtl: "1h",
  summaryModel: "claude-haiku-5-5",
  showThinking: false,
};

export const ttlMs = (t: CacheTtl) => (t === "5m" ? 5 : 60) * 60 * 1000;

export interface ModelInfo {
  id: string;
  label: string;
  inputPerMTok: number;
  outputPerMTok: number;
  cacheReadPerMTok: number;
  serverFallback: boolean; // supports fallbacks: "default"
  contextWindow: number; // tokens
}

// Prices in USD per million tokens. 1-hour cache writes cost 2x input.
export const MODELS: ModelInfo[] = [
  { id: "claude-sonnet-5-5", label: "Sonnet 5.5", inputPerMTok: 2, outputPerMTok: 10, cacheReadPerMTok: 0.2, serverFallback: true, contextWindow: 1_000_000 },
  { id: "claude-opus-5-5", label: "Opus 5.5", inputPerMTok: 4, outputPerMTok: 20, cacheReadPerMTok: 0.2, serverFallback: true, contextWindow: 1_000_000 },
  { id: "claude-haiku-5-5", label: "Haiku 5.5", inputPerMTok: 0.1, outputPerMTok: 0.5, cacheReadPerMTok: 0.01, serverFallback: false, contextWindow: 1_000_000 },
  { id: "claude-fable-5-1", label: "Fable 5.1", inputPerMTok: 10, outputPerMTok: 50, cacheReadPerMTok: 0.25, serverFallback: true, contextWindow: 1_000_000 },
];

export const modelInfo = (id: string): ModelInfo => MODELS.find((m) => m.id === id) ?? MODELS[0];

/** What the client sends about one cell when asking the AI. */
export interface ContextCell {
  id: string;
  index: number; // position in the notebook (1-based, for humans)
  type: CellType;
  lang?: Lang;
  source: string;
  outputs: Output[];
  response?: string;
  pinned?: boolean;
  typeErrors?: string[];
}

export interface AskRequest {
  notebook: string;
  cellId: string;
  cells: ContextCell[]; // visible cells above the prompt, in order
  question: string;
  mode: PromptMode;
  model: string;
  effort: Effort;
  learnerProfile: string;
  context: ContextSettings;
  cacheTtl: CacheTtl;
  summaryModel: string;
  showThinking: boolean;
}

export interface CacheInfo {
  model: string;
  ttlMs: number;
  startedAt: number; // request start (ms) — the TTL counts from here
  cells: { id: string; hash: string }[]; // cells inside the cached prefix
  readTokens: number;
  writeTokens: number;
}

/** A value shared between languages with share()/get(). */
export interface SharedItem {
  name: string;
  kind: "table" | "json";
  version: number;
  from: string; // language that shared it
  summary: string; // e.g. "table 10×3 (a, b, c)"
  persisted?: boolean; // saved as a Delta table
}

/** What the server reports about a cached request; the client adds which cells it covered. */
export type CacheHit = Omit<CacheInfo, "cells">;

// ---- WebSocket protocol ----

export type ClientMsg =
  | { t: "run"; notebook: string; cellId: string; lang: Lang; code: string }
  | { t: "interrupt"; notebook: string; lang: KernelLang }
  | { t: "restart"; notebook: string; lang: KernelLang }
  | { t: "ask"; req: AskRequest }
  | { t: "cancelAsk"; cellId: string }
  | { t: "keepWarm"; req: AskRequest };

export type KernelState = "starting" | "idle" | "busy" | "dead" | "off";

export type ServerMsg =
  | { t: "output"; cellId: string; output: Output }
  | { t: "clearOutput"; cellId: string }
  | { t: "runDone"; cellId: string; ok: boolean; executionCount: number | null }
  | { t: "kernel"; notebook: string; lang: KernelLang; state: KernelState }
  | { t: "shared"; notebook: string; items: SharedItem[] }
  | { t: "askDelta"; cellId: string; text: string }
  | { t: "askThinking"; cellId: string; text: string }
  | { t: "askDone"; cellId: string; usage: PromptUsage; cache: CacheHit | null; stopReason: string | null }
  | { t: "askError"; cellId: string; message: string }
  | { t: "warmDone"; cache: CacheHit | null; usage: PromptUsage }
  | { t: "warmError"; message: string };

/** Estimated size of the context the next question would send (for the context ring). */
export interface ContextEstimate {
  tokens: number; // estimated input tokens (system + cells + question)
  budget: number; // the token budget from settings
  window: number; // the model's context window
  parts: { system: number; summaries: number; compact: number; recent: number; images: number; question: number };
  summarizedBlocks: number;
}
