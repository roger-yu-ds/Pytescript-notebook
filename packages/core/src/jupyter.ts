// Runs a local `jupyter server` and talks to its kernels over the
// Jupyter kernel WebSocket protocol (JSON messages, legacy framing).

import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { mkdirSync } from "node:fs";
import path from "node:path";
import WebSocket from "ws";
import type { KernelLang as Lang, KernelState, Output } from "./types.ts";

/** Where core reports what it's doing; level defaults to "warn". */
export type Logger = (message: string, level?: "info" | "warn") => void;

export const consoleLogger: Logger = (m, level = "warn") => (level === "info" ? console.log(m) : console.error(m));

export interface JupyterServerOptions {
  /** Python executable of an environment with jupyter_server + ipykernel. */
  python: string;
  /** Server root; kernels start here and then chdir into their notebook's folder. */
  rootDir: string;
  /** Extra Jupyter data dir (prepended to JUPYTER_PATH), e.g. for our Deno kernel spec. */
  jupyterPath?: string;
  /** Extra environment variables for the server, inherited by every kernel it starts. */
  env?: Record<string, string>;
  log?: Logger;
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      srv.close(() => (typeof addr === "object" && addr ? resolve(addr.port) : reject(new Error("no port"))));
    });
  });
}

export class JupyterServer {
  private proc: ChildProcess | null = null;
  private port = 0;
  readonly token = randomBytes(24).toString("hex");
  private ready: Promise<void> | null = null;

  private log: Logger;

  constructor(private opts: JupyterServerOptions) {
    this.log = opts.log ?? consoleLogger;
  }

  get baseUrl() {
    return `http://127.0.0.1:${this.port}`;
  }
  get wsBase() {
    return `ws://127.0.0.1:${this.port}`;
  }

  start(): Promise<void> {
    if (this.ready) return this.ready;
    this.ready = (async () => {
      const started = Date.now();
      this.port = await freePort();
      mkdirSync(this.opts.rootDir, { recursive: true });
      const env = { ...process.env, ...this.opts.env };
      if (this.opts.jupyterPath) env.JUPYTER_PATH = [this.opts.jupyterPath, env.JUPYTER_PATH].filter(Boolean).join(path.delimiter);
      // Tools installed next to python (e.g. a venv's scripts) come first on PATH.
      env.PATH = [path.dirname(this.opts.python), env.PATH].filter(Boolean).join(path.delimiter);
      this.proc = spawn(
        this.opts.python,
        [
          "-m",
          "jupyter_server",
          "--no-browser",
          `--ServerApp.ip=127.0.0.1`,
          `--ServerApp.port=${this.port}`,
          `--ServerApp.port_retries=0`,
          `--IdentityProvider.token=${this.token}`,
          `--ServerApp.root_dir=${this.opts.rootDir}`,
          `--ServerApp.allow_root=True`, // containers often run as root; the server is local-only anyway
        ],
        { stdio: ["ignore", "ignore", "pipe"], env, windowsHide: true },
      );
      let log = "";
      let exited = false;
      this.proc.stderr?.on("data", (d: Buffer) => {
        log = (log + d.toString()).slice(-4000);
      });
      this.proc.on("error", (e) => {
        exited = true;
        log += `\n${e.message}`;
      });
      this.proc.on("exit", (code) => {
        exited = true;
        this.log(`[jupyter] server exited (${code})\n${log}`);
        this.ready = null;
      });
      const deadline = Date.now() + 90_000;
      while (Date.now() < deadline) {
        if (exited) throw new Error(`Jupyter server failed to start with ${this.opts.python}: ${log.trim().split("\n").slice(-3).join(" ")}`);
        try {
          const r = await this.api("GET", "/api/status");
          if (r.ok) {
            this.log(`[jupyter] server ready in ${Date.now() - started} ms`, "info");
            return;
          }
        } catch {
          /* not up yet */
        }
        await new Promise((r) => setTimeout(r, 300));
      }
      throw new Error("jupyter server did not start within 90s");
    })();
    return this.ready;
  }

