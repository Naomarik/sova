// Run: npx tsx --test server/fanout-leaf.test.ts
// The leaf a fanout compares against is the last entry Sova would RENDER ON THE ACTIVE BRANCH,
// not the last line of the file.
//
// RULE FOR THIS FILE, learned the hard way twice: when a test's subject is a FILE SHAPE, derive
// the fixture from the code that WRITES that shape, never from the shape the assertion needs.
// Both earlier versions of these tests were green against files production cannot produce — a
// rewind marker parented on the reply instead of the target (appendCustomEntry takes parentId
// from the leaf, which navigateTree has already moved), and an assertion feeding the ABANDONED
// entry as the leaf the dialog showed. Two errors that cancelled, so the suite certified
// branch-awareness the code did not have. Every marker below comes from the `rewind` helper,
// which mirrors server/chat-manager.ts rewindSession.
// Real files, real reader: the bug these cover is that the file routinely ends in something the
// transcript hides, and comparing against THAT refuses an untouched source as stale — telling the
// user to fork from a "new last message" that looks exactly like the one they already had.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

const agentDir = mkdtempSync(join(tmpdir(), "sova-fanout-leaf-"));
process.env.PI_CODING_AGENT_DIR = agentDir;
const sessionsDir = join(agentDir, "sessions", "--tmp-fanout--");
mkdirSync(sessionsDir, { recursive: true });
mkdirSync(join(agentDir, "sessions", "live"), { recursive: true });

const { checkSource, realFanoutDeps } = await import("./fanout");
after(() => rmSync(agentDir, { recursive: true, force: true }));

const HEADER = { type: "session", version: 3, id: "01a0-src", timestamp: "2026-09-20T00:00:00.000Z", cwd: "/tmp" };
const USER = { type: "message", id: "u1", parentId: null, message: { role: "user", content: [{ type: "text", text: "hi" }] } };
const REPLY = { type: "message", id: "a1", parentId: "u1", message: { role: "assistant", content: [{ type: "text", text: "there" }] } };

/** A source file ending in whatever `tail` says. Returns its path. */
function source(name: string, tail: unknown[]): string {
  const path = join(sessionsDir, `2026-09-20T00-00-00-000Z_${name}.jsonl`);
  writeFileSync(path, [HEADER, USER, REPLY, ...tail].map((e) => JSON.stringify(e)).join("\n") + "\n");
  return path;
}

/** The real deps, with only the liveness probes stubbed (no live registry in a temp agent dir). */
const deps = { ...realFanoutDeps, live: () => false, streaming: () => false, foreignWriter: () => false, misconfigured: () => false };

test("a usage entry appended after the last reply does not make the fork stale", async () => {
  // Cache warming is ON by default, so a top-level usage entry lands routinely and invisibly.
  const path = source("usage", [{ type: "usage", id: "usage-1", parentId: "a1", usage: { input: 10 }, kind: "cache_warm" }]);
  const refused = await checkSource(path, "a1", deps);
  assert.equal(refused, null, "the leaf the dialog showed is still a1");
});

// A rewind, exactly as server/chat-manager.ts writes it: a `custom` entry, customType
// "sova-rewind", data {targetId, fromLeafId}, PARENTED ON THE NEW LEAF. That parentage is the
// whole mechanism — SessionManager.open takes the file's last entry as the leaf, so the marker is
// what makes the rewind survive a reload, and it is what the active-branch walk follows.
const rewind = (id: string, newLeafId: string, fromLeafId: string) => ({
  type: "custom",
  id,
  parentId: newLeafId,
  customType: "sova-rewind",
  data: { targetId: newLeafId, fromLeafId },
});

