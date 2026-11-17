// A folded chat's bar names the newest message: who wrote it and its words on one plain line. Rows
// that aren't a message (tools, Sova's notes, a design's brief, prompt items) never take the bar.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { TranscriptItem } from "../../shared/protocol";
import { chatBarLine, latestMessageRow } from "./design-chat-bar";

const row = (id: string, over: Partial<TranscriptItem>): TranscriptItem => ({ id, kind: "assistant-text", ...over }) as TranscriptItem;
const bar = (rows: TranscriptItem[], author = "B") => chatBarLine(latestMessageRow(rows, author), author);

test("each kind of row: who the bar names, or passed over for the message before it", () => {
  const before = row("0", { text: "Earlier reply." });
  const cases: [TranscriptItem, string | null][] = [
    [row("a", { text: "Moved the hero up." }), "B"],
    [row("u", { kind: "user", text: "Make it wider." }), "You"],
    [row("y", { kind: "user", text: "<<<wrapped>>>", lookbook: { from: "you", where: "chat", words: "Bigger cards." } }), "You"],
    [row("c", { kind: "user", text: "<<<wrapped>>>", lookbook: { from: "coordinator", words: "Try a serif." } }), "Creative Director"],
    [row("s", { kind: "user", text: "fix it", lookbook: { from: "sova", note: "Its page didn't land." } }), null],
    [row("b", { kind: "user", text: "brief", lookbook: { from: "brief", note: "The brief" } }), null],
    [row("t", { kind: "tool-call", text: "write" }), null],
    [row("r", { kind: "tool-result", text: "ok" }), null],
    [row("th", { kind: "thinking", text: "hmm" }), null],
    [row("i", { kind: "info", text: "prompt item" }), null],
    [row("e", { text: "   " }), null],
  ];
  for (const [r, who] of cases) assert.equal(bar([before, r])?.who, who ?? "B", `${r.id}: ${who ?? "passed over"}`);
  assert.equal(bar([row("s", { kind: "user", text: "x", lookbook: { from: "sova", note: "n" } })]), null, "no message at all: the bar says Message B");
  assert.equal(bar([]), null);
});

test("the line is the message's words alone, markdown's marks off, on one line", () => {
  assert.deepEqual(bar([row("a", { text: "## Done\n\n- Moved the **hero** up\n- Widened `cards`; see [the page](http://x)." })]), { who: "B", text: "Done Moved the hero up Widened cards; see the page." });
  assert.equal(bar([row("y", { kind: "user", text: "The user wrote in your box:\n<<<u-0123456789ab\nSmaller.", lookbook: { from: "you", words: "Smaller." } })])?.text, "Smaller.", "a person's own words, never the wrapper the model read");
});
