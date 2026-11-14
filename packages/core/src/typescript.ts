// How TypeScript cells are type-checked (shared by the web app's Monaco and the
// VS Code extension's checker). Browser-safe.
//
// Every TypeScript cell is its own file. Cells without imports are scripts, so
// their top-level declarations are global and later cells see them, mirroring
// how Deno's kernel keeps state between cells. A cell with an import is a
// module; cell-links.ts makes its names global too.

/**
 * Diagnostics that are normal in notebooks: re-running or redefining across
 * cells, top-level await. (Imports are resolved for real, see checker.ts and
 * deno-resolver.ts, so "Cannot find module" is reported.)
 */
export const TS_IGNORED_CODES: readonly number[] = [
  2451, // Cannot redeclare block-scoped variable (re-running/redefining across cells is normal)
  2300, // Duplicate identifier
  2393, // Duplicate function implementation
  1375, // top-level await only allowed in modules
  1378, // top-level await target
  2580, // Cannot find name 'require'
];

type Chain = string | { messageText: string; next?: Chain[] };

/** Flatten a TypeScript diagnostic message chain into indented lines. */
export const flattenMessage = (c: Chain, depth = 0): string =>
  typeof c === "string" ? c : ["  ".repeat(depth) + c.messageText, ...(c.next ?? []).map((n) => flattenMessage(n, depth + 1))].join("\n");

/** Declarations for the share()/get() helpers defined in every Deno kernel. */
export const HELPER_TYPES_SOURCE = `/** Share a value with the other languages (Python, SQL). Arrays of objects become tables. */
declare function share(name: string, value: unknown, opts?: { persist?: boolean }): Promise<void>;
/** Get a value shared from any language. Tables arrive as arrays of plain objects. */
declare function get<T = any>(name: string): Promise<T>;
`;
