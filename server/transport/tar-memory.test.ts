// A safety copy and a worktree's loose files are never read whole into memory (§app.transport/moved-row,
// §app.transport/arrival): a tar's members are listed through a file handle, a folder's archive is
// written straight through zstd and read back as a stream. A file far larger than the memory budget,
// sparse so the test costs no disk, shows the process's peak stays bounded.
import "../testing/scratch-agent-dir";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, openSync, closeSync, writeSync, ftruncateSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { scratchRoot } from "../test-scratch";
import { compressFolder } from "./package";
import { listTar, writeTar } from "./tar";

const root = scratchRoot("sova-transport-tar-memory-");
after(() => rmSync(root, { recursive: true, force: true }));

const MiB = 1024 * 1024;
/** Far beyond what the budget would let a whole read hold. */
const BIG = 512 * MiB;
/** How much the process's peak resident memory may grow while one big archive is handled. */
const BUDGET = 160 * MiB;
const peak = () => process.resourceUsage().maxRSS * 1024;

/** A ustar header as the package's writer makes one (owner 0:0, no names). */
function ustar(name: string, size: number, flag = "0"): Buffer {
  const b = Buffer.alloc(512);
  const oct = (n: number, w: number) => `${n.toString(8).padStart(w - 1, "0")}\0`;
  b.write(name, 0, 100, "utf8");
  b.write(oct(0o644, 8), 100, 8, "ascii");
  b.write(oct(0, 8), 108, 8, "ascii");
  b.write(oct(0, 8), 116, 8, "ascii");
  b.write(oct(size, 12), 124, 12, "ascii");
  b.write(oct(0, 12), 136, 12, "ascii");
  b.write("        ", 148, 8, "ascii");
  b.write(flag, 156, 1, "ascii");
  b.write("ustar\0", 257, 6, "ascii");
  b.write("00", 263, 2, "ascii");
  let sum = 0;
  for (const x of b) sum += x;
  b.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
  return b;
}

/** A sparse file of `size` bytes (a hole: no disk, no page cache until read). */
function sparse(file: string, size: number): void {
  const fd = openSync(file, "w");
  ftruncateSync(fd, size);
  closeSync(fd);
}

// Warm up what the measured runs load (zstd, the streams), so the budget measures the data, not the code.
const warm = join(root, "warm");
mkdirSync(warm);
writeFileSync(join(warm, "a"), "a");
await compressFolder(warm, join(root, "warm.tar.zst"));
await writeTar(join(root, "warm.tar"), [{ name: "a", type: "data", mode: 0o644, mtime: 0, data: Buffer.from("a") }]);
await listTar(join(root, "warm.tar"));
/** The peak before any big archive: every case is held to it (the peak is a high-water mark, never lower). */
const baseline = peak();

test("a tar holding a file larger than the memory budget is listed without reading it whole", async () => {
  // big (a hole), then a small member after it, then the end: what a loose.tar with one huge file looks like.
  const tar = join(root, "big.tar");
  const fd = openSync(tar, "w");
  writeSync(fd, ustar("big.bin", BIG), 0, 512, 0);
  let at = 512 + BIG;
  writeSync(fd, ustar("after.txt", 1), 0, 512, at);
  writeSync(fd, Buffer.from("x"), 0, 1, at + 512);
  at += 1024;
  ftruncateSync(fd, at + 1024);
  closeSync(fd);
  const got = await listTar(tar);
  const grew = peak() - baseline;
  assert.deepEqual(got.map((m) => [m.name, m.size]), [["big.bin", BIG], ["after.txt", 1]]);
  assert.ok(grew < BUDGET, `listing a ${BIG / MiB} MiB tar raised peak memory by ${Math.round(grew / MiB)} MiB (budget ${BUDGET / MiB} MiB)`);
});

test("a folder holding a file larger than the memory budget goes into its safety copy streamed, read back before it counts", async () => {
  const dir = join(root, "wt");
  mkdirSync(join(dir, "target"), { recursive: true });
  writeFileSync(join(dir, "a.txt"), "hello\n");
  sparse(join(dir, "target", "huge.bin"), BIG);
  const out = join(root, "wt.tar.zst");
  const r = await compressFolder(dir, out);
  const grew = peak() - baseline;
  assert.equal(r.entries, 3);
  assert.ok(grew < BUDGET, `archiving a folder with a ${BIG / MiB} MiB file raised peak memory by ${Math.round(grew / MiB)} MiB (budget ${BUDGET / MiB} MiB)`);
  // Only the archive is left: no plain tar beside it, no half-written file.
  assert.deepEqual(readdirSync(root).filter((n) => n.startsWith("wt.")), ["wt.tar.zst"]);
  assert.ok(existsSync(out));
});
