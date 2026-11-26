// A deterministic tar writer for a transport's package (§app.transport/package): entries in the
// order given (callers sort them), owner 0:0 with no names, each file's own mode and whole-second
// mtime, symlinks as links. The same files give the same bytes. A name that ustar can't hold (over
// 100 bytes, or not ASCII) gets a pax header of its own. Read by any tar (GNU tar, bsdtar).
import { createReadStream, type Stats } from "node:fs";
import { lstat, open, readlink, type FileHandle } from "node:fs/promises";
import { join } from "node:path";

export type TarEntry =
  | { name: string; type: "dir"; mode: number; mtime: number }
  | { name: string; type: "symlink"; target: string; mode: number; mtime: number }
  | { name: string; type: "file"; mode: number; mtime: number; size: number; from: string }
  /** Bytes made here (a manifest): written as a file. */
  | { name: string; type: "data"; mode: number; mtime: number; data: Buffer };

const BLOCK = 512;
const zero = Buffer.alloc(BLOCK);

function octal(n: number, width: number): string {
  return `${Math.max(0, Math.floor(n)).toString(8).padStart(width - 1, "0")}\0`;
}

function header(o: { name: string; mode: number; size: number; mtime: number; flag: string; linkname?: string }): Buffer {
  const b = Buffer.alloc(BLOCK);
  b.write(o.name, 0, 100, "utf8");
  b.write(octal(o.mode & 0o7777, 8), 100, 8, "ascii");
  b.write(octal(0, 8), 108, 8, "ascii");
  b.write(octal(0, 8), 116, 8, "ascii");
  b.write(octal(o.size, 12), 124, 12, "ascii");
  b.write(octal(o.mtime, 12), 136, 12, "ascii");
  b.write("        ", 148, 8, "ascii");
  b.write(o.flag, 156, 1, "ascii");
  if (o.linkname) b.write(o.linkname, 157, 100, "utf8");
  b.write("ustar\0", 257, 6, "ascii");
  b.write("00", 263, 2, "ascii");
  let sum = 0;
  for (const byte of b) sum += byte;
  b.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
  return b;
}

/** A pax record "<len> key=value\n", its length counting itself. */
function paxRecord(key: string, value: string): string {
  const body = ` ${key}=${value}\n`;
  let len = Buffer.byteLength(body) + 1;
  while (String(len).length + Buffer.byteLength(body) !== len) len = String(len).length + Buffer.byteLength(body);
  return `${len}${body}`;
}

const fits = (s: string) => Buffer.byteLength(s) <= 100 && /^[\x20-\x7e]*$/.test(s);
const pad = (n: number) => (n % BLOCK ? BLOCK - (n % BLOCK) : 0);

/** The bytes of `entries` as one tar, in order, a file's body read as it streams (never whole). Each file
    is read as it is now: one that changed size meanwhile is refused (the caller stops what writes it first). */
export async function* tarChunks(entries: readonly TarEntry[]): AsyncGenerator<Buffer> {
  for (const e of entries) {
    const name = e.type === "dir" && !e.name.endsWith("/") ? `${e.name}/` : e.name;
    const link = e.type === "symlink" ? e.target : undefined;
    const recs: string[] = [];
    if (!fits(name)) recs.push(paxRecord("path", name));
    if (link !== undefined && !fits(link)) recs.push(paxRecord("linkpath", link));
    if (recs.length) {
      const body = Buffer.from(recs.join(""), "utf8");
      yield header({ name: "PaxHeader", mode: 0o644, size: body.length, mtime: e.mtime, flag: "x" });
      yield body;
      if (pad(body.length)) yield zero.subarray(0, pad(body.length));
    }
    const short = fits(name) ? name : asciiStub(name);
    const shortLink = link === undefined ? undefined : fits(link) ? link : asciiStub(link);
    if (e.type === "dir") yield header({ name: short, mode: e.mode, size: 0, mtime: e.mtime, flag: "5" });
    else if (e.type === "symlink") yield header({ name: short, mode: e.mode, size: 0, mtime: e.mtime, flag: "2", linkname: shortLink! });
    else if (e.type === "data") {
      yield header({ name: short, mode: e.mode, size: e.data.length, mtime: e.mtime, flag: "0" });
      if (e.data.length) yield e.data;
      if (pad(e.data.length)) yield zero.subarray(0, pad(e.data.length));
    } else {
      yield header({ name: short, mode: e.mode, size: e.size, mtime: e.mtime, flag: "0" });
      let got = 0;
      if (e.size > 0)
        for await (const chunk of createReadStream(e.from, { start: 0, end: e.size - 1 })) {
          got += (chunk as Buffer).length;
          yield chunk as Buffer;
        }
      // A file grown since its lstat reads only its first `size` bytes: shrunk is the one change caught here.
      if (got !== e.size) throw new Error(`${e.from} changed while it was packed (${got} of ${e.size} bytes)`);
      if (pad(e.size)) yield zero.subarray(0, pad(e.size));
    }
  }
  yield zero;
  yield zero;
}

