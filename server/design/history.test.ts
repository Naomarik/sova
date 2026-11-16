// A Lookbook's history on its own: what an older Lookbook recovers, the cap, and a deleted chat.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), "design-history-"));
const { HISTORY_LIMITS, forgetHistoryCache, readHistory, recordHistory } = await import("./history");
const store = await import("./store");
after(() => rmSync(process.env.PI_CODING_AGENT_DIR!, { recursive: true, force: true }));

let n = 0;
/** A Lookbook made before its history was kept: a run started from brief revision 3, with two designs. */
function olderLookbook(): string {
  const sid = `old${++n}`;
  store.changeDesigns(sid, (s) => {
    const at = "2026-01-01T00:00:00.000Z";
    s.runs.push({ id: "r1", phase: "done", labels: ["A", "B"], setup: { brief: "b", models: [], directions: [] }, createdAt: at, updatedAt: at, brief: { rev: 5, textRev: 3, summary: "S", prompt: "The prompt it launched with.", promptBy: "coordinator", writing: null, conflict: null, questions: [], looks: {}, startedRev: 5, startedAt: "2026-01-01T00:01:00.000Z" } });
    for (const label of ["A", "B"]) s.designs.push({ label, runId: "r1", direction: "Quiet", model: "zai/a", modelName: "a", parents: [], status: "ready", route: "tool", versions: [], workerState: "stopped", vision: true, createdAt: at, updatedAt: at });
  });
  return sid;
}

test("an older Lookbook shows its current Full Prompt and its Start, whatever is recorded after, until a revision of its own replaces them", () => {
  const sid = olderLookbook();
  const shape = () => readHistory(sid).items.map((i) => [i.kind, i.recovered ?? false, i.rev ?? null, i.designs?.map((d) => d.label) ?? null]);
  assert.deepEqual(shape(), [["prompt", true, 3, null], ["start", true, 3, ["A", "B"]]]);
  // Something happening to one of its designs now doesn't hide what came before it.
  recordHistory(sid, { kind: "remove", by: "user", runId: "r1", label: "B" });
  assert.deepEqual(shape(), [["prompt", true, 3, null], ["start", true, 3, ["A", "B"]], ["remove", false, null, null]]);
  // A revision recorded for the run is the real thing: the rebuilt one goes.
  recordHistory(sid, { kind: "prompt", by: "user", runId: "r1", rev: 4, text: "Newer." });
  assert.deepEqual(shape().map((x) => [x[0], x[1]]), [["start", true], ["remove", false], ["prompt", false]]);
});

test("the oldest items go to keep within the cap, and the history says so; ids are never given twice", () => {
  const sid = `cap${++n}`;
  for (let i = 0; i < HISTORY_LIMITS.items + 3; i++) recordHistory(sid, { kind: "message", by: "user", label: "A", text: `m${i}` });
  forgetHistoryCache();
  const h = readHistory(sid);
  assert.equal(h.items.length, HISTORY_LIMITS.items);
  assert.equal(h.items[0]!.text, "m3");
  assert.equal(h.trimmed, true);
  assert.equal(new Set(h.items.map((i) => i.id)).size, h.items.length);
  // By size too: one prompt near the limit pushes the rest out, but never itself.
  recordHistory(sid, { kind: "prompt", by: "user", text: "x".repeat(HISTORY_LIMITS.chars) });
  assert.deepEqual(readHistory(sid).items.map((i) => i.kind), ["prompt"]);
});

test("a deleted chat's history is gone with it and records nothing more", () => {
  const sid = olderLookbook();
  recordHistory(sid, { kind: "message", by: "user", label: "A", text: "hi" });
  store.removeDesignFiles(sid);
  assert.equal(recordHistory(sid, { kind: "message", by: "user", label: "A", text: "late" }), "");
  assert.deepEqual(readHistory(sid).items, []);
  assert.equal(store.designFolderExists(sid), false);
});
