// A package's loose files are checked before a byte is written (§app.transport/arrival): what the
// writer makes reads back as it was, and a member list that would reach outside the folder is refused.
import "../testing/scratch-agent-dir";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { scratchRoot } from "../test-scratch";
import { checkMembers, entryOf, listTar, listTarStream, writeTar } from "./tar";

const root = scratchRoot("sova-transport-tar-");
after(() => rmSync(root, { recursive: true, force: true }));

test("the writer's tar reads back: long and non-ASCII names, links, modes", async () => {
  const src = join(root, "src");
  mkdirSync(join(src, "d"), { recursive: true });
  const long = `d/${"x".repeat(120)}-é.txt`;
  writeFileSync(join(src, long), "hi");
  writeFileSync(join(src, "secret"), "k", { mode: 0o600 });
  symlinkSync("secret", join(src, "link"));
  const entries = [];
  for (const rel of ["d", long, "link", "secret"]) entries.push((await entryOf(src, rel))!);
  await writeTar(join(root, "a.tar"), entries);
  const got = await listTar(join(root, "a.tar"));
  assert.deepEqual(got.map((m) => [m.name, m.flag]), [["d/", "5"], [long, "0"], ["link", "2"], ["secret", "0"]]);
  assert.equal(got[2]!.linkname, "secret");
  assert.equal(got[3]!.mode & 0o777, 0o600);
  assert.equal(checkMembers(got), null);
});

test("a member under a link, a .. or an absolute name, an odd kind or setuid is refused", () => {
  const f = (name: string, flag = "0", mode = 0o644) => ({ name, flag, mode });
  assert.match(checkMembers([f("link", "2"), f("link/authorized_keys")])!, /through a link/);
  assert.match(checkMembers([f("a/../../x")])!, /names/);
  assert.match(checkMembers([f("/etc/passwd")])!, /names/);
  assert.match(checkMembers([f("dev", "3")])!, /kind/);
  assert.match(checkMembers([f("run", "0", 0o4755)])!, /special permission/);
  // A link the folder already has (a tracked symlink) counts too.
  assert.match(checkMembers([f("lib/x")], (rel) => rel === "lib")!, /through a link/);
});

test("a header this writer never makes is refused: a ustar prefix (link, then prefix/name through it)", async () => {
  await writeTar(join(root, "p.tar"), [{ name: "l", type: "symlink", target: "/tmp", mode: 0o777, mtime: 0 }, { name: "authorized_keys", type: "data", mode: 0o644, mtime: 0, data: Buffer.from("k") }]);
  const b = readFileSync(join(root, "p.tar"));
  // The second header gets prefix "l": an extractor would write l/authorized_keys, through the link.
  const h = b.subarray(512, 1024);
  h.write("l", 345, "latin1");
  h.write("        ", 148, 8, "ascii");
  let sum = 0;
  for (const x of h) sum += x;
  h.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
  writeFileSync(join(root, "p.tar"), b);
  await assert.rejects(listTar(join(root, "p.tar")), /prefix/);
  await assert.rejects(listTarStream([b]), /prefix/);
});

/** `buf` in pieces of `n` bytes, as a stream would hand them over. */
function* pieces(buf: Buffer, n: number): Generator<Buffer> {
  for (let i = 0; i < buf.length; i += n) yield buf.subarray(i, i + n);
}

test("a tar read as a stream lists what the file handle lists, however the stream cuts it, and sees every byte", async () => {
  const src = join(root, "stream");
  mkdirSync(join(src, "d"), { recursive: true });
  const long = `d/${"y".repeat(150)}-ü.bin`;
  writeFileSync(join(src, long), Buffer.alloc(1300, 7));
  writeFileSync(join(src, "empty"), "");
  symlinkSync(`${"t".repeat(120)}`, join(src, "far"));
  const entries = [];
  for (const rel of ["d", long, "empty", "far"]) entries.push((await entryOf(src, rel))!);
  await writeTar(join(root, "s.tar"), entries);
  const whole = readFileSync(join(root, "s.tar"));
  const want = await listTar(join(root, "s.tar"));
  assert.deepEqual(want.map((m) => m.name), ["d/", long, "empty", "far"]);
  for (const n of [1, 7, 511, 512, 513, 4096, whole.length]) {
    let seen = 0;
    assert.deepEqual(await listTarStream(pieces(whole, n), (c) => (seen += c.length)), want, `cut every ${n} bytes`);
    assert.equal(seen, whole.length);
  }
});

test("a pax header longer than any this writer makes is refused, by both readers", async () => {
  await writeTar(join(root, "x.tar"), [{ name: `${"z".repeat(70 * 1024)}`, type: "data", mode: 0o644, mtime: 0, data: Buffer.from("k") }]);
  await assert.rejects(listTar(join(root, "x.tar")), /pax header too long/);
  await assert.rejects(listTarStream([readFileSync(join(root, "x.tar"))]), /pax header too long/);
});
