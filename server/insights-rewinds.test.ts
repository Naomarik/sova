// Run: npx tsx --test server/insights-rewinds.test.ts
// Also covers SessionInsight.outlines, the outline-snapshot series the Timeline draws.
// Uses a throwaway PI_CODING_AGENT_DIR in the OS temp dir; ~/.pi is never read or written.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

const agentDir = mkdtempSync(join(tmpdir(), "sova-rewinds-test-"));
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
      line({ type: "custom", id: "m1", parentId: "c1", timestamp: "2026-09-20T00:04:00.000Z", customType: "sova-rewind", data: { targetId: "u2", fromLeafId: "a2" } }) +
      line({ type: "custom", id: "m2", parentId: "m1", timestamp: "2026-09-20T00:05:00.000Z", customType: "sova-rewind", data: {} }),
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

/**
 * A session whose branch carries a series of topic-outline snapshots, written straight after the
 * header so each entry's parent is the one before it. `datas` are the entries' payloads in order;
 * entry i gets id `o<i>` and a stamp i minutes past midnight.
 */
function outlineSession(name: string, datas: unknown[]): string {
  const id = `01a0c0ff-0000-7000-8000-${name.padStart(12, "0")}`;
  const path = join(sessionsDir, `2026-09-21T00-00-00-000Z_${id}.jsonl`);
  const line = (e: unknown) => `${JSON.stringify(e)}\n`;
  let text = line({ type: "session", version: 3, id, timestamp: "2026-09-21T00:00:00.000Z", cwd: "/tmp" });
  datas.forEach((data, i) => {
    text += line({ type: "custom", id: `o${i}`, parentId: i === 0 ? null : `o${i - 1}`, timestamp: stamp(i), customType: "topic-outline", data });
  });
  writeFileSync(path, text);
  return canonicalPath(path);
}
const stamp = (i: number) => new Date(Date.UTC(2026, 8, 21, 0, i)).toISOString();
const snap = (now: string, overall: string, generatedAt = 0) => ({ version: 2, now, overall, generatedAt, state: "fresh", topics: [] });

test("every outline snapshot on the branch lands, oldest first, with its entry's id and stamp", async () => {
  const insight = await getSessionInsight(outlineSession("100", [snap("First", "One.", 1789990000000), snap("Second", "Two."), snap("Third", "Three.", 1789990200000)]));
  assert.deepEqual(insight.outlines, [
    { id: "o0", timestamp: stamp(0), now: "First", overall: "One.", generatedAt: 1789990000000 },
    { id: "o1", timestamp: stamp(1), now: "Second", overall: "Two.", generatedAt: 0 },
    { id: "o2", timestamp: stamp(2), now: "Third", overall: "Three.", generatedAt: 1789990200000 },
  ]);
  assert.equal(insight.outline!.now, "Third", "outline stays the newest snapshot");
});

test("a summary repeated by the next snapshot is kept once; a later return to it is a new row", async () => {
  const insight = await getSessionInsight(outlineSession("101", [snap("A", "a."), snap("A", "a.", 5), snap("B", "b."), snap("A", "a.")]));
  assert.deepEqual(insight.outlines!.map((o) => o.id), ["o0", "o2", "o3"]);
});

test("a malformed or older-version snapshot is skipped and its neighbours survive", async () => {
  const insight = await getSessionInsight(
    outlineSession("102", [snap("Before", "b."), { version: 1, now: "Old shape" }, "not an object", { version: 2, now: "No topics" }, snap("After", "a.")]),
  );
  assert.deepEqual(insight.outlines!.map((o) => [o.id, o.now]), [["o0", "Before"], ["o4", "After"]]);
});

test("the series is capped to the newest 200 distinct summaries", async () => {
  const datas = Array.from({ length: 205 }, (_, i) => snap(`Step ${i}`, ""));
  const outlines = (await getSessionInsight(outlineSession("103", datas))).outlines!;
  assert.equal(outlines.length, 200);
  assert.equal(outlines[0]!.now, "Step 5", "the oldest five are the ones dropped");
  assert.equal(outlines.at(-1)!.now, "Step 204");
});

test("a session with no outline snapshots leaves the series out", async () => {
  const insight = await getSessionInsight(outlineSession("104", []));
  assert.equal("outlines" in insight, false);
});
