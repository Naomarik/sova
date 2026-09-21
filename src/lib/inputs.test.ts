import assert from "node:assert/strict";
import { test } from "node:test";
import type { TranscriptItem } from "../../shared/protocol";
import { displayRows, IDLE, inputPreview, inputRows, rewoundAt, rowAction, sentSince, stepRewind, viewRows, type InputRow, type RewindPhase, type ViewRow } from "./inputs";

const user = (id: string, text?: string, images = 0): TranscriptItem => ({
  id,
  kind: "user",
  text,
  images: images ? Array.from({ length: images }, () => "data:image/png;base64,") : undefined,
  raw: { type: "message", id, timestamp: `2026-09-21T10:0${id.length}:00Z` },
});
const other = (id: string, kind: TranscriptItem["kind"]): TranscriptItem => ({ id, kind, text: "x", raw: {} });
const rows = (...ids: string[]): InputRow[] => inputRows(ids.map((id) => user(id, id)));

test("inputRows keeps user rows only, in order, with the entry id and timestamp", () => {
  const got = inputRows([user("a", "first"), other("a1:0", "assistant-text"), other("t", "tool-call"), user("b", "second")]);
  assert.deepEqual(got.map((r) => r.id), ["a", "b"]);
  assert.equal(got[0]!.at, "2026-09-21T10:01:00Z");
});

test("inputRows previews the first line with whitespace collapsed", () => {
  const [r] = inputRows([user("a", "  fix   the\tbug\nand then more\n")]);
  assert.equal(r!.preview, "fix the bug");
  assert.equal(r!.text, "  fix   the\tbug\nand then more\n");
});

test("inputPreview names image-only and empty messages", () => {
  assert.equal(inputPreview(inputRows([user("a", "", 1)])[0]!), "1 image");
  assert.equal(inputPreview(inputRows([user("a", undefined, 2)])[0]!), "2 images");
  assert.equal(inputPreview(inputRows([user("a")])[0]!), "Empty message");
});

test("rewoundAt abandons the target and everything after it", () => {
  const r = rewoundAt(rows("a", "b", "c"), "b")!;
  assert.equal(r.boundary, "b");
  assert.deepEqual(r.abandoned.map((x) => x.id), ["b", "c"]);
  assert.equal(rewoundAt(rows("a"), "zz"), null);
});

test("viewRows shows the branch, then the abandoned rows with the boundary first", () => {
  const r = rewoundAt(rows("a", "b", "c"), "b");
  // A fetch from before the rewind still has b and c: each shows once.
  const stale = viewRows(rows("a", "b", "c"), r);
  const fresh = viewRows(rows("a"), r);
  for (const v of [stale, fresh]) {
    assert.deepEqual(
      v.map((x) => [x.id, x.state]),
      [
        ["a", "active"],
        ["b", "boundary"],
        ["c", "abandoned"],
      ],
    );
  }
});

test("the abandoned rows drop once the user sends again", () => {
  const r = rewoundAt(rows("a", "b", "c"), "b")!;
  assert.equal(sentSince(rows("a"), r), false);
  assert.equal(sentSince(rows("a", "d"), r), true);
  assert.deepEqual(viewRows(rows("a", "d"), r).map((x) => [x.id, x.state]), [
    ["a", "active"],
    ["d", "active"],
  ]);
  assert.deepEqual(viewRows(rows("a"), null).map((x) => x.state), ["active"]);
});

test("rewinding to the first message leaves only abandoned rows", () => {
  const r = rewoundAt(rows("a", "b"), "a");
  assert.deepEqual(viewRows([], r).map((x) => x.state), ["boundary", "abandoned"]);
});