  api(method: string, p: string, body?: unknown) {
    return fetch(`${this.baseUrl}${p}`, {
      method,
      headers: { Authorization: `token ${this.token}`, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }

  /**
   * Start a kernel by kernel-spec name and run its prelude. `path` (relative to
   * the server root, "/"-separated) is the kernel's working directory: Jupyter
   * only starts kernels inside its root, so sessions link notebook folders into it.
   */
  async startKernel(lang: Lang, kernelName: string, prelude?: string, path = ""): Promise<Kernel> {
    await this.start();
    const r = await this.api("POST", "/api/kernels", { name: kernelName, path });
    if (!r.ok) throw new Error(`could not start the ${lang} kernel (${kernelName}): ${r.status} ${await r.text()}`);
    const { id } = (await r.json()) as { id: string };
    const k = new Kernel(this, id, lang, prelude, this.log);
    const t0 = Date.now();
    await k.connect();
    await k.runPrelude();
    this.log(`[jupyter] ${lang} kernel ready in ${Date.now() - t0} ms`, "info");
    return k;
  }

  stop() {
    this.proc?.kill();
    this.proc = null;
    this.ready = null;
  }
}

interface JMsg {
  header: { msg_id: string; msg_type: string };
  parent_header: { msg_id?: string };
  content: any;
  channel: string;
}

interface PendingRun {
  onOutput: (o: Output) => void;
  onClear: () => void;
  resolve: (r: { ok: boolean; executionCount: number | null }) => void;
  ok: boolean;
  executionCount: number | null;
  gotReply: boolean;
  gotIdle: boolean;
  /** Deno kernel: the quiet spell after reply + idle before the run is finished (see finish). */
  settle?: ReturnType<typeof setTimeout>;
}

/** How long a Deno cell's run waits for late output after its idle status. */
const DENO_SETTLE_MS = 100;

export class Kernel {
  private ws: WebSocket | null = null;
  private session = randomUUID();
  private pending = new Map<string, PendingRun>();
  private queue: Promise<unknown> = Promise.resolve();
  state: KernelState = "starting";
  onState: (s: KernelState) => void = () => {};

  constructor(
    private server: JupyterServer,
    readonly id: string,
    readonly lang: Lang,
    private prelude?: string,
    private log: Logger = consoleLogger,
  ) {}

  /** Define share()/get() etc. Runs silently, outside the run queue. */
  async runPrelude() {
    if (!this.prelude) return;
    const errors: string[] = [];
    const r = await this.send(this.prelude, true, (o) => o.kind === "error" && errors.push(`${o.ename}: ${o.evalue}`), () => {});
    if (!r.ok) this.log(`[kernel ${this.lang}] prelude failed: ${errors.join("; ") || "unknown error"}`);
  }

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const url = `${this.server.wsBase}/api/kernels/${this.id}/channels?session_id=${this.session}`;
      const ws = new WebSocket(url, { headers: { Authorization: `token ${this.server.token}` } });
      this.ws = ws;
      ws.on("open", () => {
        this.setState("idle");
        resolve();
      });
      ws.on("error", (e) => reject(e));
      ws.on("close", () => {
        this.setState("dead");
        for (const p of this.pending.values()) p.resolve({ ok: false, executionCount: null });
        this.pending.clear();
      });
      ws.on("message", (data) => this.handle(JSON.parse(data.toString()) as JMsg));
    });
  }

  private setState(s: KernelState) {
    this.state = s;
    this.onState(s);
  }

