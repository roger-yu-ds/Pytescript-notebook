// End-to-end test: starts a mock Anthropic API, the backend (with real Jupyter
// kernels) and the Vite UI on spare ports, then drives the UI in headless Chromium.
//
//   npm test
//
// If Chromium can't find system libraries (libnss3 etc.) set LD_LIBRARY_PATH
// to a folder containing them before running.

import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import WebSocket from "ws";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TMP = mkdtempSync(path.join(tmpdir(), "polyglot-e2e-"));
const NB_DIR = path.join(TMP, "notebooks");
const MOCK_LOG = path.join(TMP, "mock.log");
const PORTS = { mock: 18798, api: 18799, ui: 15199 };
const API = `http://127.0.0.1:${PORTS.api}`;
const UI = `http://127.0.0.1:${PORTS.ui}`;

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok: !!ok });
  console.log(`${ok ? "✓" : "✗"} ${name}${ok || !detail ? "" : `\n    ${String(detail).slice(0, 400)}`}`);
}

const procs = [];
function start(cmd, args, opts) {
  // Own process group (POSIX) so the whole tree can be stopped; Windows uses taskkill /T instead.
  const p = spawn(cmd, args, { ...opts, detached: process.platform !== "win32", windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  let log = "";
  p.stdout.on("data", (d) => (log += d));
  p.stderr.on("data", (d) => (log += d));
  procs.push(p);
  return { p, log: () => log };
}

async function waitFor(url, ms = 40000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`timed out waiting for ${url}`);
}

/** Headless Chromium; CHROMIUM_PATH points at another build (e.g. one already installed on the machine). */
const launch = () => chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});

const mockRequests = () =>
  existsSync(MOCK_LOG) ? readFileSync(MOCK_LOG, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];

async function kernelSmoke() {
  const ws = new WebSocket(`ws://127.0.0.1:${PORTS.api}/ws`);
  await new Promise((r, j) => (ws.on("open", r), ws.on("error", j)));
  const pending = new Map();
  ws.on("message", (d) => {
    const m = JSON.parse(d.toString());
    const p = pending.get(m.cellId);
    if (!p) return;
    if (m.t === "output") p.outputs.push(m.output);
    if (m.t === "runDone") {
      pending.delete(m.cellId);
      p.resolve({ ok: m.ok, outputs: p.outputs, text: p.outputs.map((o) => o.text ?? `${o.ename ?? ""} ${o.evalue ?? ""}` + (o.data?.["text/plain"] ?? "")).join("") });
    }
  });
  let n = 0;
  const run = (lang, code) =>
    new Promise((resolve, reject) => {
      const cellId = `k${++n}`;
      pending.set(cellId, { outputs: [], resolve });
      ws.send(JSON.stringify({ t: "run", notebook: "smoke.ipynb", cellId, lang, code }));
      setTimeout(() => reject(new Error(`timeout running ${lang}: ${code}`)), 90000);
    });

  let r = await run("python", "import pandas as pd\nprint('hi from python')\npd.DataFrame({'a':[1,2]})");
  check("python: stdout + DataFrame html", r.ok && r.text.includes("hi from python") && r.outputs.some((o) => o.data?.["text/html"]));
  r = await run("typescript", "const greet = (n: string): string => `hello ${n}`;\nconsole.log(greet('deno'));");
  check("typescript (deno): stdout", r.ok && r.text.includes("hello deno"), r.text);
  r = await run("python", "1/0");
  check("python: error reported", !r.ok && r.outputs.some((o) => o.kind === "error" && o.ename === "ZeroDivisionError"));
  r = await run("python", "import matplotlib.pyplot as plt\nplt.plot([1,2,3]); plt.show()");
  check("python: matplotlib png", r.outputs.some((o) => o.data?.["image/png"]));

  // v2: SQL + share/get
  await run("python", "sales = pd.DataFrame({'region': ['n', 's', 'n'], 'amt': [10, 20, 5]})");
  r = await run("sql", "select region, sum(amt) as total from sales group by region order by region");
  check("sql: queries a Python DataFrame by name", r.ok && r.outputs.some((o) => String(o.data?.["text/html"] ?? "").includes("total")) && r.text.includes("15"), r.text);
  r = await run("typescript", 'await share("people", [{ name: "Ada", age: 36 }, { name: "Lin", age: 29 }]);');
  check("share: TypeScript rows → hub as table", r.ok && r.text.includes('shared "people": table 2×2'), r.text);
  r = await run("python", "p = get('people')\nprint(type(p).__name__, int(p['age'].sum()))");
  check("get: Python receives a DataFrame", r.ok && r.text.includes("DataFrame 65"), r.text);
  r = await run("sql", "select avg(age) as a from people");
  check("sql: queries a table shared from TypeScript", r.ok && r.text.includes("32.5"), r.text);
  r = await run("sql", "-- as: older\nselect name from people where age > 30");
  check("sql: '-- as:' saves + shares the result", r.ok && r.text.includes('shared "older"'), r.text);
  r = await run("typescript", 'const older = await get("older");\nconsole.log(older[0].name, older.length);');
  check("get: TypeScript receives SQL result rows", r.ok && r.text.includes("Ada 1"), r.text);
  r = await run("python", "share('cfg', {'rate': 0.5, 'tags': ['a']})");
  r = await run("typescript", 'const cfg = await get("cfg");\nconsole.log(cfg.rate * 2, cfg.tags.length);');
  check("share/get: plain JSON values Python → TypeScript", r.ok && r.text.includes("1 1"), r.text);
  r = await run("typescript", 'await get("nope")');
  check("get: helpful error for unknown names", !r.ok && r.text.includes("Nothing has been shared"), r.text);
  r = await run("sql", "select * from no_such_table");
  check("sql: errors are reported", !r.ok && r.text.includes("SQL error"), r.text);
  const idx = await (await fetch(`${API}/api/shared/smoke.ipynb`)).json();
  check("hub: index lists shared values", ["people", "older", "cfg"].every((n) => idx.some((i) => i.name === n)), JSON.stringify(idx));

  // v3: Delta persistence
  r = await run("python", "share('scores', pd.DataFrame({'s': [1, 2]}), persist=True)");
  check("delta: Python share(persist=True) writes v0", r.ok && r.text.includes("Delta v0"), r.text);
  r = await run("python", "share('scores', pd.DataFrame({'s': [1, 2, 3]}), persist=True)");
  check("delta: re-sharing writes a new version", r.ok && r.text.includes("Delta v1"), r.text);
  r = await run("sql", "select count(*) as c from scores");
  check("delta: SQL reads the latest version", r.ok && r.text.includes("3"), r.text);
  r = await run("sql", "select count(*) as c from delta_at('scores', 0)");
  check("delta: SQL time travel with delta_at()", r.ok && /\b2\b/.test(r.text), r.text);
  r = await run("python", "print(len(get('scores', version=0)), list(history('scores')['version']))");
  check("delta: get(version=) and history()", r.ok && r.text.includes("2 [1, 0]"), r.text);
  r = await run("typescript", 'await share("ts_rows", [{ a: 1 }, { a: 2 }], { persist: true });');
  check("delta: TypeScript share({ persist: true })", r.ok && r.text.includes("Delta v0"), r.text);
  check("delta: files written under <notebooks>/.data/<notebook>/", existsSync(path.join(NB_DIR, ".data", "smoke", "ts_rows", "_delta_log")));
  await new Promise((resolve) => {
    // restart the Python kernel: persisted tables must come back without re-running anything
    ws.send(JSON.stringify({ t: "restart", notebook: "smoke.ipynb", lang: "python" }));
    setTimeout(resolve, 500);
  });
  r = await run("sql", "select sum(a) as t from ts_rows");
  check("delta: persisted tables survive a kernel restart", r.ok && r.text.includes("3"), r.text);
  r = await run(
    "python",
    `from deltalake import write_deltalake\nimport pyarrow as pa\nwrite_deltalake(${JSON.stringify(path.join(NB_DIR, ".data", "smoke", "old_session"))}, pa.table({"x": [7, 8]}))`,
  );
  r = await run("typescript", 'const old = await get("old_session");\nconsole.log(old.map((r) => r.x).join(","));');
  check("delta: TypeScript can get a table saved in an earlier session", r.ok && r.text.includes("7,8"), r.text);
  const idx2 = await (await fetch(`${API}/api/shared/smoke.ipynb`)).json();
  check("delta: index marks persisted tables", idx2.some((i) => i.name === "scores" && i.persisted) && idx2.some((i) => i.name === "old_session" && i.persisted), JSON.stringify(idx2));
  ws.close();
}

