// Run: pnpm test -- server/caller-keys.test.ts
// A key for each chat process (§app.command-audit/keys): it names its chat while that process runs and
// nobody after; only its hash is kept; a restart's take-back keeps the keys of the chats it took back
// and a prune after a whole take-back deletes the rest.
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { CallerKeys } from "./caller-keys";

const tmp = mkdtempSync(join(tmpdir(), "sova-caller-keys-"));
after(() => rmSync(tmp, { recursive: true, force: true }));
let n = 0;
/** A fresh key set over its own dir, with a tracked-process set standing in for the supervisor. */
function fresh(dir = join(tmp, `d${++n}`)) {
  const running = new Set<string>();
  const keys = new CallerKeys(() => dir);
  keys.setLiveness((chatId, unit) => running.has(`${chatId} ${unit}`));
  return { dir, keys, running, start: (chatId: string, unit: string) => running.add(`${chatId} ${unit}`), end: (chatId: string, unit: string) => running.delete(`${chatId} ${unit}`) };
}

test("a key names its chat while its process runs, and nobody once it ends", () => {
  const k = fresh();
  const key = k.keys.issue("chat-a", "unit-a");
  k.start("chat-a", "unit-a");
  assert.equal(k.keys.callerOf(key), "chat:chat-a");
  k.end("chat-a", "unit-a");
  assert.equal(k.keys.callerOf(key), "unattributed");
});

test("only the hash is kept, readable by the user only", () => {
  const k = fresh();
  const key = k.keys.issue("chat-b", "sova-chat-b");
  const files = readdirSync(k.dir);
  assert.deepEqual(files, ["sova-chat-b.json"]);
  const text = readFileSync(join(k.dir, files[0]!), "utf8");
  assert.ok(!text.includes(key), "the key itself is never written");
  assert.equal(statSync(join(k.dir, files[0]!)).mode & 0o777, 0o600);
  assert.equal(statSync(k.dir).mode & 0o777, 0o700);
});

test("no header is no-key; a malformed, huge or unknown one is unattributed", () => {
  const k = fresh();
  k.keys.issue("chat-c", "unit-c");
  k.start("chat-c", "unit-c");
  assert.equal(k.keys.callerOf(undefined), "no-key");
  for (const v of ["", "short", "x".repeat(10_000), "has spaces in it and more", "A".repeat(43)]) assert.equal(k.keys.callerOf(v), "unattributed", v.slice(0, 20));
});

test("a new key for a unit revokes its old one; a reload's replacement keeps its own when the old process ends", () => {
  const k = fresh();
  const first = k.keys.issue("chat-d", "unit-d");
  k.start("chat-d", "unit-d");
  // The chat starts again on the same unit name: the old key names nobody, the new one names the chat.
  const again = k.keys.issue("chat-d", "unit-d");
  assert.equal(k.keys.callerOf(first), "unattributed");
  assert.equal(k.keys.callerOf(again), "chat:chat-d");
  // A reload: a replacement on its own unit, then the old process ends.
  const rep = k.keys.issue("chat-d", "unit-d-r1");
  k.start("chat-d", "unit-d-r1");
  assert.equal(k.keys.callerOf(again), "chat:chat-d");
  k.end("chat-d", "unit-d");
  assert.equal(k.keys.callerOf(again), "unattributed", "the old process's key (a stale env-file copy) names nobody");
  assert.equal(k.keys.callerOf(rep), "chat:chat-d");
});

test("a restart: taken-back chats keep their keys, a whole take-back's prune deletes the rest, a launch meanwhile deletes nothing", () => {
  const before = fresh();
  const kept = before.keys.issue("chat-e", "unit-e");
  const gone = before.keys.issue("chat-f", "unit-f");
  // The new server over the same dir; its supervisor tracks nothing until the take-back adopts chat-e.
  const k = fresh(before.dir);
  assert.equal(k.keys.callerOf(kept), "unattributed", "before the take-back");
  // A launch during the take-back (a new chat) deletes no other key.
  const during = k.keys.issue("chat-g", "unit-g");
  k.start("chat-g", "unit-g");
  assert.deepEqual(readdirSync(k.dir).sort(), ["unit-e.json", "unit-f.json", "unit-g.json"]);
  k.start("chat-e", "unit-e"); // adopted
  assert.equal(k.keys.callerOf(kept), "chat:chat-e");
  assert.deepEqual(k.keys.prune().sort(), ["unit-e", "unit-g"]);
  assert.deepEqual(readdirSync(k.dir).sort(), ["unit-e.json", "unit-g.json"]);
  assert.equal(k.keys.callerOf(gone), "unattributed");
  assert.equal(k.keys.callerOf(during), "chat:chat-g");
  // A third start sees the same: the pruned key is gone for good.
  const third = fresh(before.dir);
  third.start("chat-f", "unit-f");
  assert.equal(third.keys.callerOf(gone), "unattributed");
});

test("a liveness check that throws names nobody, and a prune that can't tell keeps the key", () => {
  const k = fresh();
  const key = k.keys.issue("chat-h", "unit-h");
  k.keys.setLiveness(() => {
    throw new Error("supervisor gone");
  });
  assert.equal(k.keys.callerOf(key), "unattributed");
  assert.deepEqual(k.keys.prune(), ["unit-h"]);
  assert.deepEqual(readdirSync(k.dir), ["unit-h.json"]);
});

test("a prune never touches a key this server life issued: a chat still spawning keeps its key", () => {
  const before = fresh();
  const old = before.keys.issue("chat-old", "unit-old");
  const k = fresh(before.dir);
  // Issued at launch, not yet tracked (its unit is still starting) when the whole take-back prunes.
  const starting = k.keys.issue("chat-new", "unit-new");
  assert.deepEqual(k.keys.prune().sort(), ["unit-new"]);
  assert.deepEqual(readdirSync(k.dir).sort(), ["unit-new.json"], "an earlier server's dead key goes");
  k.start("chat-new", "unit-new");
  assert.equal(k.keys.callerOf(starting), "chat:chat-new");
  assert.equal(k.keys.callerOf(old), "unattributed");
});

test("a key file that can't be removed is left and logged; the prune never throws", () => {
  const before = fresh();
  before.keys.issue("chat-x", "unit-x");
  const k = fresh(before.dir);
  chmodSync(k.dir, 0o500);
  try {
    assert.doesNotThrow(() => k.keys.prune());
  } finally {
    chmodSync(k.dir, 0o700);
  }
  assert.deepEqual(readdirSync(k.dir), ["unit-x.json"]);
});
