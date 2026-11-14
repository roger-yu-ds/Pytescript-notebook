// Reads the polyglotTutor.* settings.

import * as vscode from "vscode";
import { DEFAULT_SETTINGS, type CacheTtl, type Effort, type Settings } from "@polyglot-tutor/core/browser";

export const SECTION = "polyglotTutor";

const cfg = () => vscode.workspace.getConfiguration(SECTION);

/** Tutor settings in the shape core expects. */
export function tutorSettings(): Settings {
  const c = cfg();
  const d = DEFAULT_SETTINGS;
  return {
    model: c.get<string>("model", d.model),
    effort: c.get<Effort>("effort", d.effort),
    learnerProfile: c.get<string>("learnerProfile", d.learnerProfile),
    showThinking: c.get<boolean>("showReasoning", d.showThinking),
    cacheTtl: c.get<CacheTtl>("cacheLifetime", d.cacheTtl),
    summaryModel: c.get<string>("summaryModel", d.summaryModel),
    context: {
      recentCells: c.get<number>("context.recentCells", d.context.recentCells),
      blockSize: c.get<number>("context.blockSize", d.context.blockSize),
      tokenBudget: c.get<number>("context.tokenBudget", d.context.tokenBudget),
      outputLimit: c.get<number>("context.outputLimit", d.context.outputLimit),
    },
  };
}

/** Explicit runtime paths from settings ("" = not set). */
export function runtimeSettings() {
  const c = cfg();
  return { python: c.get<string>("pythonPath", "").trim(), deno: c.get<string>("denoPath", "").trim() };
}

export const affectsTutor = (e: vscode.ConfigurationChangeEvent) => e.affectsConfiguration(SECTION);
export const affectsRuntimes = (e: vscode.ConfigurationChangeEvent) =>
  e.affectsConfiguration(`${SECTION}.pythonPath`) || e.affectsConfiguration(`${SECTION}.denoPath`);

export async function setModel(model: string) {
  await cfg().update("model", model, vscode.ConfigurationTarget.Global);
}
