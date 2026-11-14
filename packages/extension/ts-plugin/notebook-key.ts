// How the extension and the tsserver plugin agree on which notebook a cell
// belongs to. VS Code names a notebook cell for tsserver
// `^/vscode-notebook-cell/<authority>/<notebook path>#<cell>`; the extension
// knows the notebook's URI path. Both sides reduce theirs to the same key.

export const CELL_SCHEME = "vscode-notebook-cell";

/** True for a tsserver file name of a notebook cell. */
export const isCellFile = (file: string) => file.includes(`${CELL_SCHEME}/`);

/** A notebook URI path as a lookup key: forward slashes, no leading slash, lower case (Windows paths differ in case). */
export const notebookKey = (uriPath: string) => uriPath.replace(/\\/g, "/").replace(/^\/+/, "").toLowerCase();

/** The key of the notebook a tsserver cell file belongs to; undefined for other files. */
export function notebookOfCell(file: string): string | undefined {
  const i = file.indexOf(`${CELL_SCHEME}/`);
  if (i < 0) return undefined;
  const afterScheme = file.slice(i + CELL_SCHEME.length + 1); // "<authority>/<path>#<cell>"
  const slash = afterScheme.indexOf("/");
  if (slash < 0) return undefined;
  let p = afterScheme.slice(slash);
  const hash = p.lastIndexOf("#");
  if (hash >= 0) p = p.slice(0, hash);
  return notebookKey(p);
}