test("stepRewind: ask, confirm, settle", () => {
  let p: RewindPhase = stepRewind(IDLE, { type: "ask", id: "a" });
  assert.deepEqual(p, { kind: "confirm", id: "a" });
  assert.deepEqual(stepRewind(p, { type: "cancel" }), IDLE);
  assert.deepEqual(stepRewind(p, { type: "ask", id: "b" }), { kind: "confirm", id: "b" });
  p = stepRewind(p, { type: "confirm" });
  assert.deepEqual(p, { kind: "pending", id: "a" });
  assert.deepEqual(stepRewind(p, { type: "settled", result: { ok: true, text: "hi" } }), IDLE);
  const failed = stepRewind(p, { type: "settled", result: { ok: false, reason: "streaming", message: "Stop first." } });
  assert.deepEqual(failed, { kind: "failed", id: "a", error: "Stop first." });
  // A failure clears on the next question or a cancel.
  assert.deepEqual(stepRewind(failed, { type: "ask", id: "b" }), { kind: "confirm", id: "b" });
  assert.deepEqual(stepRewind(failed, { type: "cancel" }), IDLE);
});

test("stepRewind: nothing interrupts a pending rewind, and confirm needs a question", () => {
  const pending: RewindPhase = { kind: "pending", id: "a" };
  assert.equal(stepRewind(pending, { type: "ask", id: "b" }), pending);
  assert.equal(stepRewind(pending, { type: "cancel" }), pending);
  assert.equal(stepRewind(IDLE, { type: "confirm" }), IDLE);
  assert.equal(stepRewind(IDLE, { type: "settled", result: { ok: true, text: "" } }), IDLE);
});

test("rowAction: blocked, pending, and off-branch rows carry their reason", () => {
  const row = (state: ViewRow["state"]): ViewRow => ({ ...rows("a")[0]!, state });
  assert.deepEqual(rowAction(row("active"), null, IDLE), { enabled: true, reason: null });
  assert.deepEqual(rowAction(row("active"), "streaming", IDLE), { enabled: false, reason: "Stop the current turn first." });
  assert.equal(rowAction(row("active"), "live", IDLE).enabled, false);
  assert.deepEqual(rowAction(row("active"), "compacting", IDLE), { enabled: false, reason: "Wait for the compaction to finish." });
  assert.equal(rowAction(row("active"), null, { kind: "pending", id: "b" }).reason, "A rewind is already in progress.");
  assert.equal(rowAction(row("boundary"), null, IDLE).enabled, false);
  assert.equal(rowAction(row("abandoned"), null, IDLE).enabled, false);
});

test("a fresh session lists nothing: the empty state's condition", () => {
  assert.deepEqual(inputRows([]), []);
  assert.deepEqual(viewRows([], null), []);
  // Only assistant/tool rows: still nothing to rewind to.
  assert.deepEqual(inputRows([other("a:0", "assistant-text"), other("t", "tool-result")]), []);
});

test("rewinding to the first input leaves the branch empty, and the row is the boundary", () => {
  const before = rows("a", "b");
  const r = rewoundAt(before, "a")!;
  assert.deepEqual(r.abandoned.map((x) => x.id), ["a", "b"]);
  // The server answers an empty branch, so the next fetch has no user rows at all.
  const view = viewRows([], r);
  assert.deepEqual(view.map((x) => [x.id, x.state]), [["a", "boundary"], ["b", "abandoned"]]);
  // Nothing on an abandoned row can act.
  assert.equal(rowAction(view[0]!, null, IDLE).enabled, false);
  assert.equal(rowAction(view[1]!, null, IDLE).enabled, false);
});

test("displayRows lists newest first, so the latest message is at the top", () => {
  const chron = rows("a", "b", "c");
  assert.deepEqual(displayRows(chron, null).map((r) => r.id), ["c", "b", "a"]);
  // Newest by the session's own order, which is the transcript's order, not a re-sort by clock.
  assert.deepEqual(viewRows(chron, null).map((r) => r.id), ["a", "b", "c"]);
  assert.deepEqual(displayRows([], null), []);
});

test("newest first puts the rewind's abandoned rows ABOVE the boundary row", () => {
  const r = rewoundAt(rows("a", "b", "c", "d"), "c");
  // Rewound to before c: c is the boundary, d came after it. Top to bottom: d, c, then the branch.
  assert.deepEqual(displayRows(rows("a", "b"), r).map((x) => [x.id, x.state]), [
    ["d", "abandoned"],
    ["c", "boundary"],
    ["b", "active"],
    ["a", "active"],
  ]);
});
