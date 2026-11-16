// The Creative Director's chat with its prompt items: each item stands in time order among the
// messages, the tool call that made it (and its result) shows once, as the item, and a Full Prompt
// revision says what changed from the one before it in the same run.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { DesignHistoryItem } from "../../shared/design";
import type { TranscriptItem } from "../../shared/protocol";
import { foldedCalls, historyLine, historyRows, lookbookItemOf, mergeHistory, promptChanges } from "./lookbook-history";

const at = (s: number) => new Date(Date.UTC(2026, 10, 16, 12, 0, s)).toISOString();
const row = (id: string, s: number | null, over: Partial<TranscriptItem> = {}): TranscriptItem => ({ id, kind: "assistant-text", ...(s === null ? {} : { at: at(s) }), ...over }) as TranscriptItem;
const h = (id: string, s: number, over: Partial<DesignHistoryItem>): DesignHistoryItem => ({ id, at: at(s), kind: "message", by: "coordinator", ...over });

test("items stand in time order among the messages; the calls they show, and their results, go", () => {
  const items = [
    h("h1", 5, { kind: "prompt", rev: 1, text: "A", runId: "r", toolCallId: "c1" }),
    h("h2", 15, { label: "B", via: "chat", by: "user", text: "Bigger." }),
    h("h3", 40, { label: "B", via: "coordinator", text: "Go.", toolCallId: "c2" }),
  ];
  const rows = [
    row("u", 1, { kind: "user" }),
    row("call1", 5, { kind: "tool-call", toolCallId: "c1" }),
    row("res1", 6, { kind: "tool-result", toolCallId: "c1" }),
    row("a", 10),
    row("untimed", null),
    row("b", 20),
    row("call2", 40, { kind: "tool-call", toolCallId: "c2" }),
    row("other", 41, { kind: "tool-call", toolCallId: "c9" }),
  ];
  const out = mergeHistory(rows, historyRows(items), foldedCalls(items)).map((r) => r.id);
  assert.deepEqual(out, ["u", "lookbook-h1", "a", "untimed", "lookbook-h2", "b", "lookbook-h3", "other"]);
  // Nothing in the history: the chat as it is.
  assert.deepEqual(mergeHistory(rows, [], new Set()).map((r) => r.id), rows.map((r) => r.id));
  // An item after the last row goes at the end.
  assert.deepEqual(mergeHistory([row("x", 1)], historyRows([h("h9", 99, {})]), new Set()).map((r) => r.id), ["x", "lookbook-h9"]);
});

test("each Full Prompt revision knows the one before it in its own run only", () => {
  const rows = historyRows([
    h("h1", 1, { kind: "prompt", runId: "r1", rev: 1, text: "one" }),
    h("h2", 2, { kind: "prompt", runId: "r2", rev: 1, text: "other run" }),
    h("h3", 3, { kind: "prompt", runId: "r1", rev: 2, text: "two" }),
  ]);
  assert.deepEqual(rows.map((r) => lookbookItemOf(r)!.prev), [undefined, undefined, "one"]);
});

test("what changed lists only the lines that did, removed and added, with lines common to both left out", () => {
  const prev = "Title\nMenu: 8 items\nHours\nFooter";
  const next = "Title\nMenu: 6 items max\nHours\nA map\nFooter";
  assert.deepEqual(promptChanges(prev, next), [
    { sign: "−", line: "Menu: 8 items" },
    { sign: "+", line: "Menu: 6 items max" },
    { sign: "+", line: "A map" },
  ]);
  assert.deepEqual(promptChanges("same", "same"), []);
  assert.deepEqual(promptChanges("", "new"), [{ sign: "+", line: "new" }]);
});

test("each item's line names what happened and who did it", () => {
  assert.equal(historyLine(h("h", 0, { kind: "prompt", rev: 2, by: "coordinator" })).title, "Full Prompt · revision 2 · by the Creative Director");
  assert.equal(historyLine(h("h", 0, { kind: "prompt", rev: 3, by: "user" })).title, "Full Prompt · revision 3 · yours");
  const start = historyLine(h("h", 0, { kind: "start", by: "user", rev: 2, designs: [{ label: "A", direction: "Playful", model: "m" }, { label: "B", direction: "Calm", layout: "Grid", model: "m" }, { label: "C", direction: "Bold", model: "m" }] }));
  assert.deepEqual(start, { title: "Started A, B and C", preview: "Full Prompt revision 2, each with its own style and layout" });
  assert.equal(historyLine(h("h", 0, { label: "B", by: "user", via: "refine", text: "Bigger hours." })).title, "To B · your Refine");
  assert.equal(historyLine(h("h", 0, { label: "B", by: "user", via: "chat", text: "x" })).title, "To B · from you");
  assert.deepEqual(historyLine(h("h", 0, { label: "C", by: "server", via: "fix", text: "Your page didn't land…" })), { title: "To C · from Sova", preview: "Its page didn't land; asked to fix it" });
  assert.equal(historyLine(h("h", 0, { label: "B", text: "\n\nKeep it calm.\nMore" })).preview, "Keep it calm.");
  assert.equal(historyLine(h("h", 0, { kind: "new", label: "D", parents: ["A", "C"], text: "Mix them." })).title, "D made from A and C");
  assert.equal(historyLine(h("h", 0, { kind: "new", label: "E", parents: [], text: "x" })).title, "E made from the brief");
  assert.equal(historyLine(h("h", 0, { kind: "stop", label: "B", by: "user" })).title, "Stopped B · by you");
});