async function ui() {
  await fetch(`${API}/api/notebooks`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "demo" }) });
  const browser = await launch();
  const page = await browser.newPage({ viewport: { width: 1300, height: 950 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => m.type() === "error" && errors.push(`console: ${m.text()} (${m.location()?.url ?? "?"})`));
  try {
    await page.goto(UI);
    await page.waitForSelector(".cell");
    await page.waitForFunction(() => globalThis.monaco && monaco.editor.getModels().length >= 1);
    const cell = (n) => page.locator(".cell").nth(n);
    const setCell = (n, text) =>
      page.evaluate(
        ([n, text]) => {
          const id = document.querySelectorAll(".cell")[n].dataset.cellId;
          monaco.editor.getModels().find((m) => m.uri.path.startsWith(`/cells/${id}.`)).setValue(text);
        },
        [n, text],
      );
    const focus = (n) => cell(n).locator(".monaco-editor .view-lines").click();

    // TypeScript cell with a deliberate type error
    await setCell(1, 'interface User { name: string; age: number }\nconst u: User = { name: "Ada", age: "36" };\nconsole.log(`hi ${u.name}`);\n[1, 2, 3].map((x) => x * 2)');
    await focus(1);
    await page.keyboard.press("Shift+Enter");
    await cell(1).locator(".outputs").waitFor();
    await page.waitForTimeout(1500);
    check("ui: TS cell runs", (await cell(1).locator(".outputs").innerText()).includes("hi Ada"));
    check("ui: TS type error flagged", (await cell(1).locator(".type-errors").innerText().catch(() => "")).includes("1 type error"));
    check("ui: ANSI codes rendered, not shown raw", !(await cell(1).locator(".outputs").innerText()).includes("[33m"));

    // Python cell via the type dropdown
    await cell(2).locator("select").selectOption("python");
    await page.waitForTimeout(300);
    await setCell(2, "import pandas as pd\ndf = pd.DataFrame({'lang': ['py', 'ts'], 'fun': [9, 10]})\ndf");
    await focus(2);
    await page.keyboard.press("ControlOrMeta+Enter");
    await cell(2).locator(".outputs table").waitFor({ timeout: 60000 });
    check("ui: Python DataFrame renders as table", true);

    // Prompt cell
    await page.getByRole("button", { name: "+ ✨ Prompt" }).click();
    await page.waitForTimeout(300);
    const p = (await page.locator(".cell").count()) - 1;
    await setCell(p, "Why does cell 2 have a type error?");
    await focus(p);
    await page.keyboard.press("ControlOrMeta+Enter");
    await cell(p).locator(".usage").waitFor({ timeout: 20000 });
    check("ui: answer streams in", (await cell(p).locator(".response").innerText()).includes("What type is the value you assigned?"));
    check("ui: usage + cost shown", /\$0\.\d+/.test(await cell(p).locator(".usage").innerText()));

    const [askReq] = mockRequests();
    const b = askReq?.body ?? {};
    const blocks = b.messages?.[0]?.content ?? [];
    check("api: system prompt cached with 1h TTL", b.system?.at(-1)?.cache_control?.ttl === "1h");
    check("api: breakpoint on the last cell, question after it", blocks.at(-2)?.cache_control?.ttl === "1h" && !blocks.at(-1)?.cache_control && blocks.at(-1)?.text.includes("learner_question"));
    check("api: one block per cell above the prompt", blocks.length === 4, blocks.length);
    check("api: type errors included in context", blocks[1]?.text.includes("<type_errors>") && blocks[1].text.includes("not assignable"));
    check("api: hint mode sent", blocks.at(-1)?.text.includes('mode="hint"'));
    check("api: default model + effort", b.model === "claude-sonnet-5-5" && b.output_config?.effort === "medium");
    check("api: refusal fallback enabled", b.fallbacks === "default" && askReq.beta?.includes("server-side-fallback-2026-07-01"));
    check("api: ANSI stripped from outputs in context", !blocks[1]?.text.includes("\x1b["));

    await page.waitForTimeout(1200);
    check("ui: cache countdown shown", /cache 59:\d\d/.test(await page.locator(".cache").innerText()));

    // Keep warm
    await page.locator(".cache button").click();
    await page.waitForTimeout(1500);
    const warm = mockRequests()[1]?.body;
    check("api: keep-warm is max_tokens 0, not streamed", warm?.max_tokens === 0 && !warm?.stream);
    check(
      "api: keep-warm prefix identical to the question's",
      warm && JSON.stringify(warm.system) === JSON.stringify(b.system) && JSON.stringify(warm.messages[0].content) === JSON.stringify(blocks.slice(0, -1)),
    );

    // Editing a cached cell marks the cache stale
    await setCell(1, 'interface User { name: string; age: number }\nconst u: User = { name: "Ada", age: 36 };');
    await page.waitForTimeout(1500);
    check("ui: editing a cached cell → stale", (await page.locator(".cache").innerText()).includes("stale from cell 2"));
    check("ui: edited-since-run marker", await cell(1).locator(".stale-note").isVisible());

    // Insert code from the answer
    const before = await page.locator(".cell").count();
    await cell(p).locator(".codeblock button", { hasText: "Insert" }).click();
    await page.waitForTimeout(500);
    const kinds = await page.$$eval(".cell select", (s) => s.map((x) => x.value));
    check("ui: 'Insert as cell' adds a TypeScript cell below", (await page.locator(".cell").count()) === before + 1 && kinds[p + 1] === "typescript");

    // Persistence
    await page.waitForTimeout(1500);
    await page.reload();
    await page.waitForSelector(".cell .response");
    check("persist: prompt answer survives reload", (await page.locator(".response").first().innerText()).includes("cell 2"));
    const nb = JSON.parse(readFileSync(path.join(NB_DIR, "demo.ipynb"), "utf8"));
    check("persist: valid nbformat 4 with polyglot metadata", nb.nbformat === 4 && nb.cells.some((c) => c.metadata?.polyglot?.type === "prompt"));

    const ring = page.locator(".statusbar .ring");
    const ringTitle = (await ring.getAttribute("title")) ?? "";
    check("ui: context ring shows % of the token budget", /^\d+%$/.test((await ring.innerText()).trim()) && ringTitle.includes("token budget") && ringTitle.includes("context window"), ringTitle);
    check("ui: no page errors", errors.length === 0, errors.join("\n"));
    await page.screenshot({ path: path.join(TMP, "e2e.png") });
  } finally {
    await browser.close();
  }
}

// Command mode: Esc (and Shift+Enter onto an existing cell) hands the keyboard back
// to the notebook, so letter shortcuts act on cells instead of typing.
async function commandMode() {
  await fetch(`${API}/api/notebooks`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "keys" }) });
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1300, height: 950 } });
  try {
    await page.goto(UI);
    await page.getByRole("button", { name: "keys", exact: true }).click();
    await page.waitForFunction(() => document.querySelector("h1")?.textContent === "keys");
    await page.waitForFunction(() => globalThis.monaco && monaco.editor.getModels().length >= 1);
    const cell = (n) => page.locator(".cell").nth(n);
    const kind = (n) => cell(n).locator(".cell-toolbar select").inputValue();
    const inEditor = () => page.evaluate(() => !!document.activeElement?.closest(".monaco-editor"));
    const settle = () => page.waitForTimeout(150);

    // A new notebook is "# keys" (Markdown) then an empty TypeScript cell.
    await cell(1).locator(".monaco-editor .view-lines").click();
    await page.locator(".cell.editing").waitFor();
    await page.keyboard.type("abc", { delay: 50 }); // human-ish: instant synthetic typing right after focus can drop a key in Monaco
    await page.keyboard.press("Escape");
    await settle();
    check("keys: Esc leaves edit mode", (await page.locator(".cell.editing").count()) === 0 && !(await inEditor()));

    await page.keyboard.press("m");
    await settle();
    check("keys: M after Esc changes the cell (doesn't type)", (await kind(1)) === "markdown");
    const before = await page.locator(".cell").count();
    await page.keyboard.press("b");
    await settle();
    check("keys: B inserts a cell below", (await page.locator(".cell").count()) === before + 1);
    const typed = (await cell(1).locator(".md-rendered").innerText()).trim();
    check("keys: letters were not typed into the cell", typed === "abc", JSON.stringify(typed));

    for (const [key, want] of [["t", "typescript"], ["p", "prompt"], ["y", "python"], ["m", "markdown"], ["t", "typescript"]]) {
      await page.keyboard.press(key);
      await settle();
      check(`keys: ${key.toUpperCase()} → ${want}`, (await kind(2)) === want, await kind(2));
    }

    // Shift+Enter from editing onto an existing cell lands in command mode there.
    await page.keyboard.press("k");
    await page.keyboard.press("Enter");
    await settle();
    check("keys: Enter edits the selected cell", (await inEditor()) && (await page.locator(".cell.editing").count()) === 1);
    await page.keyboard.press("Shift+Enter");
    await settle();
    check("keys: Shift+Enter onto the next cell is command mode", !(await inEditor()) && (await page.locator(".cell.editing").count()) === 0);
    await page.keyboard.press("p");
    await settle();
    check("keys: shortcut applies to the next cell", (await kind(2)) === "prompt" && (await kind(1)) === "markdown");
  } finally {
    await browser.close();
  }
}

