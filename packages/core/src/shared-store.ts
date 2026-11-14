// The share/get hub. Each notebook has its own namespace of shared values.
// Tables are stored as Arrow IPC (stream format); plain values as JSON.
// Python sends/receives Arrow; TypeScript sends/receives JSON rows and the hub
// converts, so the Deno kernel needs no Arrow library.

import {
  Bool,
  Float64,
  Int32,
  TimestampMillisecond,
  Type,
  Utf8,
  makeTable,
  tableFromIPC,
  tableToIPC,
  vectorFromArray,
  type DataType,
  type Table,
} from "apache-arrow";
import type { SharedItem } from "./types.ts";

interface Entry {
  kind: "table" | "json";
  arrow?: Uint8Array;
  json?: string;
  version: number;
  from: string;
  summary: string;
}

const isRowArray = (v: unknown): v is Record<string, unknown>[] =>
  Array.isArray(v) && v.length > 0 && v.every((r) => r !== null && typeof r === "object" && !Array.isArray(r) && !(r instanceof Date));

function inferType(values: unknown[]): DataType {
  const present = values.filter((v) => v !== null && v !== undefined);
  if (present.length && present.every((v) => typeof v === "boolean")) return new Bool();
  if (present.length && present.every((v) => typeof v === "number")) {
    const ints = present.every((v) => Number.isInteger(v) && Math.abs(v as number) < 2 ** 31);
    return ints ? new Int32() : new Float64();
  }
  if (present.length && present.every((v) => typeof v === "string" && /^\d{4}-\d\d-\d\dT[\d:.]+(Z|[+-]\d\d:\d\d)?$/.test(v)))
    return new TimestampMillisecond();
  return new Utf8();
}

function rowsToTable(rows: Record<string, unknown>[]): Table {
  const columns = [...new Set(rows.flatMap((r) => Object.keys(r)))];
  const vectors: Record<string, any> = {};
  for (const col of columns) {
    const values = rows.map((r) => r[col] ?? null);
    const type = inferType(values);
    let data: unknown[] = values;
    if (type instanceof TimestampMillisecond) data = values.map((v) => (v == null ? null : Date.parse(v as string)));
    else if (type instanceof Utf8) data = values.map((v) => (v == null ? null : typeof v === "string" ? v : JSON.stringify(v)));
    vectors[col] = vectorFromArray(data as any, type as any);
  }
  return makeTable(vectors as any);
}

function plain(v: unknown, type: DataType): unknown {
  if (v === null || v === undefined) return null;
  if (typeof v === "bigint") return Number.isSafeInteger(Number(v)) ? Number(v) : v.toString();
  if (type.typeId === Type.Timestamp || type.typeId === Type.Date) {
    const ms = typeof v === "number" ? v : v instanceof Date ? v.getTime() : Number(v);
    return new Date(ms).toISOString();
  }
  if (type.typeId === Type.Decimal) return Number(String(v));
  if (v instanceof Uint8Array) return Array.from(v);
  return v;
}

function tableToRows(t: Table): Record<string, unknown>[] {
  const fields = t.schema.fields;
  const cols = fields.map((f) => t.getChild(f.name)!);
  const rows: Record<string, unknown>[] = [];
  for (let i = 0; i < t.numRows; i++) {
    const row: Record<string, unknown> = {};
    fields.forEach((f, j) => (row[f.name] = plain(cols[j].get(i), f.type)));
    rows.push(row);
  }
  return rows;
}

const tableSummary = (t: Table) => `table ${t.numRows}×${t.numCols} (${t.schema.fields.map((f) => f.name).join(", ").slice(0, 80)})`;

function jsonSummary(v: unknown) {
  const s = JSON.stringify(v) ?? "undefined";
  const type = Array.isArray(v) ? `array[${v.length}]` : v === null ? "null" : typeof v;
  return `${type} ${s.length > 60 ? s.slice(0, 57) + "…" : s}`;
}

/** Shared values, one namespace per notebook. */
export class SharedStore {
  private spaces = new Map<string, Map<string, Entry>>();
  private version = 0;

  private space(ns: string) {
    let s = this.spaces.get(ns);
    if (!s) this.spaces.set(ns, (s = new Map()));
    return s;
  }

  /** Store a value. Arrow bodies are tables; JSON row arrays become tables when kindHint is "table". */
  put(ns: string, name: string, from: string, contentType: string, body: Uint8Array, kindHint?: string): SharedItem {
    let entry: Entry;
    if (contentType.includes("arrow")) {
      const t = tableFromIPC(body);
      entry = { kind: "table", arrow: new Uint8Array(body), version: ++this.version, from, summary: tableSummary(t) };
    } else {
      const value = JSON.parse(new TextDecoder().decode(body));
      if (kindHint === "table" && isRowArray(value)) {
        const t = rowsToTable(value);
        entry = { kind: "table", arrow: tableToIPC(t, "stream"), version: ++this.version, from, summary: tableSummary(t) };
      } else {
        entry = { kind: "json", json: JSON.stringify(value), version: ++this.version, from, summary: jsonSummary(value) };
      }
    }
    this.space(ns).set(name, entry);
    return { name, kind: entry.kind, version: entry.version, from: entry.from, summary: entry.summary };
  }

  /** A value as Arrow (tables only) or JSON (tables become arrays of row objects). */
  get(ns: string, name: string, format: "arrow" | "json"): { contentType: string; body: Uint8Array | string } | null {
    const e = this.spaces.get(ns)?.get(name);
    if (!e) return null;
    if (e.kind === "json") return { contentType: "application/json", body: e.json! };
    if (format === "arrow") return { contentType: "application/vnd.apache.arrow.stream", body: e.arrow! };
    return {
      contentType: "application/json",
      body: JSON.stringify(tableToRows(tableFromIPC(e.arrow!)), (_k, v) => (typeof v === "bigint" ? v.toString() : v)),
    };
  }

  list(ns: string): SharedItem[] {
    return [...(this.spaces.get(ns)?.entries() ?? [])].map(([name, e]) => ({ name, kind: e.kind, version: e.version, from: e.from, summary: e.summary }));
  }

  clear(ns: string) {
    this.spaces.delete(ns);
  }
}
