// An open Lookbook view's chat on a phone starts folded to a bar, every time; the bar shows the newest
// message from the transcript's first snapshot while still folded; and folding never unmounts the chat,
// so the words typed in its box (and its scroll place) are still there when it shows again.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import type { TranscriptItem } from "../../shared/protocol";
if (!import.meta.resolve("solid-js").endsWith("/dist/solid.js")) throw new Error("run with --conditions=browser (the *.browser.test.ts invocation)");

const solid = await import("solid-js");
const { createChatFold } = await import("./design-chat-fold");
const { latestMessageRow } = await import("./design-chat-bar");

const row = (id: string, over: Partial<TranscriptItem>): TranscriptItem => ({ id, kind: "assistant-text", ...over }) as TranscriptItem;

test("folded at first, every view; the first snapshot's newest message is on the bar before anything is shown", () => {
  solid.createRoot((dispose) => {
    const fold = createChatFold();
    assert.equal(fold.folded(), true);
    assert.equal(fold.line("B"), null, "no rows yet: the bar says Message B");
    // As WorkerTranscript reports it on the first snapshot.
    const snapshot = [row("1", { kind: "user", text: "Move the hero up." }), row("2", { text: "Moved the hero up. Saved as B v2." }), row("3", { kind: "tool-call", text: "write" })];
    fold.onLatest(latestMessageRow(snapshot, "B"));
    assert.deepEqual(fold.line("B"), { who: "B", text: "Moved the hero up. Saved as B v2." });
    assert.equal(fold.folded(), true, "still folded: the line came without showing the chat");
    fold.setFolded(false);
    fold.setFolded(true);
    assert.deepEqual(fold.line("B"), { who: "B", text: "Moved the hero up. Saved as B v2." }, "folding again keeps the line");
    assert.equal(createChatFold().folded(), true, "a new view starts folded again: nothing remembered");
    dispose();
  });
});

test("the chat under the bar stays mounted: no Show unmounts it, folding only stops drawing it", () => {
  const src = readFileSync(new URL("../components/DesignOpen.tsx", import.meta.url), "utf8");
  const view = src.slice(src.indexOf("export function DesignOpen("), src.indexOf("export function DesignOpenSlot"));
  assert.equal((view.match(/<ChatPane\b/g) ?? []).length, 2, "the design's chat and the Creative Director's");
  // Each ChatPane's nearest enclosing Show is the one for its record, never one on the chat's state.
  for (const at of [...view.matchAll(/<ChatPane\b/g)].map((m) => m.index!)) {
    const shows = [...view.slice(0, at).matchAll(/<Show when=\{([^}]*)\}/g)].map((m) => m[1]);
    assert.ok(!/hideChat|fold/i.test(shows.at(-1)!), `ChatPane sits under <Show when={${shows.at(-1)}}>`);
  }
  assert.ok(!/<Show when=\{!?(hideChat|chat\.folded)\(\)\}/.test(view), "no Show keyed on the chat's hidden or folded state");
  const css = readFileSync(new URL("../components/DesignCard.css", import.meta.url), "utf8");
  const folded = css.match(/\.design-open-body\[data-fold="folded"\] \.design-open-chat-body \{([^}]*)\}/);
  assert.ok(folded && /visibility:\s*hidden/.test(folded[1]!) && !/display:\s*none/.test(folded[1]!), "folded keeps the chat laid out, only not drawn");
});
