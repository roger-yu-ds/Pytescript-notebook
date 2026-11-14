import assert from "node:assert/strict";
import { test } from "node:test";
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
