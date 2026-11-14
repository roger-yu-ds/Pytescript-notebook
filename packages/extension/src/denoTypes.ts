// Deno's type declarations for TypeScript cells: generated once per Deno
// version (`deno types`) and cached in extension storage. Also written, with
// the share()/get() helpers, to a file the tsserver plugin adds to notebook
// projects for completions and hover, along with each notebook's modules.d.ts
// (the types of what its cells import, written by the checker).

import * as vscode from "vscode";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { checkDeno, denoTypes } from "@polyglot-tutor/core";
import { HELPER_TYPES_SOURCE } from "@polyglot-tutor/core/browser";

export const PLUGIN_NAME = "polyglot-tutor-ts-plugin";

export async function loadDenoTypes(deno: string, cacheDir: string): Promise<string | undefined> {
  const version = await checkDeno(deno);
  if (!version) return undefined;
  const file = path.join(cacheDir, `deno-${version}.d.ts`);
  if (existsSync(file)) return readFileSync(file, "utf8");
  const text = await denoTypes(deno);
  mkdirSync(cacheDir, { recursive: true });
  writeFileSync(file, text);
  return text;
}

/** What the tsserver plugin is told (see ts-plugin/index.ts), pushed whenever it changes. */
export class TsPluginConfig {
  private typesFile: string | undefined;
  private notebooks = new Map<string, string>();

  constructor(private log: vscode.LogOutputChannel) {}

  /** Write the globals file (helpers + Deno's types) and point the plugin at it. */
  setGlobals(typesDir: string, denoSource: string | undefined) {
    const file = path.join(typesDir, "polyglot-tutor-globals.d.ts");
    mkdirSync(typesDir, { recursive: true });
    writeFileSync(file, `${HELPER_TYPES_SOURCE}\n${denoSource ?? ""}`);
    this.typesFile = file;
    return this.push();
  }

  /** A notebook's modules.d.ts (key: see ts-plugin/notebook-key.ts). */
  setNotebook(key: string, modulesFile: string) {
    if (this.notebooks.get(key) === modulesFile) return;
    this.notebooks.set(key, modulesFile);
    void this.push();
  }

  removeNotebook(key: string) {
    if (this.notebooks.delete(key)) void this.push();
  }

  private async push() {
    try {
      const ext = vscode.extensions.getExtension("vscode.typescript-language-features");
      if (!ext) return;
      const api = (await ext.activate())?.getAPI?.(0);
      api?.configurePlugin?.(PLUGIN_NAME, { typesFile: this.typesFile, notebooks: Object.fromEntries(this.notebooks) });
    } catch (e) {
      this.log.warn(`could not configure the TypeScript plugin: ${e}`);
    }
  }
}
