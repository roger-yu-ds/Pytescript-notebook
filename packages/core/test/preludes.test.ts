import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { setupWarning } from "../src/jupyter.ts";
import { denoPrelude, pythonPrelude, sqlToPython } from "../src/preludes.ts";

test("SQL cells are base64-wrapped (UTF-8 safe) and honour -- as:", () => {
  const code = sqlToPython("-- as: totals\nselect 'café' as x");
  const b64 = /b64decode\("([^"]+)"\)/.exec(code)![1];
  assert.equal(Buffer.from(b64, "base64").toString("utf8"), "-- as: totals\nselect 'café' as x");
  assert.match(code, /, "totals"\)$/);
  assert.match(sqlToPython("select 1"), /, None\)$/);
});

test("preludes chdir into the notebook folder and embed the hub", () => {
  const opts = { hubUrl: "http://127.0.0.1:1/api/shared/ns", token: "tok", dataDir: "/d/.data/nb", cwd: "/d" };
  const py = pythonPrelude(opts);
  assert.match(py, /os\.chdir\("\/d"\)/);
  assert.match(py, /URL, TOKEN, DATA = "http:\/\/127\.0\.0\.1:1\/api\/shared\/ns", "tok", "\/d\/\.data\/nb"/);
  const ts = denoPrelude(opts);
  assert.match(ts, /Deno\.chdir\("\/d"\)/);
  assert.match(ts, /"x-polyglot-token": "tok"/);
});

test("the Python prelude changes folder before importing anything that can be missing", () => {
  const py = pythonPrelude({ hubUrl: "u", token: "t", dataDir: "/d/.data/nb", cwd: "/d" });
  assert.ok(py.indexOf("os.chdir(") < py.indexOf("import duckdb"), "os.chdir must come before the third-party imports");
});

// A missing package (here duckdb, forced) used to stop the prelude before os.chdir,
// so relative paths resolved from the kernel root instead of the notebook's folder.
const python = [path.resolve(import.meta.dirname, "../../../.venv", process.platform === "win32" ? "Scripts/python.exe" : "bin/python"), "python3", "python"].find(
  (p) => spawnSync(p, ["-c", "pass"]).status === 0,
);
test("with a package missing, the Python prelude still lands in the notebook's folder", { skip: !python && "no Python found" }, () => {
  const nbDir = mkdtempSync(path.join(tmpdir(), "pn-prelude-"));
  const prelude = pythonPrelude({ hubUrl: "u", token: "t", dataDir: path.join(nbDir, ".data"), cwd: nbDir });
  const code = `import os, sys\nsys.modules["duckdb"] = None\ntry:\n    exec(${JSON.stringify(prelude)})\nexcept ImportError as e:\n    print("ERR", type(e).__name__)\nprint("CWD", os.getcwd())`;
  const r = spawnSync(python!, ["-I", "-c", code], { cwd: tmpdir(), encoding: "utf8" });
  assert.match(r.stdout, /ERR ModuleNotFoundError/, r.stderr);
  assert.equal(realpathSync(/CWD (.+)/.exec(r.stdout)![1].trim()), realpathSync(nbDir));
});

test("a failed prelude explains itself, naming a missing package", () => {
  const w = setupWarning("python", "ModuleNotFoundError: No module named 'pyarrow'");
  assert.match(w, /couldn't finish setting up the python kernel: ModuleNotFoundError: No module named 'pyarrow'/);
  assert.match(w, /Install pyarrow into the Python environment/);
  assert.match(w, /jupyter_server, ipykernel, pandas, duckdb, pyarrow, deltalake/);
  assert.match(w, /SQL cells/);
  const other = setupWarning("typescript", "TypeError: boom");
  assert.match(other, /typescript kernel: TypeError: boom/);
  assert.match(other, /See the Polyglot Tutor log/);
  assert.doesNotMatch(other, /SQL cells/);
});
