// Run: pnpm test -- src/lib/reply-stage.test.ts
// What a message's Reply stages (§chat.transcript/reply): the passage selected inside that one
// message, else the whole message, cut to what is sent.
import assert from "node:assert/strict";
import { test } from "node:test";
import { passageOf, replyFrom, type SelectionFacts } from "./reply-stage";
import { REPLY_ELISION } from "../../shared/reply-quote";

const sel = (text: string, ...ends: [string | null, boolean][]): SelectionFacts => ({ text, ends: ends.map(([entryId, inText]) => ({ entryId, inText })) });
const strip = { entryId: "a1b2c3d4", role: "assistant" as const, text: "## Plan\n\nStep one.\nStep two." };

test("a selection with both ends in this message's text is the passage", () => {
  assert.equal(passageOf(sel("Step one.", ["a1b2c3d4", true], ["a1b2c3d4", true]), "a1b2c3d4"), "Step one.");
});

test("anything else quotes the whole message: no selection, another message, outside its text, blank", () => {
  assert.equal(passageOf(null, "a1b2c3d4"), null);
  assert.equal(passageOf(sel("x", ["a1b2c3d4", true], ["ffff0000", true]), "a1b2c3d4"), null, "reaches into another message");
  assert.equal(passageOf(sel("x", ["a1b2c3d4", true], [null, false]), "a1b2c3d4"), null, "reaches outside the transcript");
  assert.equal(passageOf(sel("x", ["a1b2c3d4", false], ["a1b2c3d4", true]), "a1b2c3d4"), null, "starts in its head, quote or a tool card");
  assert.equal(passageOf(sel("  \n ", ["a1b2c3d4", true], ["a1b2c3d4", true]), "a1b2c3d4"), null);
  assert.equal(passageOf(sel("Step one.", ["ffff0000", true], ["ffff0000", true]), "a1b2c3d4"), null, "selected in another message");
});

test("replyFrom: the whole message, or the passage marked as part", () => {
  assert.deepEqual(replyFrom(strip, null), { entryId: "a1b2c3d4", role: "assistant", part: false, quote: strip.text, trimmed: false });
  assert.deepEqual(replyFrom(strip, " Step two. "), { entryId: "a1b2c3d4", role: "assistant", part: true, quote: " Step two.", trimmed: false });
  assert.equal(replyFrom({ ...strip, text: "   " }, null), null, "nothing to quote");
});

test("replyFrom: a long message is cut to its start and end, and says so", () => {
  const r = replyFrom({ ...strip, role: "user", text: "s".repeat(3000) + "m".repeat(5000) + "e".repeat(1000) }, null)!;
  assert.equal(r.trimmed, true);
  assert.ok(r.quote.includes(`\n${REPLY_ELISION}\n`));
  assert.equal(r.role, "user");
});
