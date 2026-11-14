// Colours for cell types in the web app: a stripe per language and a tint for Tutor Prompt cells.
// Stored in Settings.cellColors (partial: missing or invalid values fall back to the defaults).

export type CellColorKind = "markdown" | "python" | "typescript" | "sql" | "prompt";

export interface CellColors {
  /** Show the colours at all. */
  enabled: boolean;
  markdown: string;
  python: string;
  typescript: string;
  sql: string;
  prompt: string;
  /** Background of Tutor Prompt cells. */
  promptBackground: string;
}

export const CELL_COLOR_KINDS: readonly CellColorKind[] = ["markdown", "python", "typescript", "sql", "prompt"];

export const DEFAULT_CELL_COLORS: CellColors = {
  enabled: true,
  markdown: "#7d8590",
  python: "#e5c07b",
  typescript: "#61afef",
  sql: "#98c379",
  prompt: "#b48cff",
  promptBackground: "#1f1b29",
};

const HEX = /^#[0-9a-f]{6}$/i;

/** The saved colours merged over the defaults; anything that isn't a #rrggbb colour is replaced by its default. */
export function resolveCellColors(saved?: Partial<CellColors> | null): CellColors {
  const out: CellColors = { ...DEFAULT_CELL_COLORS };
  if (!saved || typeof saved !== "object") return out;
  if (typeof saved.enabled === "boolean") out.enabled = saved.enabled;
  for (const key of [...CELL_COLOR_KINDS, "promptBackground"] as const) {
    const v = saved[key];
    if (typeof v === "string" && HEX.test(v)) out[key] = v.toLowerCase();
  }
  return out;
}

/** CSS custom properties for the colours (the stylesheet falls back to plain cells when `enabled` is false). */
export function cellColorVars(colors: CellColors): Record<string, string> {
  const vars: Record<string, string> = {};
  for (const kind of CELL_COLOR_KINDS) vars[`--lang-${kind}`] = colors[kind];
  vars["--prompt-bg"] = colors.promptBackground;
  return vars;
}
