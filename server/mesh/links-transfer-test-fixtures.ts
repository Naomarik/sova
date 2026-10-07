// Tests: trees, spools and refusals for links-transfer.test.ts, links-transfer.integration.test.ts and
// links.test.ts. inProcessTar stands in for the host's tar (packing ustar, extracting it), so spools,
// pulls and pre-scans run in-process; the real tar: the integration file.
import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { createReadStream, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { createZstdDecompress } from "node:zlib";
import { type TarRunner, TransferError } from "./links-transfer";
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

// ---- tar in-process ---------------------------------------------------------------------------------

const octal = (n: number, width: number) => `${n.toString(8).padStart(width - 1, "0")}\0`;

/** One ustar header; a name past 100 bytes is split into prefix and name at a slash. */
function header(path: string, type: "0" | "2" | "5", size: number, mode: number, linkname = ""): Buffer {
  let name = path;
  let prefix = "";
  if (Buffer.byteLength(path) > 100) {
    const cut = path.lastIndexOf("/", path.length - 2);
    prefix = path.slice(0, cut);
    name = path.slice(cut + 1);
  }
  assert.ok(Buffer.byteLength(name) <= 100 && Buffer.byteLength(prefix) <= 155 && Buffer.byteLength(linkname) <= 100, `${path}: too long for this writer`);
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
  h.write(prefix, 345);
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

const field = (h: Buffer, at: number, len: number) => h.subarray(at, at + len).toString("utf8").replace(/\0[\s\S]*$/, "");

/** Every member of `archive` (concatenated ustar archives, zero blocks skipped) written under `dest`. */
function untar(archive: Buffer, dest: string): void {
  for (let at = 0; at + 512 <= archive.length; ) {
    const h = archive.subarray(at, at + 512);
    at += 512;
    if (h.every((b) => b === 0)) continue; // --ignore-zeros
    const prefix = field(h, 345, 155);
    const name = (prefix ? `${prefix}/` : "") + field(h, 0, 100);
    const size = parseInt(field(h, 124, 12) || "0", 8);
    const mode = parseInt(field(h, 100, 8) || "644", 8);
    const type = String.fromCharCode(h[156]!);
    const p = join(dest, name);
    if (type === "5") mkdirSync(p, { recursive: true, mode });
    else if (type === "2") {
      rmSync(p, { force: true });
      symlinkSync(field(h, 157, 100), p);
    } else {
      rmSync(p, { force: true });
      writeFileSync(p, archive.subarray(at, at + size), { mode });
    }
    at += Math.ceil(size / 512) * 512;
  }
}

/**
 * `tar` in-process for Spools and Pulls (their `tar` option): `-cf -` packs the NUL-separated
 * members its stdin names as ustar on its stdout; `-x -f -` extracts its stdin under `-C`. A
 * failure (a member gone, a directory it can't write) is a line on stderr and exit 2, as with tar.
 */
export const inProcessTar: TarRunner = (args) => {
  const child = new EventEmitter() as EventEmitter & { stdin: PassThrough; stdout: PassThrough; stderr: PassThrough; pid: number; exitCode: number | null; kill(): boolean };
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.pid = 2 ** 30;
  child.exitCode = null;
  const dir = args[args.indexOf("-C") + 1]!;
  const creating = args.includes("-cf");
  const finish = (code: number | null) => {
    if (child.exitCode !== null) return;
    child.exitCode = code ?? 137;
    child.stderr.end();
    // 'close' comes once the output was read, as a real child's does after its stdio closes.
    if (creating && code === 0) child.stdout.once("end", () => child.emit("close", code));
    else setImmediate(() => child.emit("close", code));
    child.stdout.end();
  };
  child.kill = () => (finish(null), true);
  const input: Buffer[] = [];
  child.stdin.on("data", (c: Buffer) => input.push(c));
  child.stdin.on("end", () => {
    if (child.exitCode !== null) return;
    try {
      const all = Buffer.concat(input);
      if (creating) child.stdout.write(tarOf(dir, all.toString("utf8").split("\0").filter(Boolean)));
      else untar(all, dir);
      finish(0);
    } catch (err) {
      child.stderr.write(`tar: ${(err as Error).message}\n`);
      finish(2);
    }
  });
  return child as unknown as ChildProcess;
};
