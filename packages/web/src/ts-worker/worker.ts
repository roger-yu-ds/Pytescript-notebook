// Entry point of the web app's TypeScript worker (loaded by monaco.ts through
// Vite's `?worker`). It is Monaco's own ts.worker with our subclass. Monaco's
// `customWorkerPath` option can't be used: it relies on importScripts(), which
// module workers (what Vite creates) don't have.

import { initialize } from "monaco-editor/internal/common/initialize";
import { TypeScriptWorker } from "monaco-editor/languages/features/typescript/tsWorker";
import { typescript } from "monaco-editor/languages/features/typescript/lib/typescriptServices";
import { polyglotWorker } from "./custom.ts";

const PolyglotWorker = polyglotWorker(TypeScriptWorker, typescript);

self.onmessage = () => {
  initialize((ctx, createData) => new PolyglotWorker(ctx, createData));
};
