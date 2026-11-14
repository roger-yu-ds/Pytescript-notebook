import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import Anthropic from "@anthropic-ai/sdk";
import { Tutor, describeError } from "../src/tutor.ts";
import { DEFAULT_SETTINGS, type AskRequest, type ContextCell } from "../src/types.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const TMP = mkdtempSync(path.join(tmpdir(), "tutor-test-"));
const LOG = path.join(TMP, "mock.log");
const PORT = 18891;
let mock: ChildProcess;

before(async () => {
  mock = spawn(process.execPath, [path.join(ROOT, "tests", "mock-anthropic.cjs"), LOG, String(PORT)], { stdio: "pipe" });
  await new Promise((r) => mock.stdout!.once("data", r));
  process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${PORT}`;
});
after(() => {
  mock.kill();
  rmSync(TMP, { recursive: true, force: true });
});

const requests = () => readFileSync(LOG, "utf8").trim().split("\n").map((l) => JSON.parse(l));

const cells = (n: number): ContextCell[] =>
  Array.from({ length: n }, (_, i) => ({ id: `c${i}`, index: i + 1, type: "code", lang: "python", source: `x = ${i}`, outputs: [{ kind: "stream", name: "stdout", text: "out ".repeat(300) }] }));

const req = (over: Partial<AskRequest> = {}): AskRequest => ({
  notebook: "n",
  cellId: "p",
  cells: cells(3),
  question: "What is x?",
  mode: "hint",
  ...DEFAULT_SETTINGS,
  ...over,
});

test("streams the answer and reports usage and the cache", async () => {
  const tutor = new Tutor({ apiKey: () => "k", summaryCacheFile: path.join(TMP, "s.json") });
  let text = "";
  const r = await tutor.ask(req(), { onText: (t) => (text += t) });
  assert.match(text, /cell 2/);
  assert.equal(r.stopReason, "end_turn");
  assert.equal(r.cache?.ttlMs, 3_600_000);
  assert.ok(r.usage.costUsd > 0);
  const body = requests().at(-1).body;
  assert.equal(body.system.at(-1).cache_control.ttl, "1h");
  const content = body.messages[0].content;
  assert.equal(content.at(-2).cache_control.type, "ephemeral");
  assert.match(content.at(-1).text, /^<learner_question mode="hint">/);
  assert.deepEqual(body.fallbacks, "default");
});

test("keep-warm sends the same prefix with max_tokens 0", async () => {
  const tutor = new Tutor({ apiKey: () => "k", summaryCacheFile: path.join(TMP, "s.json") });
  await tutor.ask(req(), { onText: () => {} });
  const asked = requests().at(-1).body;
  await tutor.keepWarm(req());
  const warm = requests().at(-1).body;
  assert.equal(warm.max_tokens, 0);
  assert.deepEqual(warm.messages[0].content, asked.messages[0].content.slice(0, -1));
  assert.deepEqual(warm.system, asked.system);
});

test("summaries are written once by the summary model and cached on disk", async () => {
  const file = path.join(TMP, "sum.json");
  const tight = { ...DEFAULT_SETTINGS.context, recentCells: 2, blockSize: 2, tokenBudget: 100 };
  const before = requests().length;
  const r = await new Tutor({ apiKey: () => "k", summaryCacheFile: file }).ask(req({ cells: cells(9), context: tight }), { onText: () => {} });
  const summaryCalls = requests().slice(before).filter((x) => !x.body.stream);
  assert.ok(summaryCalls.length >= 1 && summaryCalls.every((x) => x.body.model === DEFAULT_SETTINGS.summaryModel));
  assert.equal(r.usage.summarizedBlocks, summaryCalls.length);
  const mid = requests().length;
  await new Tutor({ apiKey: () => "k", summaryCacheFile: file }).ask(req({ cells: cells(9), context: tight }), { onText: () => {} });
  assert.equal(requests().slice(mid).filter((x) => !x.body.stream).length, 0, "second run reuses the disk cache");
});

test("errors are friendly", () => {
  assert.equal(describeError(new Error("Could not resolve authentication method"), "Set the key."), "Set the key.");
  assert.equal(describeError("x"), "x");
});

test("connection errors name the network cause and what to do", () => {
  const net = Object.assign(new Error("socket hang up"), { code: "ECONNRESET" });
  const e = new Anthropic.APIConnectionError({ cause: Object.assign(new TypeError("fetch failed"), { cause: net }) });
  assert.equal(describeError(e), "Couldn't reach the Anthropic API (ECONNRESET: socket hang up). Check the internet connection (or VPN / proxy), then run the cell again.");
  assert.match(describeError(new Anthropic.APIConnectionError({})), /^Couldn't reach the Anthropic API\. Check/);
  assert.match(describeError(new Anthropic.APIConnectionTimeoutError()), /timed out/);
});
