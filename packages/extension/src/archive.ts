// Downloading and unpacking the release archives that "Set Up Runtimes" uses
// (uv: .tar.gz / .zip, Deno: .zip). No dependencies: zlib + small tar/zip readers.

import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { gunzipSync, inflateRawSync } from "node:zlib";

export interface ArchiveEntry {
  name: string; // path inside the archive, "/"-separated
  data: Uint8Array;
}

const text = (b: Uint8Array, start: number, len: number) => {
  const slice = b.subarray(start, start + len);
  const end = slice.indexOf(0);
  return new TextDecoder().decode(end >= 0 ? slice.subarray(0, end) : slice);
};

/** Regular files in a .tar.gz. */
export function readTarGz(archive: Uint8Array): ArchiveEntry[] {
  const tar = gunzipSync(archive);
  const out: ArchiveEntry[] = [];
  let longName: string | null = null;
  for (let off = 0; off + 512 <= tar.length; ) {
    const header = tar.subarray(off, off + 512);
    if (header.every((b) => b === 0)) break;
    const size = parseInt(text(header, 124, 12).trim() || "0", 8);
    const type = String.fromCharCode(header[156] || 48);
    const prefix = text(header, 345, 155);
    const name = longName ?? (prefix ? `${prefix}/${text(header, 0, 100)}` : text(header, 0, 100));
    longName = null;
    const data = tar.subarray(off + 512, off + 512 + size);
    if (type === "L") longName = text(data, 0, data.length); // GNU long name for the next entry
    else if (type === "0" || type === "\0" || type === "7") out.push({ name, data: new Uint8Array(data) });
    off += 512 + Math.ceil(size / 512) * 512;
  }
  return out;
}

/** Files in a .zip (stored or deflated). */
export function readZip(zip: Uint8Array): ArchiveEntry[] {
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  let eocd = -1;
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 22 - 0xffff); i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("not a zip file");
  const count = view.getUint16(eocd + 10, true);
  let off = view.getUint32(eocd + 16, true);
  const out: ArchiveEntry[] = [];
  for (let n = 0; n < count; n++) {
    if (view.getUint32(off, true) !== 0x02014b50) throw new Error("corrupt zip central directory");
    const method = view.getUint16(off + 10, true);
    const compressed = view.getUint32(off + 20, true);
    const nameLen = view.getUint16(off + 28, true);
    const extraLen = view.getUint16(off + 30, true);
    const commentLen = view.getUint16(off + 32, true);
    const local = view.getUint32(off + 42, true);
    const name = new TextDecoder().decode(zip.subarray(off + 46, off + 46 + nameLen));
    off += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith("/")) continue;
    const dataStart = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
    const raw = zip.subarray(dataStart, dataStart + compressed);
    if (method === 0) out.push({ name, data: new Uint8Array(raw) });
    else if (method === 8) out.push({ name, data: new Uint8Array(inflateRawSync(raw)) });
    else throw new Error(`unsupported zip compression method ${method} for ${name}`);
  }
  return out;
}

export const readArchive = (file: string, data: Uint8Array) => (file.endsWith(".zip") ? readZip(data) : readTarGz(data));

export const sha256 = (data: Uint8Array) => createHash("sha256").update(data).digest("hex");

/** The hex digest from a checksum file ("<hash>  <name>"). */
export const parseChecksum = (body: string) => /\b([a-f0-9]{64})\b/i.exec(body)?.[1]?.toLowerCase();

/** Download a release asset and check it against its published SHA-256. */
export async function downloadVerified(url: string, checksumUrl: string, signal?: AbortSignal): Promise<Uint8Array> {
  const [res, sum] = await Promise.all([fetch(url, { signal }), fetch(checksumUrl, { signal })]);
  if (!res.ok) throw new Error(`download failed (${res.status}): ${url}`);
  if (!sum.ok) throw new Error(`checksum download failed (${sum.status}): ${checksumUrl}`);
  const data = new Uint8Array(await res.arrayBuffer());
  const want = parseChecksum(await sum.text());
  const got = sha256(data);
  if (!want || want !== got) throw new Error(`checksum mismatch for ${url} (expected ${want}, got ${got})`);
  return data;
}

/** Write chosen files (matched by basename) into `dir`, executable. Returns the written paths. */
export function extractExecutables(entries: ArchiveEntry[], names: string[], dir: string): string[] {
  mkdirSync(dir, { recursive: true });
  const written: string[] = [];
  for (const want of names) {
    const entry = entries.find((e) => e.name.split("/").pop() === want);
    if (!entry) throw new Error(`${want} not found in the archive`);
    const file = path.join(dir, want);
    writeFileSync(file, entry.data);
    if (process.platform !== "win32") chmodSync(file, 0o755);
    written.push(file);
  }
  return written;
}
