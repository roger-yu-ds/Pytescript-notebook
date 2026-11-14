import { toContextCells, type Cell, type ContextCell } from "@polyglot-tutor/core/browser";
import { typeErrors } from "./monaco.ts";

/** Visible (not 🙈) cells before `end`, as sent to the AI, with TypeScript type errors filled in. */
export async function contextCells(cells: Cell[], end: number): Promise<ContextCell[]> {
  const out = toContextCells(cells, end);
  await Promise.all(out.map(async (c) => c.lang === "typescript" && (c.typeErrors = await typeErrors(c.id))));
  return out;
}
