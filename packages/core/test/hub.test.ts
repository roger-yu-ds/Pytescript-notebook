import assert from "node:assert/strict";
import { test } from "node:test";
import { tableFromIPC } from "apache-arrow";
import { Hub, type HubNamespace } from "../src/hub.ts";
import { SharedStore } from "../src/shared-store.ts";

function setup() {
  const store = new SharedStore();
  const calls: string[] = [];
  const ns: HubNamespace = {
    persist: async (name) => (calls.push(`persist ${name}`), 4),
    publish: async (name) => {
      calls.push(`publish ${name}`);
      store.put("nb", name, "python", "application/json", new TextEncoder().encode(JSON.stringify([{ a: 1 }])), "table");
    },
    isPersisted: (name) => name === "saved",
    index: async () => store.list("nb"),
    changed: () => calls.push("changed"),
  };
  const hub = new Hub(store, (id) => (id === "nb" ? ns : undefined));
  const req = (method: string, p: string, body?: unknown, headers: Record<string, string> = {}) =>
    hub.app.request(`http://hub/api/shared/${p}`, {
      method,
      headers: { "x-polyglot-token": hub.token, "content-type": "application/json", ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  return { hub, store, calls, req };
}

test("every route needs the token", async () => {
  const { hub } = setup();
  for (const p of ["nb", "nb/x"]) assert.equal((await hub.app.request(`http://hub/api/shared/${p}`)).status, 403);
});

test("TypeScript rows become a table; Python reads Arrow, TypeScript reads JSON", async () => {
  const { req, calls } = setup();
  const put = await req("PUT", "nb/people?from=typescript", [{ name: "Ada", age: 36, at: "2024-01-02T03:04:05Z" }, { name: "Bo", age: 2.5, at: null }], { "x-polyglot-kind": "table" });
  assert.equal(put.status, 200);
  assert.match(((await put.json()) as any).summary, /table 2×3/);
  assert.deepEqual(calls, ["changed"]);
  const arrow = tableFromIPC(new Uint8Array(await (await req("GET", "nb/people?format=arrow")).arrayBuffer()));
  assert.deepEqual(arrow.schema.fields.map((f) => String(f.type)), ["Utf8", "Float64", "Timestamp<MILLISECOND>"]);
  const rows = (await (await req("GET", "nb/people?format=json")).json()) as any[];
  assert.deepEqual(rows[0], { name: "Ada", age: 36, at: "2024-01-02T03:04:05.000Z" });
});

test("plain JSON values stay JSON", async () => {
  const { req } = setup();
  await req("PUT", "nb/cfg?from=python", { a: [1, 2] });
  assert.deepEqual(await (await req("GET", "nb/cfg")).json(), { a: [1, 2] });
});

test("persist=1 asks the notebook to write Delta and reports the version", async () => {
  const { req, calls } = setup();
  const r = await req("PUT", "nb/t?from=typescript&persist=1", [{ a: 1 }], { "x-polyglot-kind": "table" });
  assert.match(((await r.json()) as any).summary, /saved as Delta v4/);
  assert.deepEqual(calls, ["persist t", "changed"]);
});

test("a miss on a persisted table publishes it first; unknown names 404", async () => {
  const { req, calls } = setup();
  assert.deepEqual(await (await req("GET", "nb/saved")).json(), [{ a: 1 }]);
  assert.deepEqual(calls, ["publish saved"]);
  assert.equal((await req("GET", "nb/nope")).status, 404);
  assert.equal((await req("PUT", "other/x", 1)).status, 404);
});

test("listens on a free localhost port", async () => {
  const { hub } = setup();
  const url = await hub.urlFor("nb");
  assert.match(url, /^http:\/\/127\.0\.0\.1:\d+\/api\/shared\/nb$/);
  assert.equal((await fetch(url, { headers: { "x-polyglot-token": hub.token } })).status, 200);
  hub.close();
});
