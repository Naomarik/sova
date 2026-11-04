// Run: pnpm test -- server/settings-browser-temp.test.ts
// The browser test's temp directory chooser (settings-browser-temp.ts): a short candidate is used as
// is, a long one is passed over for the next, an unwritable one too, and with none left it skips
// naming each reason. `make` stands in for mkdtemp, so no real directory decides the outcome.
import assert from "node:assert/strict";
import { test } from "node:test";
import { chooseBrowserTemp, socketFits } from "./settings-browser-temp";

const long = `/${"d".repeat(90)}`;
const made: string[] = [];
const make = (refuse: string[] = []) => (prefix: string) => {
  if (refuse.some((r) => prefix.startsWith(`${r}/`))) throw Object.assign(new Error("read-only"), { code: "EROFS" });
  made.push(prefix);
  return `${prefix}abc123`;
};

test("socketFits: a short directory fits Chrome's socket limit, a 90-character one doesn't", () => {
  assert.equal(socketFits("/tmp/sova-sb-abc123"), true);
  assert.equal(socketFits(long), false);
});

test("a short, writable first candidate is used", () => {
  const r = chooseBrowserTemp(["/short", "/tmp"], make());
  assert.ok("dir" in r);
  assert.equal(r.dir, "/short/sova-sb-abc123");
});

test("a long first candidate (a sandbox's TMPDIR) is passed over for /tmp", () => {
  const r = chooseBrowserTemp([long, "/tmp", "/dev/shm"], make());
  assert.ok("dir" in r);
  assert.equal(r.dir, "/tmp/sova-sb-abc123");
});

test("an unwritable /tmp is passed over for /dev/shm", () => {
  const r = chooseBrowserTemp([long, "/tmp", "/dev/shm"], make(["/tmp"]));
  assert.ok("dir" in r);
  assert.equal(r.dir, "/dev/shm/sova-sb-abc123");
});

test("with no short writable candidate it skips, naming why each was passed over", () => {
  const r = chooseBrowserTemp([long, "/tmp", "/dev/shm"], make(["/tmp", "/dev/shm"]));
  assert.ok("skip" in r);
  assert.match(r.skip, /too long/);
  assert.match(r.skip, /\/tmp: not writable \(EROFS\)/);
  assert.match(r.skip, /\/dev\/shm: not writable/);
});

test("the real chooser makes a directory this process can use, and cleans it up", () => {
  const r = chooseBrowserTemp();
  if ("skip" in r) return; // a host with no short writable temp: the reason is the result
  assert.ok(socketFits(r.dir));
  r.cleanup();
});
