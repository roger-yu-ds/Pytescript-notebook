// Web app backend: REST for notebooks and settings, one WebSocket for running
// cells and streaming tutor answers. Kernels, the share/get hub and the tutor
// come from @polyglot-tutor/core.

import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer, type WebSocket } from "ws";
import {
  DEFAULT_SETTINGS,
  DenoResolver,
  RuntimeUnavailableError,
  Runtime,
  Tutor,
  TypesTooLarge,
  collectTypes,
  createNotebook,
  defaultDeno,
  denoTypes,
  kernelOf,
  listNotebooks,
  loadNotebook,
  safeName,
  saveNotebook,
  shimsFor,
  venvPython,
  type ClientMsg,
  type NotebookSession,
  type Resolution,
  type ServerMsg,
  type Settings,
} from "@polyglot-tutor/core";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
try {
  process.loadEnvFile(path.join(ROOT, ".env"));
} catch {
  /* no .env yet */
}

const PORT = Number(process.env.PORT ?? 8787);
const NOTEBOOK_DIR = process.env.NOTEBOOK_DIR ?? path.join(os.homedir(), "notebooks");
const CONFIG_DIR = path.join(os.homedir(), ".config", "polyglot-notebook");
const SETTINGS_FILE = process.env.SETTINGS_FILE ?? path.join(CONFIG_DIR, "settings.json");
const DENO = process.env.DENO_BIN ?? defaultDeno();
const PYTHON = process.env.PYTHON_BIN ?? venvPython(path.join(ROOT, ".venv"));

const runtime = new Runtime({ python: PYTHON, deno: DENO, stateDir: path.join(os.tmpdir(), `polyglot-tutor-web-${process.pid}`) });
const tutor = new Tutor({
  summaryCacheFile: process.env.SUMMARY_CACHE ?? path.join(os.homedir(), ".cache", "polyglot-notebook", "summaries.json"),
  missingKeyHelp: "No Anthropic API key found. Put ANTHROPIC_API_KEY=... in the project's .env file and restart the server.",
});

const notebookFile = (name: string) => path.join(NOTEBOOK_DIR, safeName(name));

// ---------- REST ----------

const app = new Hono();

app.get("/api/notebooks", async (c) => c.json(await listNotebooks(NOTEBOOK_DIR)));

app.post("/api/notebooks", async (c) => {
  const { name } = await c.req.json<{ name: string }>();
  const file = name.endsWith(".ipynb") ? name : `${name}.ipynb`;
  try {
    return c.json(await createNotebook(NOTEBOOK_DIR, file));
  } catch (e) {
    return c.json({ error: tutor.describeError(e) }, 400);
  }
});

app.get("/api/notebooks/:name", async (c) => {
  try {
    return c.json(await loadNotebook(NOTEBOOK_DIR, c.req.param("name")));
  } catch (e) {
    return c.json({ error: tutor.describeError(e) }, 404);
  }
});

app.put("/api/notebooks/:name", async (c) => {
  const nb = await c.req.json();
  nb.name = safeName(c.req.param("name"));
  await saveNotebook(NOTEBOOK_DIR, nb);
  return c.json({ ok: true });
});

app.get("/api/settings", async (c) => {
  try {
    return c.json({ ...DEFAULT_SETTINGS, ...JSON.parse(await readFile(SETTINGS_FILE, "utf8")) });
  } catch {
    return c.json(DEFAULT_SETTINGS);
  }
});

app.put("/api/settings", async (c) => {
  const s = (await c.req.json()) as Settings;
  await mkdir(path.dirname(SETTINGS_FILE), { recursive: true });
  await writeFile(SETTINGS_FILE, JSON.stringify(s, null, 2));
  return c.json({ ok: true });
});

app.get("/api/status", (c) => c.json({ apiKey: !!(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN), notebookDir: NOTEBOOK_DIR }));

