// The Anthropic API key: VS Code SecretStorage first, then ANTHROPIC_API_KEY in
// the environment, then a workspace .env file.

import * as vscode from "vscode";
import { readFile } from "node:fs/promises";
import path from "node:path";

const SECRET = "polyglotTutor.anthropicApiKey";

export class ApiKeys {
  constructor(private secrets: vscode.SecretStorage) {}

  async get(): Promise<string | undefined> {
    return (await this.secrets.get(SECRET)) || process.env.ANTHROPIC_API_KEY || (await fromDotEnv());
  }

  async prompt(): Promise<boolean> {
    const key = await vscode.window.showInputBox({
      title: "Anthropic API key",
      prompt: "Stored in VS Code's secret storage. Get a key at console.anthropic.com.",
      password: true,
      ignoreFocusOut: true,
      placeHolder: "sk-ant-…",
      validateInput: (v) => (v.trim() && !/^sk-ant-/.test(v.trim()) ? "Anthropic keys start with sk-ant-" : undefined),
    });
    if (!key?.trim()) return false;
    await this.secrets.store(SECRET, key.trim());
    vscode.window.showInformationMessage("Polyglot Tutor: API key saved.");
    return true;
  }

  async clear() {
    await this.secrets.delete(SECRET);
    vscode.window.showInformationMessage("Polyglot Tutor: API key removed from secret storage.");
  }
}

/** ANTHROPIC_API_KEY from a .env file in any workspace folder. */
async function fromDotEnv(): Promise<string | undefined> {
  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    if (folder.uri.scheme !== "file") continue;
    try {
      const text = await readFile(path.join(folder.uri.fsPath, ".env"), "utf8");
      const m = /^\s*(?:export\s+)?ANTHROPIC_API_KEY\s*=\s*["']?([^"'\s#]+)/m.exec(text);
      if (m) return m[1];
    } catch {
      /* no .env here */
    }
  }
  return undefined;
}

export const MISSING_KEY_HELP = 'No Anthropic API key found. Run "Polyglot Tutor: Set Anthropic API Key" from the Command Palette.';