async function ui2() {
  // Hub security: values are only served by core's token-guarded hub, never by the UI server.
  check("hub: values not exposed by the web server", (await fetch(`${API}/api/shared/smoke.ipynb/people`)).status === 404);
  check("hub: index readable by the UI", (await fetch(`${API}/api/shared/smoke.ipynb`)).status === 200);

  await fetch(`${API}/api/notebooks`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "v2" }) });
  const browser = await launch();
  const page = await browser.newPage({ viewport: { width: 1300, height: 950 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  try {
    await page.goto(UI);
    await page.getByRole("button", { name: "v2", exact: true }).click();
    await page.waitForFunction(() => document.querySelector("h1")?.textContent === "v2");
    await page.waitForFunction(() => globalThis.monaco && monaco.editor.getModels().length >= 1);
    const cell = (n) => page.locator(".cell").nth(n);
    const count = () => page.locator(".cell").count();
    const setCell = (n, text) =>
      page.evaluate(
        ([n, text]) => {
          const id = document.querySelectorAll(".cell")[n].dataset.cellId;
          const models = monaco.editor.getModels().filter((m) => m.uri.path.startsWith(`/cells/${id}.`));
          models.at(-1).setValue(text);
        },
        [n, text],
      );
    const runCell = async (n) => {
      await cell(n).locator(".cell-gutter").click(); // select it so its toolbar shows
      await cell(n).locator(".cell-toolbar .tool").first().click();
    };
    const addCell = async (label) => {
      await page.locator(".add-row button", { hasText: label }).click();
      await page.waitForTimeout(300);
      return (await count()) - 1;
    };

    // TS cell: share() is known to the type checker and works from the UI
    await setCell(1, 'await share("nums", [{ n: 1 }, { n: 2 }]);\nconst back = await get<{ n: number }[]>("nums");\nconsole.log(back.length);');
    await runCell(1);
    await cell(1).locator(".outputs").waitFor({ timeout: 60000 });
    await page.waitForTimeout(1500);
    check("ui: share/get typed in TS cells (no type errors)", (await cell(1).locator(".type-errors").count()) === 0);
    check("ui: status bar shows shared values", (await page.locator(".statusbar .shared").innerText().catch(() => "")).includes("nums"));

    // SQL cell
    let n = await addCell("SQL");
    await setCell(n, "select sum(n) as total from nums");
    await runCell(n);
    await cell(n).locator(".outputs table").waitFor({ timeout: 60000 });
    check("ui: SQL cell renders a result table", (await cell(n).locator(".outputs").innerText()).includes("3"));

    // Chart
    n = await addCell("Python");
    await setCell(n, "import matplotlib.pyplot as plt\nplt.plot([1, 4, 9]); plt.title('squares'); plt.show()");
    await runCell(n);
    await cell(n).locator(".outputs img").waitFor({ timeout: 60000 });
    check("ui: matplotlib chart renders", true);

    // Error → Ask about this error
    n = await addCell("Python");
    await setCell(n, "nums_total = undefined_name + 1");
    await runCell(n);
    await cell(n).locator(".ask-error-out").waitFor({ timeout: 60000 });
    const before = await count();
    await cell(n).locator(".ask-error-out").click();
    await page.waitForTimeout(500);
    const kinds = await page.$$eval(".cell select", (s) => s.map((x) => x.value));
    check("ui: 'Ask about this error' inserts a prompt cell below", (await count()) === before + 1 && kinds[n + 1] === "prompt");
    const q = await page.evaluate((i) => {
      const id = document.querySelectorAll(".cell")[i].dataset.cellId;
      return monaco.editor.getModels().find((m) => m.uri.path.startsWith(`/cells/${id}.`))?.getValue();
    }, n + 1);
    check("ui: prompt pre-filled with the question", q === `Why did cell ${n + 1} fail?`, q);
    check("ui: inserted prompt is in edit mode", await cell(n + 1).evaluate((el) => el.classList.contains("editing")));
    const reqsBefore = mockRequests().length;
    await page.keyboard.press("ControlOrMeta+Enter");
    await cell(n + 1).locator(".usage").waitFor({ timeout: 20000 });
    const body = mockRequests()[reqsBefore]?.body;
    const blocks = body?.messages?.[0]?.content ?? [];
    check("api: chart sent as an image block", blocks.some((b) => b.type === "image" && b.source?.media_type === "image/png"));
    check("api: SQL cell in context with lang=sql", blocks.some((b) => b.type === "text" && b.text.includes('lang="sql"')));
    check("api: error traceback in context", blocks.some((b) => b.type === "text" && b.text.includes("NameError")));
    check("api: cache breakpoint still on the last context block", blocks.at(-2)?.cache_control?.ttl === "1h");

    await page.waitForTimeout(1200);
    const nb = JSON.parse(readFileSync(path.join(NB_DIR, "v2.ipynb"), "utf8"));
    check("persist: SQL cell saved with lang metadata", nb.cells.some((c) => c.metadata?.polyglot?.lang === "sql"));
    check("ui2: no page errors", errors.length === 0, errors.join("\n"));
    await page.screenshot({ path: path.join(TMP, "e2e-v2.png"), fullPage: true });
  } finally {
    await browser.close();
  }
}

// The guided tour: created on first start, and every code cell runs cleanly.
async function welcomeTour() {
  const nb = await (await fetch(`${API}/api/notebooks/welcome.ipynb`)).json();
  check("welcome: tour notebook created on first start", Array.isArray(nb.cells) && nb.cells.length > 10, JSON.stringify(nb).slice(0, 200));
  const kind = (i) => (nb.cells[i - 1].type === "code" ? nb.cells[i - 1].lang : nb.cells[i - 1].type);
  check("welcome: cell numbers referenced in the text are right", kind(3) === "typescript" && kind(7) === "python" && kind(11) === "typescript" && nb.cells[6].source.includes("sales = "));

  const ws = new WebSocket(`ws://127.0.0.1:${PORTS.api}/ws`);
  await new Promise((r, j) => (ws.on("open", r), ws.on("error", j)));
  const pending = new Map();
  ws.on("message", (d) => {
    const m = JSON.parse(d.toString());
    const p = pending.get(m.cellId);
    if (!p) return;
    if (m.t === "output") p.outputs.push(m.output);
    if (m.t === "runDone") {
      pending.delete(m.cellId);
      p.resolve({ ok: m.ok, outputs: p.outputs });
    }
  });
  const results = [];
  for (const cell of nb.cells.filter((c) => c.type === "code")) {
    const r = await new Promise((resolve, reject) => {
      pending.set(cell.id, { outputs: [], resolve });
      ws.send(JSON.stringify({ t: "run", notebook: "welcome.ipynb", cellId: cell.id, lang: cell.lang, code: cell.source }));
      setTimeout(() => reject(new Error(`timeout in welcome cell ${cell.id}`)), 120000);
    });
    const text = r.outputs.map((o) => o.text ?? `${o.ename ?? ""}: ${o.evalue ?? ""}` + (o.data?.["text/plain"] ?? "")).join("");
    results.push({ id: cell.id, ok: r.ok, text, outputs: r.outputs });
  }
  ws.close();
  const failed = results.filter((r) => !r.ok);
  check("welcome: every code cell runs without errors", failed.length === 0, failed.map((f) => `${f.id}: ${f.text}`).join("\n"));
  const all = results.map((r) => r.text).join("\n");
  check("welcome: TypeScript cell shows the 361 bug it describes", all.includes("Next year you'll be 361"));
  check("welcome: chart rendered", results.some((r) => r.outputs.some((o) => o.data?.["image/png"])));
  check("welcome: SQL → TypeScript sharing works", all.includes("Best region: north (260)"), all.slice(0, 500));
  check("welcome: Delta versions + time travel", /latest\s+3/.test(all) && /v0\s+2/.test(all), all.slice(-600));
}

// Context compression + settings, exercised through the WebSocket API directly.
async function compression() {
  const ws = new WebSocket(`ws://127.0.0.1:${PORTS.api}/ws`);
  await new Promise((r, j) => (ws.on("open", r), ws.on("error", j)));
  const msgs = [];
  ws.on("message", (d) => msgs.push(JSON.parse(d.toString())));
  const cellsN = (n) =>
    Array.from({ length: n }, (_, i) => ({
      id: `c${i + 1}`,
      index: i + 1,
      type: "code",
      lang: "python",
      source: `x${i + 1} = ${i + 1}\nprint("value " * 40, x${i + 1})`,
      outputs: [{ kind: "stream", name: "stdout", text: ("value ".repeat(40) + `${i + 1}\n`).repeat(3) }],
    }));
  const base = {
    notebook: "comp.ipynb",
    question: "What is x3?",
    mode: "hint",
    model: "claude-sonnet-5-5",
    effort: "medium",
    learnerProfile: "",
    context: { recentCells: 5, blockSize: 5, tokenBudget: 1500, outputLimit: 2000 },
    cacheTtl: "5m",
    summaryModel: "claude-haiku-5-5",
    showThinking: true,
  };
  const ask = async (req) => {
    const before = mockRequests().length;
    msgs.length = 0;
    ws.send(JSON.stringify({ t: "ask", req }));
    const end = Date.now() + 20000;
    while (!msgs.some((m) => (m.t === "askDone" || m.t === "askError") && m.cellId === req.cellId) && Date.now() < end) await new Promise((r) => setTimeout(r, 100));
    const reqs = mockRequests().slice(before);
    return { reqs, main: reqs.find((r) => r.body.stream)?.body, done: msgs.find((m) => m.t === "askDone"), thinking: msgs.filter((m) => m.t === "askThinking").map((m) => m.text).join("") };
  };
  const texts = (body) => body.messages[0].content.map((b) => b.text ?? `[${b.type}]`);

  // Blocks of 5, recent window = 2 blocks → with 23 cells, cells 1-15 are "old" (3 blocks).
  // Tight budget: all three old blocks become summaries.
  const a = await ask({ ...base, cellId: "p1", cells: cellsN(23) });
  const ta = texts(a.main);
  const summaryReqs = a.reqs.filter((r) => !r.body.stream && r.body.max_tokens > 0);
  check("compress: oldest blocks summarised by the summary model", summaryReqs.length === 3 && summaryReqs.every((r) => r.body.model === "claude-haiku-5-5"), summaryReqs.length);
  check("compress: summary blocks in the request", ta[0].startsWith('<summary cells="1-5">') && ta[0].includes("SUMMARY#") && ta[2].startsWith('<summary cells="11-15">'), ta.slice(0, 3).join("\n"));
  check("compress: recent cells sent in full", ta[3].includes('index="16"') && ta.at(-2).includes('index="23"') && ta.at(-2).includes("<output>"), ta.at(-2));
  check("compress: cache TTL from settings (5m)", a.main.messages[0].content.at(-2).cache_control?.ttl === "5m" && a.main.system.at(-1).cache_control?.ttl === "5m");
  check("compress: summary cost reported", a.done?.usage?.summarizedBlocks === 3 && a.done.usage.summaryCostUsd > 0, JSON.stringify(a.done?.usage));
  check("thinking: summarized reasoning requested + streamed", a.main.thinking?.display === "summarized" && a.thinking.includes("string to a number"), a.thinking);
  check("cache: TTL reported back to the client", a.done?.cache?.ttlMs === 5 * 60 * 1000, JSON.stringify(a.done?.cache));

  const b = await ask({ ...base, cellId: "p2", cells: cellsN(24) });
  const tb = texts(b.main);
  check("compress: summarised prefix byte-identical as the notebook grows", JSON.stringify(tb.slice(0, 3)) === JSON.stringify(ta.slice(0, 3)));
  check("compress: summaries reused from cache (no new summary calls)", b.reqs.filter((r) => !r.body.stream).length === 0, b.reqs.length);

  // Large budget: old blocks stay as compact cells (source + one-line output stubs).
  const roomy = { ...base.context, tokenBudget: 100000 };
  const c = await ask({ ...base, context: roomy, cellId: "p3", cells: cellsN(23) });
  const tc = texts(c.main);
  check("compress: older cells sent compact", tc.slice(0, 15).every((t) => t.includes("<output_summary>")) && tc[15].includes("<output>\n"), tc[0]);
  check("compress: compact stubs keep the first output line", tc[0].includes("[stdout: 3 lines] value value"), tc[0]);
  const d = await ask({ ...base, context: roomy, cellId: "p4", cells: cellsN(24) });
  check("compress: compact prefix byte-identical as the notebook grows", JSON.stringify(texts(d.main).slice(0, 15)) === JSON.stringify(tc.slice(0, 15)));

  // Keep-warm with the same settings reproduces the prefix exactly.
  msgs.length = 0;
  const before = mockRequests().length;
  ws.send(JSON.stringify({ t: "keepWarm", req: { ...base, cellId: "", question: "", cells: cellsN(24) } }));
  const end = Date.now() + 10000;
  while (!msgs.some((m) => m.t === "warmDone" || m.t === "warmError") && Date.now() < end) await new Promise((r) => setTimeout(r, 100));
  const warm = mockRequests()[before]?.body;
  check(
    "compress: keep-warm prefix identical under compression",
    warm && JSON.stringify(warm.messages[0].content) === JSON.stringify(b.main.messages[0].content.slice(0, -1)) && warm.thinking?.display === "summarized",
  );
  ws.close();
}

async function settingsUi() {
  const browser = await launch();
  const page = await browser.newPage();
  try {
    await page.goto(UI);
    await page.getByRole("button", { name: "⚙ Settings" }).click();
    await page.getByLabel("Block size (cells)").fill("7");
    await page.getByLabel("Cache lifetime").selectOption("5m");
    await Promise.all([
      page.waitForResponse((r) => r.url().endsWith("/api/settings") && r.request().method() === "PUT"),
      page.getByRole("button", { name: "Save" }).click(),
    ]);
    const s = await (await fetch(`${API}/api/settings`)).json();
    check("settings: panel saves context + cache settings", s.context?.blockSize === 7 && s.cacheTtl === "5m", JSON.stringify(s));

    // Cell colours: a new Python colour is saved and applied; turning colours off restores plain cells.
    const colorVar = (name) => page.evaluate((n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim(), name);
    check("colours: defaults applied on load", (await colorVar("--lang-prompt")) === "#b48cff", await colorVar("--lang-prompt"));
    await page.getByRole("button", { name: "⚙ Settings" }).click();
    await page.getByLabel("Python colour").fill("#ff0000");
    await Promise.all([
      page.waitForResponse((r) => r.url().endsWith("/api/settings") && r.request().method() === "PUT"),
      page.getByRole("button", { name: "Save" }).click(),
    ]);
    const saved = await (await fetch(`${API}/api/settings`)).json();
    check("colours: the Python colour is saved", saved.cellColors?.python === "#ff0000", JSON.stringify(saved.cellColors));
    check("colours: and applied to the page", (await colorVar("--lang-python")) === "#ff0000", await colorVar("--lang-python"));
    const stripe = await page.evaluate(() => {
      const body = document.querySelector(".cell-python .cell-body");
      return body ? getComputedStyle(body).borderTopColor : null;
    });
    if (stripe !== null) check("colours: a Python cell has the stripe", stripe === "rgb(255, 0, 0)", stripe);
    await page.getByRole("button", { name: "⚙ Settings" }).click();
    await page.getByLabel("Colour cells by type").uncheck();
    await Promise.all([
      page.waitForResponse((r) => r.url().endsWith("/api/settings") && r.request().method() === "PUT"),
      page.getByRole("button", { name: "Save" }).click(),
    ]);
    check("colours: turning them off marks the page", await page.evaluate(() => document.documentElement.classList.contains("cell-colors-off")));
  } finally {
    await browser.close();
  }
}

// Imports in TypeScript cells: the Monaco worker gets real types from the server
// (Deno resolves them), cross-cell names from module cells, and Deno's error
// for what it can't resolve. Run All never asks the tutor.
async function importTypes() {
  await fetch(`${API}/api/notebooks`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "types" }) });
  await fetch(`${API}/api/notebooks`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "runall" }) });
  const browser = await launch();
  const page = await browser.newPage({ viewport: { width: 1300, height: 950 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  try {
    await page.goto(UI);
    const open = async (nb) => {
      await page.getByRole("button", { name: nb, exact: true }).click();
      await page.waitForFunction((nb) => document.querySelector("h1")?.textContent === nb, nb);
      await page.waitForFunction(() => globalThis.monaco && monaco.editor.getModels().length >= 1);
    };
    const cell = (n) => page.locator(".cell").nth(n);
    const count = () => page.locator(".cell").count();
    const cellId = (n) => page.evaluate((n) => document.querySelectorAll(".cell")[n].dataset.cellId, n);
    const setCell = (n, text) =>
      page.evaluate(
        ([n, text]) => {
          const id = document.querySelectorAll(".cell")[n].dataset.cellId;
          monaco.editor.getModels().filter((m) => m.uri.path.startsWith(`/cells/${id}.`)).at(-1).setValue(text);
        },
        [n, text],
      );
    const addCell = async (label) => {
      await page.locator(".add-row button", { hasText: label }).click();
      await page.waitForTimeout(300);
      return (await count()) - 1;
    };
    const markers = (n) => page.evaluate((n) => monaco.editor.getModelMarkers({ resource: monaco.Uri.parse(`file:///cells/${document.querySelectorAll(".cell")[n].dataset.cellId}.ts`) }).map((m) => m.message), n);
    const waitMarkers = async (n, re, ms) => {
      const end = Date.now() + ms;
      let last = [];
      while (Date.now() < end) {
        last = await markers(n);
        if (last.some((m) => re.test(m))) return last;
        await page.waitForTimeout(500);
      }
      return last;
    };

    await open("types");
    // A module cell (it imports) whose names reach the next cell, with zod's real types.
    await setCell(1, 'import { z } from "npm:zod@4";\nconst schema = z.string();');
    const b = await addCell("TypeScript");
    await setCell(b, 'const bad: number = schema.parse("x");');
    const mb = await waitMarkers(b, /not assignable/, 120000); // the first resolution may download the package
    check("types: a module cell's names reach later cells with the package's real types", mb.length === 1 && /Type 'string' is not assignable to type 'number'/.test(mb[0]), mb.join(" | "));
    check("types: the cell shows the error count", (await cell(b).locator(".type-errors").innerText().catch(() => "")).includes("1 type error"));
    check("types: the importing cell has no errors", (await markers(1)).length === 0, (await markers(1)).join(" | "));

    // Hover on `schema` in the second cell shows its zod type.
    const idB = await cellId(b);
    await page.evaluate((id) => {
      const model = monaco.editor.getModels().find((m) => m.uri.path === `/cells/${id}.ts`);
      const editor = monaco.editor.getEditors().find((e) => e.getModel() === model);
      editor.focus();
      editor.setPosition({ lineNumber: 1, column: 22 }); // inside `schema`
      editor.trigger("e2e", "editor.action.showHover", {});
    }, idB);
    const hover = await page.locator(".monaco-hover").filter({ hasText: "ZodString" }).first().innerText({ timeout: 15000 }).catch((e) => `no hover: ${e.message}`);
    check("types: hover shows the package's types (ZodString)", hover.includes("ZodString"), hover.slice(0, 200));

    // A package Deno can't resolve: "Cannot find module" plus Deno's reason, in the markers and in the cell's tooltip.
    const c = await addCell("TypeScript");
    await setCell(c, 'import nope from "npm:polyglot-tutor-no-such-package-zz@1";');
    const mc = await waitMarkers(c, /Deno:/, 120000);
    check("types: an unresolvable package reports Cannot find module + Deno's error", mc.length === 1 && /^Cannot find module 'npm:polyglot-tutor-no-such-package-zz@1'[\s\S]*\nDeno: /.test(mc[0]), mc.join(" | "));
    check("types: the tooltip carries Deno's error", ((await cell(c).locator(".type-errors").getAttribute("title")) ?? "").includes("Deno:"));
    const types = await (await fetch(`${API}/api/types/types.ipynb?specifier=${encodeURIComponent("npm:zod@4")}`)).json();
    check("api: /api/types returns ok, cumulative shims and zod's declaration files", types.status === "ok" && /declare module "npm:zod@4" \{ export \* from "zod"/.test(types.shims) && "node_modules/zod/package.json" in types.files, JSON.stringify(types).slice(0, 300));

    // A bare name from the notebooks folder's deno.json import map.
    writeFileSync(path.join(NB_DIR, "deno.json"), JSON.stringify({ imports: { zod: "npm:zod@4" } }));
    const d = await addCell("TypeScript");
    await setCell(d, 'import { z as mapped } from "zod";\nconst viaMap: number = mapped.string().parse("x");');
    const md = await waitMarkers(d, /not assignable/, 120000);
    check("types: a deno.json import-map name resolves to the package's real types", md.length === 1 && /Type 'string' is not assignable to type 'number'/.test(md[0]), md.join(" | "));
    const bogus = await (await fetch(`${API}/api/types/types.ipynb?specifier=${encodeURIComponent("npm:polyglot-tutor-no-such-package-zz@1")}`)).json();
    check("api: /api/types reports Deno's error and leaves the specifier undeclared", bogus.status === "error" && !!bogus.error && !bogus.shims.includes("no-such-package"), JSON.stringify(bogus).slice(0, 300));

    // An import that is a global already (node:process is `export = process`): its alias in the companion would be
    // circular and make every name of the cell any; the worker heals it, so the cell's other names keep their types.
    const g = await addCell("TypeScript");
    await setCell(g, 'import process from "node:process";\nimport { z } from "npm:zod@4";\nconst schema2 = z.string();\nconst exe = process.execPath;');
    const h = await addCell("TypeScript");
    await setCell(h, 'const bad2: number = schema2.parse("x");');
    const mh = await waitMarkers(h, /not assignable/, 120000);
    const mg = await markers(g);
    check("types: an import that is a global already (node:process) doesn't poison the cell's other names", mh.length === 1 && /Type 'string' is not assignable to type 'number'/.test(mh[0]) && mg.length === 0, `later cell: ${mh.join(" | ")} || module cell: ${mg.join(" | ")}`);

    // Run All runs code cells and skips prompt cells (never bills the API).
    await open("runall");
    await setCell(1, 'console.log("ran all");');
    const p = await addCell("✨ Prompt");
    await setCell(p, "Should this be asked?");
    const before = mockRequests().length;
    await page.getByRole("button", { name: "▶▶ Run all" }).click();
    await cell(1).locator(".outputs").waitFor({ timeout: 90000 });
    await page.waitForTimeout(2000);
    check("run all: code cells run", (await cell(1).locator(".outputs").innerText()).includes("ran all"));
    check("run all: prompt cells are skipped (no API request)", mockRequests().length === before && (await cell(p).locator(".response").count()) === 0, `${mockRequests().length - before} request(s)`);
    check("types: no page errors", errors.length === 0, errors.join("\n"));
  } finally {
    await browser.close();
  }
}

/** ONLY=kernel,ui,… runs a subset of the sections (for iterating on one). */
const only = process.env.ONLY ? new Set(process.env.ONLY.split(",")) : null;
const section = (name, fn) => (only && !only.has(name) ? Promise.resolve() : fn().catch((e) => check(name, false, e.stack ?? e)));

let exitCode = 1;
try {
  start(process.execPath, [path.join(ROOT, "tests/mock-anthropic.cjs"), MOCK_LOG, String(PORTS.mock)]);
  const server = start(process.execPath, [path.join(ROOT, "node_modules", "tsx", "dist", "cli.mjs"), "src/index.ts"], {
    cwd: path.join(ROOT, "packages", "server"),
    env: {
      ...process.env,
      NOTEBOOK_DIR: NB_DIR,
      PORT: String(PORTS.api),
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${PORTS.mock}`,
      ANTHROPIC_API_KEY: "test-key",
      SETTINGS_FILE: path.join(TMP, "settings.json"),
      SUMMARY_CACHE: path.join(TMP, "summaries.json"),
    },
  });
  start(process.execPath, [path.join(ROOT, "node_modules", "vite", "bin", "vite.js"), "--port", String(PORTS.ui), "--strictPort"], { cwd: path.join(ROOT, "packages", "web"), env: { ...process.env, PORT: String(PORTS.api) } });
  await waitFor(`${API}/api/status`).catch((e) => {
    throw new Error(`${e.message}\n${server.log().slice(-2000)}`);
  });
  await waitFor(UI);
  await section("kernel", () => kernelSmoke().catch((e) => Promise.reject(new Error(`${e}\n${server.log().slice(-1500)}`))));
  await section("welcome", welcomeTour);
  await section("ui", ui);
  await section("keys", commandMode);
  await section("ui2", ui2);
  await section("compression", compression);
  await section("settings", settingsUi);
  await section("types", importTypes);
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} passed${failed ? "" : " ✅"}`);
  exitCode = failed ? 1 : 0;
} catch (e) {
  console.error("✗ setup failed:", e);
} finally {
  for (const p of procs.reverse()) {
    try {
      if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(p.pid), "/T", "/F"]);
      else process.kill(-p.pid, "SIGTERM");
    } catch {}
  }
  await new Promise((r) => setTimeout(r, 1500));
  if (exitCode === 0 && !process.env.KEEP) rmSync(TMP, { recursive: true, force: true });
  else console.log(`artifacts kept in ${TMP}`);
  process.exit(exitCode);
}
