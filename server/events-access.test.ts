// Run: node scripts/run-tests.mjs server/events-access.test.ts
// /ws/events is this machine's own door only (§app.events/listeners): the peer listener's classifier
// gives it a need no grant meets, and the share listener has no such socket. Pure: no sockets.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { EVENTS_PATH } from "../shared/events";

const tmp = mkdtempSync(join(tmpdir(), "sova-events-access-"));
process.env.PI_CODING_AGENT_DIR = join(tmp, "agent");
mkdirSync(join(tmp, "agent"), { recursive: true });
const { allows, classifyUpgrade } = await import("./mesh/access");
after(() => rmSync(tmp, { recursive: true, force: true }));

test("the peer classifier: /ws/events needs `never`, whatever its query", () => {
  for (const q of ["", "since=1&stream=abcdefgh12345678", "feed=llm", "path=/x.jsonl"])
    assert.deepEqual(classifyUpgrade(EVENTS_PATH, new URLSearchParams(q)), { need: "never", rule: "ws:events:main-only" }, q);
});

test("no grant meets `never`: with no access file every peer has `full`, and still not this", () => {
  assert.equal(allows("some-node", "full"), true, "the default grant is full");
  assert.equal(allows("some-node", "never"), false);
});
