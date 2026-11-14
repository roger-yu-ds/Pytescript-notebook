// The share()/get() hub: a small HTTP server on 127.0.0.1 that the kernels call.
// Every request needs the hub token, which only our kernel preludes know.
//
//   GET  /api/shared/:ns              index of the namespace (a notebook)
//   GET  /api/shared/:ns/:name        a value (?format=arrow|json)
//   PUT  /api/shared/:ns/:name        store a value (?from=lang&persist=1)

import { serve, type ServerType } from "@hono/node-server";
import { Hono } from "hono";
import { randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
import type { SharedStore } from "./shared-store.ts";
import type { SharedItem } from "./types.ts";

/** What the hub needs from a notebook to serve its namespace. */
export interface HubNamespace {
  /** Persist a value already in the store as a Delta table; returns the new version. */
  persist(name: string): Promise<number>;
  /** Load a persisted table into the store (for a get() of a table saved earlier). */
  publish(name: string): Promise<void>;
  isPersisted(name: string): boolean;
  index(): Promise<SharedItem[]>;
  /** Called after a value changed. */
  changed(): void;
}

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

export class Hub {
  readonly token = randomBytes(16).toString("hex");
  private server: ServerType | null = null;
  private started: Promise<string> | null = null;

  constructor(
    private store: SharedStore,
    private resolve: (ns: string) => HubNamespace | undefined,
  ) {}

  /** The Hono app (exposed for tests). */
  readonly app = this.createApp();

  private createApp() {
    const app = new Hono();
    app.use("/api/shared/*", async (c, next) => {
      if (c.req.header("x-polyglot-token") !== this.token) return c.text("forbidden", 403);
      await next();
    });

    app.get("/api/shared/:ns", async (c) => {
      const ns = this.resolve(c.req.param("ns"));
      return ns ? c.json(await ns.index()) : c.json([]);
    });

    app.get("/api/shared/:ns/:name", async (c) => {
      const id = c.req.param("ns");
      const name = c.req.param("name");
      const format = c.req.query("format") === "arrow" ? "arrow" : "json";
      let r = this.store.get(id, name, format);
      const ns = this.resolve(id);
      if (!r && ns?.isPersisted(name)) {
        try {
          await ns.publish(name);
          r = this.store.get(id, name, format);
        } catch (e) {
          return c.text(`could not load persisted table "${name}": ${errorText(e)}`, 500);
        }
      }
      if (!r) return c.text("not found", 404);
      return c.body(r.body as any, 200, { "content-type": r.contentType });
    });

    app.put("/api/shared/:ns/:name", async (c) => {
      const id = c.req.param("ns");
      const ns = this.resolve(id);
      if (!ns) return c.text("unknown notebook", 404);
      try {
        const item = this.store.put(
          id,
          c.req.param("name"),
          c.req.query("from") ?? "unknown",
          c.req.header("content-type") ?? "application/json",
          new Uint8Array(await c.req.arrayBuffer()),
          c.req.header("x-polyglot-kind"),
        );
        if (c.req.query("persist") === "1") item.summary += ` · saved as Delta v${await ns.persist(item.name)}`;
        ns.changed();
        return c.json(item);
      } catch (e) {
        return c.text(`could not store "${c.req.param("name")}": ${errorText(e)}`, 400);
      }
    });
    return app;
  }

  /** Start listening on a free port; resolves with the base URL. */
  start(): Promise<string> {
    this.started ??= new Promise((resolve, reject) => {
      const server = serve({ fetch: this.app.fetch, port: 0, hostname: "127.0.0.1" }, (info: AddressInfo) => resolve(`http://127.0.0.1:${info.port}`));
      server.on("error", reject);
      this.server = server;
    });
    return this.started;
  }

  /** The URL a notebook's kernels use (namespace = notebook session id). */
  async urlFor(ns: string): Promise<string> {
    return `${await this.start()}/api/shared/${encodeURIComponent(ns)}`;
  }

  close() {
    this.server?.close();
    this.server = null;
    this.started = null;
  }
}