// Deno's type declarations, so Monaco type-checks TypeScript cells like Deno does.
let denoTypesText: Promise<string> | null = null;
app.get("/api/deno-types", async (c) => {
  denoTypesText ??= denoTypes(DENO);
  try {
    return c.text(await denoTypesText, 200, { "Cache-Control": "max-age=3600" });
  } catch (e) {
    denoTypesText = null;
    return c.text(`// could not load Deno types: ${tutor.describeError(e)}`, 500);
  }
});

// Types for what a notebook's TypeScript cells import (npm:, jsr:, node:, import-map
// names, urls), resolved by Deno in the notebooks folder (its deno.json applies).
// One call per specifier; the shims cover every specifier resolved so far for the
// notebook, so the browser can replace its modules.d.ts each time. A specifier Deno
// can't resolve gets no shim (the cell shows "Cannot find module") and its error.
const resolver = new DenoResolver(DENO, { log: (m) => console.warn(`[deno] ${m}`) });
const resolved = new Map<string, Map<string, Resolution>>(); // notebook → specifier → resolution

interface TypesResponse {
  status: "ok" | "error";
  shims: string;
  files: Record<string, string>;
  error?: string;
}

app.get("/api/types/:nb", async (c) => {
  const specifier = c.req.query("specifier");
  if (!specifier) return c.json({ error: "specifier required" }, 400);
  let nb: string;
  try {
    nb = safeName(c.req.param("nb"));
  } catch (e) {
    return c.json({ error: tutor.describeError(e) }, 400);
  }
  let known = resolved.get(nb);
  if (!known) resolved.set(nb, (known = new Map()));
  const shims = () => shimsFor([...known.values()], [], NOTEBOOK_DIR);
  const results = await resolver.resolveAll(NOTEBOOK_DIR, [specifier]); // adds @types/node for node: imports
  const main = results.find((r) => r.specifier === specifier)!;
  if (main.kind === "error") return c.json<TypesResponse>({ status: "error", shims: shims(), files: {}, error: main.error ?? "could not resolve" });
  let files: Record<string, string>;
  try {
    files = collectTypes(results, NOTEBOOK_DIR);
  } catch (e) {
    const error = e instanceof TypesTooLarge ? e.message : tutor.describeError(e);
    return c.json<TypesResponse>({ status: "error", shims: shims(), files: {}, error });
  }
  for (const r of results) if (r.kind !== "error") known.set(r.specifier, r);
  return c.json<TypesResponse>({ status: "ok", shims: shims(), files });
});

// Shared values of a notebook, for the status bar. (The kernels talk to core's hub directly.)
app.get("/api/shared/:nb", async (c) => c.json(await session(c.req.param("nb")).index()));

// ---------- Sessions ----------

const sockets = new Set<WebSocket>();

function broadcast(msg: ServerMsg) {
  const s = JSON.stringify(msg);
  for (const ws of sockets) if (ws.readyState === ws.OPEN) ws.send(s);
}

/** The kernel session of a notebook, wired to broadcast its events. */
function session(notebook: string): NotebookSession {
  const existing = runtime.existing(notebookFile(notebook));
  if (existing) return existing;
  const s = runtime.session(notebookFile(notebook));
  s.onKernelState.on(({ lang, state }) => broadcast({ t: "kernel", notebook, lang, state }));
  s.onShared.on((items) => broadcast({ t: "shared", notebook, items }));
  return s;
}

const runtimeHelp = (e: RuntimeUnavailableError) =>
  e.lang === "python"
    ? `Python isn't set up: ${PYTHON} not found. See "One-time setup" in the README.`
    : `Deno isn't set up: ${DENO} not found. See "One-time setup" in the README.`;

// ---------- WebSocket ----------

const asks = new Map<string, AbortController>();

