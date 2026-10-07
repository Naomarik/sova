// Tests: trees, spools and refusals for links-transfer.test.ts and links-transfer.integration.test.ts.
// packInProcess writes the spool the sender's tar would for a listing (one ustar archive per offered
// root, concatenated, through zstd), with no tar, so pulls and pre-scans run in-process.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createReadStream, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createZstdDecompress, zstdCompressSync } from "node:zlib";
import { type OfferListing, spoolFile, TransferError } from "./links-transfer";
import { tarMembers } from "./tar-list";

/** A tree from a spec: a string or bytes is a file's content, `{link}` a symlink, an object a directory. */
export type Spec = { [name: string]: string | Buffer | { link: string } | Spec };
export function makeTree(dir: string, spec: Spec): void {
  mkdirSync(dir, { recursive: true });
  for (const [name, v] of Object.entries(spec)) {
    const p = join(dir, name);
    if (typeof v === "string" || Buffer.isBuffer(v)) writeFileSync(p, v);
    else if ("link" in v && typeof v.link === "string") symlinkSync(v.link, p);
    else makeTree(p, v as Spec);
  }
}

/** Every path under `dir` with its kind and content (file text, link target), sorted. */
export function snapshotTree(dir: string, base = ""): string[] {
  const out: string[] = [];
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    const rel = base ? `${base}/${n}` : n;
    const st = lstatSync(p);
    if (st.isSymbolicLink()) out.push(`${rel} -> ${readlinkSync(p)}`);
    else if (st.isDirectory()) out.push(`${rel}/`, ...snapshotTree(p, rel));
    else out.push(`${rel} = ${readFileSync(p, "utf8")}`);
  }
  return out.sort();
}

export async function spoolMembers(file: string): Promise<string[]> {
  const out: string[] = [];
  for await (const m of tarMembers(createReadStream(file).pipe(createZstdDecompress()))) out.push(m.name.replace(/\/$/, ""));
  return out;
}

export async function refusal(p: Promise<unknown> | (() => unknown)): Promise<TransferError> {
  try {
    await (typeof p === "function" ? p() : p);
  } catch (err) {
    if (err instanceof TransferError) return err;
    throw err;
  }
  assert.fail("expected a TransferError");
}

// ---- a spool without tar ---------------------------------------------------------------------------

const octal = (n: number, width: number) => `${n.toString(8).padStart(width - 1, "0")}\0`;

/** One ustar header: names up to 100 bytes (these tests' are short). */
function header(name: string, type: "0" | "2" | "5", size: number, mode: number, linkname = ""): Buffer {
  assert.ok(Buffer.byteLength(name) <= 100 && Buffer.byteLength(linkname) <= 100, `${name}: too long for this writer`);
  const h = Buffer.alloc(512);
  h.write(name, 0);
  h.write(octal(mode, 8), 100);
  h.write(octal(0, 8), 108);
  h.write(octal(0, 8), 116);
  h.write(octal(size, 12), 124);
  h.write(octal(0, 12), 136);
  h.write("        ", 148); // the checksum counts its own field as spaces
  h.write(type, 156);
  h.write(linkname, 157);
  h.write("ustar\0", 257);
  h.write("00", 263);
  let sum = 0;
  for (const b of h) sum += b;
  h.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148);
  return h;
}

/** A tar of `members` (paths under `parent`, directories first), as `tar -C parent -T -` writes it. */
function tarOf(parent: string, members: readonly string[]): Buffer {
  const parts: Buffer[] = [];
  for (const m of members) {
    const p = join(parent, m);
    const st = lstatSync(p);
    if (st.isSymbolicLink()) parts.push(header(m, "2", 0, 0o777, readlinkSync(p)));
    else if (st.isDirectory()) parts.push(header(`${m}/`, "5", 0, st.mode & 0o7777));
    else {
      const data = readFileSync(p);
      parts.push(header(m, "0", data.length, st.mode & 0o7777), data, Buffer.alloc((512 - (data.length % 512)) % 512));
    }
  }
  parts.push(Buffer.alloc(1024));
  return Buffer.concat(parts);
}

/** The listing's spool at `root` for `offerId`, packed in-process; its snapshot. */
export function packInProcess(root: string, offerId: string, listing: OfferListing): { sha256: string; size: number } {
  const bytes = zstdCompressSync(Buffer.concat(listing.packList.map((r) => tarOf(r.parent, r.members))));
  const file = spoolFile(root, offerId);
  mkdirSync(join(file, ".."), { recursive: true, mode: 0o700 });
  writeFileSync(file, bytes, { mode: 0o600 });
  return { sha256: createHash("sha256").update(bytes).digest("hex"), size: bytes.length };
}
