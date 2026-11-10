// Run: npx tsx --test src/lib/draft-mark.test.ts (or npm test)
import assert from "node:assert/strict";
import { test } from "node:test";
import { draftCounts, showsDraftMark } from "./draft-mark";

test("draftCounts: blank text is no draft; any words or any image is one", () => {
  assert.equal(draftCounts("", []), false);
  assert.equal(draftCounts("  \n\t ", []), false, "whitespace-only text is no draft");
  assert.equal(draftCounts("", [{}]), true, "an image-only draft is one");
  assert.equal(draftCounts(" \n", [{}, {}]), true);
  assert.equal(draftCounts("fix it", []), true);
});

test("showsDraftMark: this tab's answer wins over the listing in both directions", () => {
  assert.equal(showsDraftMark({ hasDraft: true }, false), false, "sent or cleared here: gone before the refetch");
  assert.equal(showsDraftMark({}, true), true, "typed here: shown before the refetch");
  assert.equal(showsDraftMark({ hasDraft: true }, true), true);
  assert.equal(showsDraftMark({}, false), false);
});

test("showsDraftMark: with no local answer the listing decides", () => {
  assert.equal(showsDraftMark({ hasDraft: true }, undefined), true);
  assert.equal(showsDraftMark({}, undefined), false);
});

test("showsDraftMark: a never-sent session's row keeps its pencil on line 2 only", () => {
  assert.equal(showsDraftMark({ hasDraft: true, draftPreview: "idea" }, undefined), false);
  assert.equal(showsDraftMark({ hasDraft: true, draftPreview: "idea" }, true), false);
  assert.equal(showsDraftMark({ draftPreview: "2 images" }, true), false);
});

test("a staged reply alone is a draft, so a card's button and a palette command wait for it (§chat.composer/replying)", async () => {
  const { chatBlocked, REASON } = await import("./palette");
  const reply = { entryId: "1a2b3c4d", role: "assistant", part: false, quote: "q", trimmed: false };
  assert.equal(draftCounts("", [], reply), true);
  assert.equal(draftCounts("", [], null), false);
  // The composer registers exactly this as its hasDraft (Composer.tsx, registerComposer and onDraft).
  const composer = { commands: [], off: null, hasDraft: draftCounts("", [], reply), hideTools: false, hideThinking: false, playbooks: true, undo: null };
  assert.equal(chatBlocked(composer), REASON.draft);
});
