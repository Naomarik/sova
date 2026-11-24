/**
 * A minimal tar (POSIX ustar, with a pax header for a long name) over Node's zlib, for archive
 * compression (§app.session-list/archive-compression): one compressed file per chat home, written
 * and read back by Sova alone, on every host (no `tar` program needed). Regular files and folders
 * only; a symlink or anything else in a home is refused, never followed.
 */
import { createHash } from "node:crypto";
import { closeSync, fsyncSync, lstatSync, openSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { createGunzip, createGzip, constants as zc } from "node:zlib";
import { createReadStream, createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";

const BLOCK = 512;

export interface TarEntry {
  /** Relative, "/"-separated; a folder ends in "/". */
  name: string;
  mode: number;
  mtimeMs: number;
  /** Folders: 0. */
  size: number;
  /** Files only: hex sha256 of the content. */
  sha256?: string;
}

/** Every file and folder under `root`, sorted, as tar entries (no content read). Throws on a symlink or a special file. */
export function walk(root: string): { entries: TarEntry[]; paths: string[] } {
  const entries: TarEntry[] = [];
  const paths: string[] = [];
  const visit = (dir: string): void => {
    for (const name of readdirSync(dir).sort()) {
      const p = join(dir, name);
      const st = lstatSync(p);
      const rel = relative(root, p).split(sep).join("/");
      if (st.isDirectory()) {
        entries.push({ name: `${rel}/`, mode: st.mode & 0o7777, mtimeMs: st.mtimeMs, size: 0 });
        paths.push(p);
        visit(p);
      } else if (st.isFile()) {
        entries.push({ name: rel, mode: st.mode & 0o7777, mtimeMs: st.mtimeMs, size: st.size });
        paths.push(p);
      } else throw new Error(`${rel} is not a regular file or folder`);
    }
  };
  visit(root);
  return { entries, paths };
}

function octal(n: number, width: number): string {
  return `${Math.floor(n).toString(8).padStart(width - 1, "0")}\0`;
}

function header(name: string, mode: number, size: number, mtimeMs: number, type: string): Buffer {
  const b = Buffer.alloc(BLOCK);
  b.write(name.slice(0, 100), 0, "utf8");
  b.write(octal(mode, 8), 100);
  b.write(octal(0, 8), 108);
  b.write(octal(0, 8), 116);
  b.write(octal(size, 12), 124);
  b.write(octal(mtimeMs / 1000, 12), 136);
  b.write("        ", 148);
  b.write(type, 156);
  b.write("ustar\0", 257);
  b.write("00", 263);
  let sum = 0;
  for (const x of b) sum += x;
  b.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148);
  return b;
}

function pad(size: number): Buffer {
  const r = size % BLOCK;
  return Buffer.alloc(r === 0 ? 0 : BLOCK - r);
}

/** A pax record "<len> path=<name>\n", its length counting itself. */
function paxRecord(key: string, value: string): string {
  const body = ` ${key}=${value}\n`;
  const n = Buffer.byteLength(body);
  let len = n + String(n).length;
  while (n + String(len).length !== len) len = n + String(len).length;
  return `${len}${body}`;
}

function* blocks(root: string, entries: TarEntry[], hashes: Map<string, string>): Generator<Buffer> {
  for (const e of entries) {
    if (Buffer.byteLength(e.name) > 100) {
      const pax = Buffer.from(paxRecord("path", e.name));
      yield header("././@PaxHeader", 0o644, pax.length, e.mtimeMs, "x");
      yield pax;
      yield pad(pax.length);
    }
    const dir = e.name.endsWith("/");
    yield header(e.name, e.mode, dir ? 0 : e.size, e.mtimeMs, dir ? "5" : "0");
    if (dir) continue;
    const data = readFileSync(join(root, e.name));
    if (data.length !== e.size) throw new Error(`${e.name} changed while it was compressed`);
    hashes.set(e.name, createHash("sha256").update(data).digest("hex"));
    yield data;
    yield pad(data.length);
  }
  yield Buffer.alloc(BLOCK * 2);
}

/** Writes `root` as a gzipped tar at `out` (fsynced); answers the entries with each file's hash. */
export async function writeTarGz(root: string, out: string): Promise<TarEntry[]> {
  const { entries } = walk(root);
  const hashes = new Map<string, string>();
  await pipeline(Readable.from(blocks(root, entries, hashes)), createGzip({ level: zc.Z_BEST_COMPRESSION }), createWriteStream(out, { mode: 0o600 }));
  const fd = openSync(out, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  for (const e of entries) if (!e.name.endsWith("/")) e.sha256 = hashes.get(e.name);
  return entries;
}

/** Reads a gzipped tar back, streaming (a big home is never held in memory whole): each entry's
    name, mode, size and (files) sha256. */
export async function readTarGz(file: string): Promise<TarEntry[]> {
  const out: TarEntry[] = [];
  let pending: Buffer = Buffer.alloc(0);
  /** The entry whose data is being read, and how much of it is left (with its padding). */
  let cur: { entry: TarEntry | null; hash: ReturnType<typeof createHash> | null; left: number; padLeft: number; pax: Buffer[] | null } | null = null;
  let longName: string | null = null;
  let ended = false;
  const feed = (): void => {
    for (;;) {
      if (ended) return;
      if (cur) {
        if (cur.left > 0) {
          if (pending.length === 0) return;
          const take = pending.subarray(0, Math.min(cur.left, pending.length));
          pending = pending.subarray(take.length);
          cur.left -= take.length;
          cur.hash?.update(take);
          cur.pax?.push(Buffer.from(take));
          if (cur.left > 0) return;
        }
        if (cur.padLeft > 0) {
          const skip = Math.min(cur.padLeft, pending.length);
          pending = pending.subarray(skip);
          cur.padLeft -= skip;
          if (cur.padLeft > 0) return;
        }
        if (cur.pax) {
          const m = /(?:^|\n)\d+ path=([^\n]*)\n/.exec(Buffer.concat(cur.pax).toString("utf8"));
          longName = m ? m[1]! : null;
        } else if (cur.entry) {
          if (cur.hash) cur.entry.sha256 = cur.hash.digest("hex");
          out.push(cur.entry);
        }
        cur = null;
      }
      if (pending.length < BLOCK) return;
      const h = pending.subarray(0, BLOCK);
      pending = pending.subarray(BLOCK);
      if (h.every((x) => x === 0)) {
        ended = true;
        return;
      }
      const field = (o: number, n: number) => h.subarray(o, o + n).toString("utf8").replace(/\0.*$/s, "");
      const size = parseInt(field(124, 12).trim() || "0", 8);
      const mode = parseInt(field(100, 8).trim() || "0", 8);
      const mtimeMs = parseInt(field(136, 12).trim() || "0", 8) * 1000;
      const type = field(156, 1) || "0";
      const padLeft = (BLOCK - (size % BLOCK)) % BLOCK;
      if (type === "x") {
        cur = { entry: null, hash: null, left: size, padLeft, pax: [] };
        continue;
      }
      const name = longName ?? field(0, 100);
      longName = null;
      if (type === "5") cur = { entry: { name, mode, mtimeMs, size: 0 }, hash: null, left: 0, padLeft: 0, pax: null };
      else if (type === "0") cur = { entry: { name, mode, mtimeMs, size }, hash: createHash("sha256"), left: size, padLeft, pax: null };
      else throw new Error(`unexpected tar entry type ${type}`);
    }
  };
  await pipeline(createReadStream(file), createGunzip(), async function* (src) {
    for await (const c of src) {
      pending = pending.length ? Buffer.concat([pending, c as Buffer]) : (c as Buffer);
      feed();
    }
  });
  if (!ended) throw new Error("the archive ends early");
  return out;
}

/** True when `got` holds exactly `want`'s folders and files, each file of the same size and hash. */
export function sameEntries(want: readonly TarEntry[], got: readonly TarEntry[]): boolean {
  if (want.length !== got.length) return false;
  const byName = new Map(got.map((e) => [e.name, e]));
  for (const w of want) {
    const g = byName.get(w.name);
    if (!g || g.size !== w.size || g.sha256 !== w.sha256) return false;
  }
  return true;
}