async function onMessage(ws: WebSocket, msg: ClientMsg) {
  const send = (m: ServerMsg) => ws.readyState === ws.OPEN && ws.send(JSON.stringify(m));
  switch (msg.t) {
    case "run": {
      try {
        send({ t: "clearOutput", cellId: msg.cellId });
        const r = await session(msg.notebook).run(
          msg.lang,
          msg.code,
          (output) => send({ t: "output", cellId: msg.cellId, output }),
          () => send({ t: "clearOutput", cellId: msg.cellId }),
        );
        send({ t: "runDone", cellId: msg.cellId, ok: r.ok, executionCount: r.executionCount });
      } catch (e) {
        const evalue = e instanceof RuntimeUnavailableError ? runtimeHelp(e) : tutor.describeError(e);
        send({ t: "output", cellId: msg.cellId, output: { kind: "error", ename: "KernelError", evalue, traceback: [] } });
        send({ t: "runDone", cellId: msg.cellId, ok: false, executionCount: null });
        broadcast({ t: "kernel", notebook: msg.notebook, lang: kernelOf(msg.lang), state: e instanceof RuntimeUnavailableError ? "off" : "dead" });
      }
      break;
    }
    case "interrupt":
      await session(msg.notebook).interrupt(msg.lang);
      break;
    case "restart":
      await session(msg.notebook).restart(msg.lang);
      break;
    case "ask": {
      const ctrl = new AbortController();
      asks.get(msg.req.cellId)?.abort();
      asks.set(msg.req.cellId, ctrl);
      try {
        const r = await tutor.ask(
          msg.req,
          {
            onText: (text) => send({ t: "askDelta", cellId: msg.req.cellId, text }),
            onThinking: (text) => send({ t: "askThinking", cellId: msg.req.cellId, text }),
          },
          ctrl.signal,
        );
        send({ t: "askDone", cellId: msg.req.cellId, ...r });
      } catch (e) {
        send({ t: "askError", cellId: msg.req.cellId, message: ctrl.signal.aborted ? "Stopped." : tutor.describeError(e) });
      } finally {
        if (asks.get(msg.req.cellId) === ctrl) asks.delete(msg.req.cellId);
      }
      break;
    }
    case "cancelAsk":
      asks.get(msg.cellId)?.abort();
      break;
    case "keepWarm": {
      try {
        send({ t: "warmDone", ...(await tutor.keepWarm(msg.req)) });
      } catch (e) {
        send({ t: "warmError", message: tutor.describeError(e) });
      }
      break;
    }
  }
}

const server = serve({ fetch: app.fetch, port: PORT, hostname: "127.0.0.1" }, (info) => {
  console.log(`polyglot server on http://127.0.0.1:${info.port}  (notebooks: ${NOTEBOOK_DIR})`);
});

const wss = new WebSocketServer({ noServer: true });
server.on("upgrade", (req, socket, head) => {
  if (req.url !== "/ws") return socket.destroy();
  wss.handleUpgrade(req, socket, head, (ws) => {
    sockets.add(ws);
    ws.on("close", () => sockets.delete(ws));
    ws.on("message", (data) => {
      let msg: ClientMsg;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }
      onMessage(ws, msg).catch((e) => console.error("ws handler error", e));
    });
  });
});

// First run: give an empty notebooks folder the guided tour.
listNotebooks(NOTEBOOK_DIR)
  .then(async (list) => {
    if (list.length === 0 && !process.env.NO_WELCOME) {
      await copyFile(path.join(ROOT, "examples", "welcome.ipynb"), path.join(NOTEBOOK_DIR, "welcome.ipynb"));
      console.log("created welcome.ipynb (a guided tour)");
    }
  })
  .catch((e) => console.error("could not create welcome notebook:", e));

// Start Jupyter early so the first run is quick.
runtime
  .server()
  .start()
  .then(
    () => console.log("jupyter server ready"),
    (e) => console.error("jupyter failed to start:", e),
  );

const shutdown = async () => {
  await runtime.dispose();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
