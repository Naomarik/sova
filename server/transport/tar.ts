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

/** Write `entries` as one tar at `file`. Each file is read as it is now: one that changed size
    meanwhile is refused (the caller stops what writes it first). */
export async function writeTar(file: string, entries: readonly TarEntry[]): Promise<{ size: number }> {
  const fh = await open(file, "w", 0o600);
  let size = 0;
  const put = async (b: Buffer) => {
    await fh.write(b);
    size += b.length;
  };
  try {
    for (const e of entries) {
      const name = e.type === "dir" && !e.name.endsWith("/") ? `${e.name}/` : e.name;
      const link = e.type === "symlink" ? e.target : undefined;
      const recs: string[] = [];
      if (!fits(name)) recs.push(paxRecord("path", name));
      if (link !== undefined && !fits(link)) recs.push(paxRecord("linkpath", link));
      if (recs.length) {
        const body = Buffer.from(recs.join(""), "utf8");
        await put(header({ name: "PaxHeader", mode: 0o644, size: body.length, mtime: e.mtime, flag: "x" }));
        await put(body);
        await put(zero.subarray(0, pad(body.length)));
      }
      const short = fits(name) ? name : asciiStub(name);
      const shortLink = link === undefined ? undefined : fits(link) ? link : asciiStub(link);
      if (e.type === "dir") await put(header({ name: short, mode: e.mode, size: 0, mtime: e.mtime, flag: "5" }));
      else if (e.type === "symlink") await put(header({ name: short, mode: e.mode, size: 0, mtime: e.mtime, flag: "2", linkname: shortLink! }));
      else if (e.type === "data") {
        await put(header({ name: short, mode: e.mode, size: e.data.length, mtime: e.mtime, flag: "0" }));
        await put(e.data);
        await put(zero.subarray(0, pad(e.data.length)));
      } else {
        await put(header({ name: short, mode: e.mode, size: e.size, mtime: e.mtime, flag: "0" }));
        let got = 0;
        if (e.size > 0)
          for await (const chunk of createReadStream(e.from, { start: 0, end: e.size - 1 })) {
            await put(chunk as Buffer);
            got += (chunk as Buffer).length;
          }
        // A file grown since its lstat reads only its first `size` bytes: shrunk is the one change caught here.
        if (got !== e.size) throw new Error(`${e.from} changed while it was packed (${got} of ${e.size} bytes)`);
        await put(zero.subarray(0, pad(e.size)));
      }
    }
    await put(zero);
    await put(zero);
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
