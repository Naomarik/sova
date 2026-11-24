// A package's loose files are checked before a byte is written (§app.transport/arrival): what the
// writer makes reads back as it was, and a member list that would reach outside the folder is refused.
import "../testing/scratch-agent-dir";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { scratchRoot } from "../test-scratch";
import { checkMembers, entryOf, listTar, writeTar } from "./tar";

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
});