/** Write `entries` as one tar at `file` (tarChunks), streamed. */
export async function writeTar(file: string, entries: readonly TarEntry[]): Promise<{ size: number }> {
  const fh = await open(file, "w", 0o600);
  let size = 0;
  try {
    for await (const b of tarChunks(entries)) {
      await fh.write(b);
      size += b.length;
    }
    return { size };
  } finally {
    await (fh as FileHandle).close();
  }
}

/** A stand-in ustar name for a reader that ignores pax (the pax path is the real one). */
function asciiStub(s: string): string {
  return s.replace(/[^\x20-\x7e]/g, "_").slice(-100);
}

/** One file, folder or link under `root` as a tar entry named `name`, from lstat; null for what a tar
    of a package never holds (a socket, a device, a fifo). */
export async function entryOf(root: string, rel: string, name = rel, st?: Stats): Promise<TarEntry | null> {
  const abs = join(root, rel);
  const s = st ?? (await lstat(abs));
  const mtime = Math.floor(s.mtimeMs / 1000);
  if (s.isSymbolicLink()) return { name, type: "symlink", target: await readlink(abs), mode: 0o777, mtime };
  if (s.isDirectory()) return { name, type: "dir", mode: s.mode & 0o7777, mtime };
  if (s.isFile()) return { name, type: "file", mode: s.mode & 0o7777, mtime, size: s.size, from: abs };
  return null;
}

// ---- reading a package's tar back (the destination's check before it extracts) -------------------

export interface TarMemberHead {
  name: string;
  /** "0" file, "5" folder, "2" symlink; anything else is refused by checkMembers. */
  flag: string;
  mode: number;
  size: number;
  linkname: string;
}

const field = (b: Buffer, at: number, len: number): string => {
  const s = b.subarray(at, at + len);
  const z = s.indexOf(0);
  return (z >= 0 ? s.subarray(0, z) : s).toString("utf8");
};
const num = (b: Buffer, at: number, len: number): number => parseInt(field(b, at, len).trim() || "0", 8);

/** The longest pax header read: this writer's hold a path and a link target, each far shorter. */
const PAX_MAX = 64 * 1024;

/**
 * The members of a tar this writer made (ustar with pax path records), one header at a time: only a
 * header block and a pax header are ever held, never a member's body. What this writer never makes is
 * refused, so the check and the extractor can't read a name two ways: a ustar prefix (an extractor
 * joins it to the name), another format's magic, a pax key but path and linkpath, an oversized pax header.
 */
class TarHeads {
  readonly members: TarMemberHead[] = [];
  done = false;
  private pax: Record<string, string> = {};
  /** A header block; answers how many bytes follow it (its body and padding), and whether they're a pax body to hand to `paxBody`. */
  head(h: Buffer): { follow: number; pax: boolean } {
    if (h.every((x) => x === 0)) {
      this.done = true;
      return { follow: 0, pax: false };
    }
    const size = num(h, 124, 12);
    const flag = String.fromCharCode(h[156] || 0x30);
    if (h.toString("latin1", 257, 263) !== "ustar\0") throw new Error("a header that isn't ustar");
    if (h[345] !== 0) throw new Error("a header with a name prefix");
    if (flag === "x") {
      if (size > PAX_MAX) throw new Error("a pax header too long");
      return { follow: size + pad(size), pax: true };
    }
    this.members.push({ name: this.pax.path ?? field(h, 0, 100), flag, mode: num(h, 100, 8), size, linkname: this.pax.linkpath ?? field(h, 157, 100) });
    this.pax = {};
    return { follow: size + pad(size), pax: false };
  }
  /** A pax header's body (its padding may follow; a short one, at a truncated end, is read as it is). */
  paxBody(body: Buffer, size: number): void {
    this.pax = {};
    for (const rec of body.subarray(0, size).toString("utf8").split("\n")) {
      if (!rec) continue;
      const m = /^\d+ ([^=]+)=(.*)$/.exec(rec);
      if (!m || (m[1] !== "path" && m[1] !== "linkpath")) throw new Error(`a pax record ${JSON.stringify(rec.slice(0, 40))}`);
      this.pax[m[1]!] = m[2]!;
    }
  }
}

