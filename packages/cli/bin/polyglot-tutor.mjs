#!/usr/bin/env node
// Runs the CLI from its TypeScript sources (core is published as .ts too).
import { register } from "tsx/esm/api";
register();
const { main } = await import("../src/main.ts");
process.exitCode = await main(process.argv.slice(2));
