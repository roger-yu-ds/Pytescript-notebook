// Monaco's worker-side modules ship without declarations.

declare module "monaco-editor/internal/common/initialize" {
  export function initialize(create: (ctx: unknown, createData: unknown) => unknown): void;
}

declare module "monaco-editor/languages/features/typescript/tsWorker" {
  export const TypeScriptWorker: new (ctx: unknown, createData: unknown) => any;
}

declare module "monaco-editor/languages/features/typescript/lib/typescriptServices" {
  export const typescript: typeof import("typescript-6");
}