  private handle(msg: JMsg) {
    const type = msg.header.msg_type;
    if (type === "status" && msg.channel === "iopub") {
      const st = msg.content.execution_state;
      if (st === "busy" || st === "idle") this.setState(st);
      if (st === "dead") this.setState("dead");
    }
    const pid = msg.parent_header?.msg_id;
    const p = pid ? this.pending.get(pid) : undefined;
    if (!p || !pid) return;
    const c = msg.content;
    switch (type) {
      case "stream":
        p.onOutput({ kind: "stream", name: c.name, text: c.text });
        break;
      case "display_data":
      case "execute_result":
      case "update_display_data":
        p.onOutput({ kind: "display", data: c.data });
        break;
      case "error":
        p.ok = false;
        p.onOutput({ kind: "error", ename: c.ename, evalue: c.evalue, traceback: c.traceback ?? [] });
        break;
      case "clear_output":
        p.onClear();
        break;
      case "execute_reply":
        p.gotReply = true;
        p.executionCount = c.execution_count ?? null;
        if (c.status !== "ok") p.ok = false;
        break;
      case "status":
        if (c.execution_state === "idle") p.gotIdle = true;
        break;
    }
    if (p.gotReply && p.gotIdle) this.finish(pid, p);
  }

  /**
   * A run is done once its reply and its idle status are in. Deno's kernel
   * forwards console output to iopub from another task, so a cell's last lines
   * can arrive after idle: for it, every message restarts a short quiet spell
   * and the run finishes when none came.
   */
  private finish(pid: string, p: PendingRun) {
    const done = () => {
      this.pending.delete(pid);
      p.resolve({ ok: p.ok, executionCount: p.executionCount });
    };
    if (this.lang !== "typescript") return done();
    clearTimeout(p.settle);
    p.settle = setTimeout(done, DENO_SETTLE_MS);
  }

  private send(code: string, silent: boolean, onOutput: (o: Output) => void, onClear: () => void) {
    return new Promise<{ ok: boolean; executionCount: number | null }>((resolve) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        onOutput({ kind: "error", ename: "KernelDead", evalue: "The kernel is not running. Restart it.", traceback: [] });
        resolve({ ok: false, executionCount: null });
        return;
      }
      const msgId = randomUUID();
      this.pending.set(msgId, { onOutput, onClear, resolve, ok: true, executionCount: null, gotReply: false, gotIdle: false });
      this.ws.send(
        JSON.stringify({
          header: { msg_id: msgId, username: "polyglot", session: this.session, msg_type: "execute_request", version: "5.3", date: new Date().toISOString() },
          parent_header: {},
          metadata: {},
          content: { code, silent, store_history: !silent, user_expressions: {}, allow_stdin: false, stop_on_error: true },
          channel: "shell",
          buffers: [],
        }),
      );
    });
  }

  /** Run helper code silently (queued with user runs). Resolves with stdout; rejects on error. */
  async runSilent(code: string): Promise<string> {
    let stdout = "";
    const errors: string[] = [];
    const run = () =>
      this.send(code, true, (o) => {
        if (o.kind === "stream") stdout += o.text;
        if (o.kind === "error") errors.push(`${o.ename}: ${o.evalue}`);
      }, () => {});
    const result = this.queue.then(run, run);
    this.queue = result.catch(() => {});
    const r = await result;
    if (!r.ok) throw new Error(errors.join("; ") || "kernel error");
    return stdout;
  }

  /** Execute code; runs are queued so outputs never interleave. */
  execute(code: string, onOutput: (o: Output) => void, onClear: () => void) {
    const run = () => this.send(code, false, onOutput, onClear);
    const result = this.queue.then(run, run);
    this.queue = result.catch(() => {});
    return result;
  }

  async interrupt() {
    await this.server.api("POST", `/api/kernels/${this.id}/interrupt`);
  }

  async restart() {
    // Runs requested after a restart wait for it (they chain on this.queue).
    const p = (async () => {
      this.setState("starting");
      await this.server.api("POST", `/api/kernels/${this.id}/restart`);
      await this.runPrelude();
      this.setState("idle");
    })();
    for (const run of this.pending.values()) run.resolve({ ok: false, executionCount: null });
    this.pending.clear();
    this.queue = p.catch(() => {});
    await p;
  }

  async shutdown() {
    this.ws?.close();
    await this.server.api("DELETE", `/api/kernels/${this.id}`).catch(() => {});
  }
}
