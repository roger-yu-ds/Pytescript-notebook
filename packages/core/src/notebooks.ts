// Notebook files on disk (the web app's notebooks folder).

import { mkdir, readdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fromIpynb, newCellId, toIpynb } from "./ipynb.ts";
import type { Notebook } from "./types.ts";

export function safeName(name: string): string {
  const base = path.basename(name);
  if (!/^[\w\- .()]+\.ipynb$/.test(base)) throw new Error(`invalid notebook name: ${name}`);
  return base;
}

export async function listNotebooks(dir: string) {
  await mkdir(dir, { recursive: true });
  const names = (await readdir(dir)).filter((n) => n.endsWith(".ipynb"));
  const items = await Promise.all(names.map(async (name) => ({ name, mtime: (await stat(path.join(dir, name))).mtimeMs })));
  return items.sort((a, b) => b.mtime - a.mtime);
}

export async function loadNotebook(dir: string, name: string): Promise<Notebook> {
  const file = path.join(dir, safeName(name));
  const raw = JSON.parse(await readFile(file, "utf8"));
  return fromIpynb(safeName(name), raw);
}

export async function saveNotebook(dir: string, nb: Notebook) {
  const file = path.join(dir, safeName(nb.name));
  const tmp = `${file}.tmp`;
  await writeFile(tmp, JSON.stringify(toIpynb(nb), null, 1) + "\n");
  await rename(tmp, file); // atomic replace
}

export async function createNotebook(dir: string, name: string): Promise<Notebook> {
  const nb: Notebook = {
    name: safeName(name),
    cells: [
      { id: newCellId(), type: "markdown", source: "# " + name.replace(/\.ipynb$/, ""), outputs: [] },
      { id: newCellId(), type: "code", lang: "typescript", source: "", outputs: [] },
    ],
  };
  await mkdir(dir, { recursive: true });
  try {
    await stat(path.join(dir, nb.name));
    throw new Error(`${nb.name} already exists`);
  } catch (e: any) {
    if (e?.code !== "ENOENT") throw e;
  }
  await saveNotebook(dir, nb);
  return nb;
}
