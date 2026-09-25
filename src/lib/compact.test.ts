// Run: npx tsx --test src/lib/compact.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { COMPACT_COMMAND, compactCommand } from "../../shared/compact";
import { COMPACT_IMAGES_REFUSAL } from "../../shared/compact";
import { compactedAnnouncement } from "./compact";

test("only a WHOLE /compact message is one, with its instructions trimmed", () => {
  assert.deepEqual(compactCommand("/compact"), {});
  assert.deepEqual(compactCommand("  /compact  "), {});
  assert.deepEqual(compactCommand("/compact keep the API decisions"), { instructions: "keep the API decisions" });
  assert.deepEqual(compactCommand("/compact\n  keep\n  both lines "), { instructions: "keep\n  both lines" });
  for (const text of ["/compacting", "/compact-now", "please /compact", "/Compact", "compact", "", "/ compact"])
    assert.equal(compactCommand(text), null, JSON.stringify(text));
});

test("the builtin row the menu lists is the name the parser reads", () => {
  assert.equal(COMPACT_COMMAND.source, "builtin");
  assert.deepEqual(compactCommand(`/${COMPACT_COMMAND.name}`), {});
});

test("the images refusal is one the menu's own copy can say", () => {
  assert.equal(COMPACT_IMAGES_REFUSAL, "Send /compact without images.");
});

test("the landed announcement names the count only when there is one", () => {
  assert.equal(compactedAnnouncement(123456), "Compacted 123,456 tokens of context.");
  assert.equal(compactedAnnouncement(0), "Compacted.");
});
