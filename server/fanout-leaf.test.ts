// Run: npx tsx --test server/fanout-leaf.test.ts
// The leaf a fanout compares against is the last entry pi-web would RENDER, not the last line.
// Real files, real reader: the bug these cover is that the file routinely ends in something the
// transcript hides, and comparing against THAT refuses an untouched source as stale — telling the
// user to fork from a "new last message" that looks exactly like the one they already had.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

const agentDir = mkdtempSync(join(tmpdir(), "pi-web-fanout-leaf-"));
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

test("a rewound session — whose last line is ALWAYS the rewind marker — is not stale", async () => {
  const path = source("rewound", [{ type: "custom", id: "rw-1", parentId: "a1", customType: "pi-web-rewind", data: { targetId: "u1", fromLeafId: "a1" } }]);
  const refused = await checkSource(path, "a1", deps);
  assert.equal(refused, null, "the marker is invisible in the transcript, so it is not the leaf");
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

test("the hidden entries stack up without hiding the real leaf", async () => {
  const path = source("many", [
    { type: "usage", id: "usage-1", parentId: "a1", usage: { input: 1 } },
    { type: "message", id: "sys-1", parentId: "a1", message: { role: "system", content: [{ type: "text", text: "t" }] } },
    { type: "usage", id: "usage-2", parentId: "a1", usage: { input: 2 } },
    { type: "custom", id: "rw-1", parentId: "a1", customType: "pi-web-rewind", data: {} },
  ]);
  assert.equal(await checkSource(path, "a1", deps), null);
});

test("an older session format is refused before the leaf is even considered", async () => {
  const path = join(sessionsDir, "2026-09-20T00-00-00-000Z_old.jsonl");
  writeFileSync(path, [{ ...HEADER, version: 2 }, USER, REPLY].map((e) => JSON.stringify(e)).join("\n") + "\n");
  const refused = await checkSource(path, "a1", deps);
  assert.equal(refused?.code, "old-format");
});
