// What the tutor sees of a notebook, and whether the prompt cache still matches
// it. Browser-safe.

import type { AskRequest, CacheHit, CacheInfo, Cell, ContextCell } from "./types.ts";

/**
 * Visible (not 🙈) cells before position `end`, as sent to the tutor. Type
 * errors are left for the caller to fill in (they come from the editor).
 */
export function toContextCells(cells: Cell[], end = cells.length): ContextCell[] {
  const out: ContextCell[] = [];
  for (let i = 0; i < Math.min(end, cells.length); i++) {
    const c = cells[i];
    if (c.hidden) continue;
    out.push({
      id: c.id,
      index: i + 1,
      type: c.type,
      lang: c.type === "code" ? c.lang : undefined,
      source: c.source,
      outputs: c.type === "code" ? c.outputs : [],
      response: c.type === "prompt" ? (c.response ?? "") : undefined,
      pinned: c.pinned || undefined,
    });
  }
  return out;
}

/**
 * Stable short hash used to detect edits inside the cached prefix. Type errors
 * are left out: they follow deterministically from the cell sources.
 */
export function hashCell(c: ContextCell): string {
  const s = JSON.stringify([c.index, c.type, c.lang, c.source, c.outputs, c.response, c.pinned]);
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}

/** Combine what the server reported with the cells the request covered. */
export function cacheInfoFor(req: Pick<AskRequest, "cells">, hit: CacheHit | null): CacheInfo | null {
  return hit ? { ...hit, cells: req.cells.map((c) => ({ id: c.id, hash: hashCell(c) })) } : null;
}

/**
 * Has the cached prefix been edited? Returns the notebook position (1-based) of
 * the first cell that no longer matches, or null if the cache still applies.
 */
export function staleFrom(cells: Cell[], cache: CacheInfo): number | null {
  const ctx = toContextCells(cells);
  for (let i = 0; i < cache.cells.length; i++) {
    const want = cache.cells[i];
    const have = ctx[i];
    if (!have || have.id !== want.id || hashCell(have) !== want.hash) {
      const pos = cells.findIndex((c) => c.id === want.id);
      return pos >= 0 ? pos + 1 : (have?.index ?? cells.length);
    }
  }
  return null;
}

/** Milliseconds left before a cache expires (≤ 0 when cold). */
export const cacheTimeLeft = (cache: CacheInfo, now = Date.now()) => cache.startedAt + cache.ttlMs - now;

/** "m:ss" for a countdown. */
export function formatCountdown(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}