test("a rewound source is not stale: the leaf is the active branch's, not the file tail's", async () => {
  // u1 → a1 is the branch the user LEFT. They rewound to u1, so the file ends with the marker and
  // the abandoned assistant reply a1 sits above it. Walking back from end-of-file lands on a1 —
  // the abandoned leaf — while the dialog showed u1.
  const path = source("rewound", [rewind("rw-1", "u1", "a1")]);
  assert.equal(await checkSource(path, "u1", deps), null, "the active leaf is accepted");
  const refused = await checkSource(path, "a1", deps);
  assert.equal(refused?.code, "stale-leaf", "and the ABANDONED leaf is correctly refused");
});

test("abandoned VISIBLE entries after a marker don't become the leaf", async () => {
  // Rewind to u1, continue (u2 → a2), then rewind to u1 again. The second marker is last in file
  // order; u2/a2 are ordinary visible messages sitting after the first marker, and abandoned.
  const path = source("rewound-twice", [
    rewind("rw-1", "u1", "a1"),
    { type: "message", id: "u2", parentId: "rw-1", message: { role: "user", content: [{ type: "text", text: "again" }] } },
    { type: "message", id: "a2", parentId: "u2", message: { role: "assistant", content: [{ type: "text", text: "sure" }] } },
    rewind("rw-2", "u1", "a2"),
  ]);
  assert.equal(await checkSource(path, "u1", deps), null, "still the active leaf");
  for (const abandoned of ["a1", "a2", "u2"]) {
    assert.equal((await checkSource(path, abandoned, deps))?.code, "stale-leaf", `${abandoned} is abandoned`);
  }
});

test("after a rewind and a NEW reply, the leaf is that reply", async () => {
  const path = source("rewound-continued", [
    rewind("rw-1", "u1", "a1"),
    { type: "message", id: "u2", parentId: "rw-1", message: { role: "user", content: [{ type: "text", text: "again" }] } },
    { type: "message", id: "a2", parentId: "u2", message: { role: "assistant", content: [{ type: "text", text: "sure" }] } },
  ]);
  assert.equal(await checkSource(path, "a2", deps), null);
  assert.equal((await checkSource(path, "a1", deps))?.code, "stale-leaf", "the abandoned reply is not the leaf");
});

test("a system loadout message after the reply does not make the fork stale", async () => {
  const path = source("system", [{ type: "message", id: "sys-1", parentId: "a1", message: { role: "system", content: [{ type: "text", text: "tools" }] } }]);
  assert.equal(await checkSource(path, "a1", deps), null);
});

test("a REAL new message does make the fork stale, and says how to recover", async () => {
  const path = source("moved", [{ type: "message", id: "u2", parentId: "a1", message: { role: "user", content: [{ type: "text", text: "more" }] } }]);
  const refused = await checkSource(path, "a1", deps);
  assert.ok(refused, "the user really did say something after the point the dialog showed");
  assert.equal(refused.code, "stale-leaf");
  assert.match(refused.message, /new last message/);
});

test("hidden entries stack up without hiding the real leaf", async () => {
  // All of these are production-shaped: a cache-warm usage row and a loadout message land
  // parented on the reply they follow. No rewind marker here — a marker's parentage is the
  // rewind TARGET, which would make this a different scenario entirely; that case has its own
  // tests above, built from the real shape.
  const path = source("many", [
    { type: "usage", id: "usage-1", parentId: "a1", usage: { input: 1 } },
    { type: "message", id: "sys-1", parentId: "a1", message: { role: "system", content: [{ type: "text", text: "t" }] } },
    { type: "usage", id: "usage-2", parentId: "a1", usage: { input: 2 } },
  ]);
  assert.equal(await checkSource(path, "a1", deps), null);
});

test("an older session format is refused before the leaf is even considered", async () => {
  const path = join(sessionsDir, "2026-09-20T00-00-00-000Z_old.jsonl");
  writeFileSync(path, [{ ...HEADER, version: 2 }, USER, REPLY].map((e) => JSON.stringify(e)).join("\n") + "\n");
  const refused = await checkSource(path, "a1", deps);
  assert.equal(refused?.code, "old-format");
});
