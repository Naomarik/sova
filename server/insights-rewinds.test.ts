// Run: npx tsx --test server/insights-rewinds.test.ts
// Uses a throwaway PI_CODING_AGENT_DIR in the OS temp dir; ~/.pi is never read or written.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

const agentDir = mkdtempSync(join(tmpdir(), "pi-web-rewinds-test-"));
process.env.PI_CODING_AGENT_DIR = agentDir; // before the modules below compute their paths
const sessionsDir = join(agentDir, "sessions", "--tmp-rewinds-test--");
mkdirSync(sessionsDir, { recursive: true });

const { getSessionInsight } = await import("./insights");
const { canonicalPath } = await import("./paths");

after(() => rmSync(agentDir, { recursive: true, force: true }));

/**
 * One session whose branch carries both facts this endpoint grew for the Timeline: a topic-outline
 * snapshot whose first topic has an anchor stamp and second does not, then two rewind markers — the
 * invisible entries chat-manager appends, one complete and one with an empty payload.
 */
function session(): string {
  const path = join(sessionsDir, "2026-09-20T00-00-00-000Z_01a0c0ff-0000-7000-8000-000000000000.jsonl");
  const line = (e: unknown) => `${JSON.stringify(e)}\n`;
  writeFileSync(
    path,
    line({ type: "session", version: 3, id: "01a0c0ff-0000-7000-8000-000000000000", timestamp: "2026-09-20T00:00:00.000Z", cwd: "/tmp" }) +
      line({ type: "message", id: "u1", parentId: null, timestamp: "2026-09-20T00:01:00.000Z", message: { role: "user", content: "hi" } }) +
      line({ type: "message", id: "a1", parentId: "u1", timestamp: "2026-09-20T00:02:00.000Z", message: { role: "assistant", content: [{ type: "text", text: "ok" }] } }) +
      line({
        type: "custom",
        id: "c1",
        parentId: "a1",
        timestamp: "2026-09-20T00:03:00.000Z",
        customType: "topic-outline",
        data: {
          version: 2,
          now: "Reading the pane",
          overall: "One thing at a time.",
          generatedAt: 1789949000000,
          state: "fresh",
          topics: [
            { id: "t1", heading: "Anchored", summary: ["a bullet"], at: 1789949520000, manual: false, anchor: { entryId: "u1", role: "user", timestamp: 1789948860000, fingerprint: "" } },
            { id: "t2", heading: "No stamp", summary: [], at: 1789949520000, manual: false, anchor: { entryId: "gone", role: "user", fingerprint: "" } },
          ],
        },
      }) +
      line({ type: "custom", id: "m1", parentId: "c1", timestamp: "2026-09-20T00:04:00.000Z", customType: "pi-web-rewind", data: { targetId: "u2", fromLeafId: "a2" } }) +
      line({ type: "custom", id: "m2", parentId: "m1", timestamp: "2026-09-20T00:05:00.000Z", customType: "pi-web-rewind", data: {} }),
  );
  return canonicalPath(path);
}

test("a topic carries the anchor's own clock beside the summarizer's, and omits it when there is none", async () => {
  const insight = await getSessionInsight(session());
  const topics = insight.outline!.topics;
  const withStamp = topics[0]!;
  const without = topics[1]!;
  assert.equal(withStamp.anchorAt, 1789948860000, "anchor.timestamp → anchorAt, not the summarizer's `at`");
  assert.notEqual(withStamp.anchorAt, withStamp.at);
  assert.equal(without.anchorAt, undefined, "an anchor with no stamp leaves the field out rather than zeroing it");
});

test("rewinds come off the branch's invisible markers, oldest first, with the payload flattened", async () => {
  const insight = await getSessionInsight(session());
  assert.deepEqual(insight.rewinds, [
    { id: "m1", timestamp: "2026-09-20T00:04:00.000Z", targetId: "u2", fromLeafId: "a2" },
    { id: "m2", timestamp: "2026-09-20T00:05:00.000Z", targetId: "", fromLeafId: "" },
  ]);
});

test("a session with no rewinds says nothing about them, so the payload stays lean", async () => {
  const path = join(sessionsDir, "2026-09-20T00-10-00-000Z_01a0c0ff-0000-7000-8000-000000000001.jsonl");
  writeFileSync(path, `${JSON.stringify({ type: "session", version: 3, id: "01a0c0ff-0000-7000-8000-000000000001", timestamp: "2026-09-20T00:10:00.000Z", cwd: "/tmp" })}\n`);
  const insight = await getSessionInsight(canonicalPath(path));
  assert.equal("rewinds" in insight, false);
});