/** The members of a tar file this writer made, without extracting anything: headers read through a file
    handle, every body skipped by its size (a member far larger than memory costs nothing). */
export async function listTar(file: string): Promise<TarMemberHead[]> {
  const fh = await open(file, "r");
  try {
    const len = (await fh.stat()).size;
    const r = new TarHeads();
    const h = Buffer.alloc(BLOCK);
    let at = 0;
    while (!r.done && at + BLOCK <= len) {
      await readFully(fh, h, at);
      const { follow, pax } = r.head(h);
      if (pax) {
        const size = num(h, 124, 12);
        const body = Buffer.alloc(Math.min(size, Math.max(0, len - at - BLOCK)));
        await readFully(fh, body, at + BLOCK);
        r.paxBody(body, size);
      }
      at += BLOCK + follow;
    }
    return r.members;
  } finally {
    await fh.close();
  }
}

async function readFully(fh: FileHandle, buf: Buffer, position: number): Promise<void> {
  let got = 0;
  while (got < buf.length) {
    const { bytesRead } = await fh.read(buf, got, buf.length - got, position + got);
    if (!bytesRead) throw new Error("a tar that ends inside a header");
    got += bytesRead;
  }
}

/**
 * The members of a tar arriving as a stream of chunks (a zstd archive read back, say), with the same
 * refusals as listTar: a header or a pax header is gathered, a body is counted past, so memory stays
 * at one chunk whatever the archive holds. `onChunk` sees every byte (to hash what was read back).
 */
export async function listTarStream(chunks: AsyncIterable<Buffer | Uint8Array> | Iterable<Buffer | Uint8Array>, onChunk?: (b: Buffer) => void): Promise<TarMemberHead[]> {
  const r = new TarHeads();
  let skip = 0;
  /** Bytes being gathered: a header (BLOCK) or a pax body with its padding. */
  let need = BLOCK;
  let paxSize = -1;
  let held: Buffer[] = [];
  let heldLen = 0;
  for await (const c of chunks) {
    const chunk = Buffer.isBuffer(c) ? c : Buffer.from(c.buffer, c.byteOffset, c.byteLength);
    onChunk?.(chunk);
    let off = 0;
    while (off < chunk.length && !r.done) {
      if (skip) {
        const n = Math.min(skip, chunk.length - off);
        skip -= n;
        off += n;
        continue;
      }
      const n = Math.min(need - heldLen, chunk.length - off);
      held.push(chunk.subarray(off, off + n));
      heldLen += n;
      off += n;
      if (heldLen < need) break;
      const buf = held.length === 1 ? Buffer.from(held[0]!) : Buffer.concat(held, heldLen);
      held = [];
      heldLen = 0;
      if (paxSize >= 0) {
        r.paxBody(buf, paxSize);
        paxSize = -1;
        need = BLOCK;
        continue;
      }
      const { follow, pax } = r.head(buf);
      if (pax && follow) {
        paxSize = num(buf, 124, 12);
        need = follow;
      } else {
        if (pax) r.paxBody(Buffer.alloc(0), 0);
        skip = follow;
      }
    }
  }
  // Bytes after the end blocks were still read (and seen by onChunk), so a hash covers the whole stream.
  return r.members;
}

/**
 * Why a member list may not be extracted into a folder, or null: an absolute name or a `..`, a type
 * other than file, folder or link, setuid, setgid or sticky bits, or a member under a link (one the
 * archive makes, or one `isLinkThere` says the folder already has).
 */
export function checkMembers(members: readonly Pick<TarMemberHead, "name" | "flag" | "mode">[], isLinkThere: (rel: string) => boolean = () => false): string | null {
  const links = new Set<string>();
  for (const m of members) {
    const name = m.name.replace(/\/+$/, "");
    if (!name || name.startsWith("/") || name.includes("\0") || name.split("/").some((s) => s === ".." || s === "")) return `the package names ${JSON.stringify(m.name)}`;
    if (!["0", "5", "2"].includes(m.flag)) return `the package holds ${JSON.stringify(m.name)} of a kind Sova never sends`;
    if (m.mode & 0o7000) return `the package gives ${JSON.stringify(m.name)} special permission bits`;
    const parts = name.split("/");
    for (let i = 1; i < parts.length; i++) {
      const dir = parts.slice(0, i).join("/");
      if (links.has(dir) || isLinkThere(dir)) return `the package writes ${JSON.stringify(m.name)} through a link`;
    }
    if (m.flag === "2") links.add(name);
  }
  return null;
}
