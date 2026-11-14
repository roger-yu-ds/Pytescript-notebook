import assert from "node:assert/strict";
import { lstatSync, mkdirSync, mkdtempSync, readlinkSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { denoConfigDir, kernelPathFor, linkNotebookDir } from "../src/session.ts";

const tmp = realpathSync(mkdtempSync(path.join(os.tmpdir(), "polyglot-session-")));
after(() => rmSync(tmp, { recursive: true, force: true }));

test("denoConfigDir finds the nearest deno.json or deno.jsonc at or above the folder, else the folder itself", () => {
  const root = path.join(tmp, "a");
  const nested = path.join(root, "notebooks", "deep");
  mkdirSync(nested, { recursive: true });
  assert.equal(denoConfigDir(nested), nested, "no config anywhere: the folder itself");

  writeFileSync(path.join(root, "deno.json"), "{}");
  assert.equal(denoConfigDir(nested), root);
  assert.equal(denoConfigDir(root), root);

  writeFileSync(path.join(root, "notebooks", "deno.jsonc"), "{}");
  assert.equal(denoConfigDir(nested), path.join(root, "notebooks"), "the nearest one wins");
});

test("linkNotebookDir links the kernels' start folder (the config's folder) and returns the path inside the Jupyter root", () => {
  const root = path.join(tmp, "b");
  const nbDir = path.join(root, "notebooks");
  mkdirSync(nbDir, { recursive: true });
  writeFileSync(path.join(root, "deno.json"), "{}");
  const state = path.join(tmp, "state");
  const kernelPath = linkNotebookDir(state, "s1", nbDir, () => {});
  assert.equal(kernelPath, kernelPathFor("s1"));
  const link = path.join(state, "nb", "s1");
  assert.ok(lstatSync(link).isSymbolicLink());
  assert.equal(path.resolve(readlinkSync(link)), root, "the link points at the folder with deno.json");

  const plain = path.join(tmp, "c");
  mkdirSync(plain);
  linkNotebookDir(state, "s2", plain, () => {});
  assert.equal(path.resolve(readlinkSync(path.join(state, "nb", "s2"))), plain, "without a config: the notebook's folder");
});
