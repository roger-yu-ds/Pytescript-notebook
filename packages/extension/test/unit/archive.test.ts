import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { extractExecutables, parseChecksum, readArchive, sha256 } from "../../src/archive.ts";
import { denoAsset, targetTriple, uvAsset } from "../../src/installers.ts";

const dir = mkdtempSync(path.join(tmpdir(), "archive-test-"));
after(() => rmSync(dir, { recursive: true, force: true }));

const python = process.platform === "win32" ? "python" : "python3";
const make = (script: string) => execFileSync(python, ["-c", script], { cwd: dir });

test("reads .tar.gz (incl. long names) and .zip (stored + deflated)", () => {
  make(`
import tarfile, zipfile, io
long = "d/" + "x" * 120 + "/uv"
with tarfile.open("a.tar.gz", "w:gz", format=tarfile.GNU_FORMAT) as t:
    for name, data in [("uv-x/uv", b"UV-BINARY"), (long, b"LONG")]:
        info = tarfile.TarInfo(name); info.size = len(data); t.addfile(info, io.BytesIO(data))
with zipfile.ZipFile("b.zip", "w") as z:
    z.writestr(zipfile.ZipInfo("deno"), b"DENO" * 1000, compress_type=zipfile.ZIP_DEFLATED)
    z.writestr("dir/", b"")
    z.writestr(zipfile.ZipInfo("plain.txt"), b"stored", compress_type=zipfile.ZIP_STORED)
`);
  const tar = readArchive("a.tar.gz", readFileSync(path.join(dir, "a.tar.gz")));
  assert.deepEqual(tar.map((e) => [e.name, Buffer.from(e.data).toString()]), [["uv-x/uv", "UV-BINARY"], [`d/${"x".repeat(120)}/uv`, "LONG"]]);
  const zip = readArchive("b.zip", readFileSync(path.join(dir, "b.zip")));
  assert.deepEqual(zip.map((e) => [e.name, e.data.length]), [["deno", 4000], ["plain.txt", 6]]);

  const [file] = extractExecutables(tar, ["uv"], path.join(dir, "out"));
  assert.equal(readFileSync(file, "utf8"), "UV-BINARY");
  if (process.platform !== "win32") assert.equal(statSync(file).mode & 0o111, 0o111);
  assert.throws(() => extractExecutables(zip, ["nope"], dir), /nope not found/);
});

test("checksum files of both formats parse; sha256 matches", () => {
  const hash = sha256(new TextEncoder().encode("abc"));
  assert.equal(hash, "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  assert.equal(parseChecksum(`${hash}  deno.zip\n`), hash);
  assert.equal(parseChecksum(`${hash.toUpperCase()} *uv.tar.gz`), hash);
  assert.equal(parseChecksum("nothing"), undefined);
});

test("release assets per platform", () => {
  assert.equal(targetTriple("linux", "x64"), "x86_64-unknown-linux-gnu");
  assert.equal(targetTriple("darwin", "arm64"), "aarch64-apple-darwin");
  assert.equal(targetTriple("freebsd", "x64"), null);
  assert.match(uvAsset("win32", "x64")!.url, /uv-x86_64-pc-windows-msvc\.zip$/);
  assert.deepEqual(uvAsset("win32", "x64")!.executables, ["uv.exe"]);
  assert.match(uvAsset("linux", "arm64")!.checksumUrl, /uv-aarch64-unknown-linux-gnu\.tar\.gz\.sha256$/);
  assert.match(denoAsset("darwin", "x64")!.url, /deno-x86_64-apple-darwin\.zip$/);
  assert.match(denoAsset("linux", "x64")!.checksumUrl, /\.zip\.sha256sum$/);
  assert.equal(denoAsset("win32", "arm64"), null);
  assert.equal(uvAsset("linux", "ia32"), null);
});

test("pinned Python packages match the repo's requirements.txt", async () => {
  const { PYTHON_PACKAGES } = await import("../../src/installers.ts");
  const req = readFileSync(path.join(import.meta.dirname, "../../../../requirements.txt"), "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"));
  assert.deepEqual([...PYTHON_PACKAGES].sort(), req.sort());
});
