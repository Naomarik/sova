import assert from "node:assert/strict";
import { test } from "node:test";
import { parseWakeNudge, wakeTitle } from "../../shared/wake";

test("parseWakeNudge reads the tag and id", () => {
  const text = "[wake_nudge n1] Scheduled wakeup fired (set 4m17s ago).\nReason: (none)\nContinue.";
  const nudge = parseWakeNudge(text);
  assert.deepEqual(nudge, { id: "n1" });
});

test("parseWakeNudge reads a late fire", () => {
  const text = [
    "[wake_nudge n3] Scheduled wakeup fired (set 10m ago).",
    "Overdue by 3m17s (pi was not running).",
    "Reason: check the build",
    "Continue the pending work.",
  ].join("\n");
  assert.deepEqual(parseWakeNudge(text), { id: "n3", late: "3m17s", reason: "check the build" });
});

test("parseWakeNudge reads a reason", () => {
  const text = "[wake_nudge n2] Scheduled wakeup fired (set 1m ago).\nReason: poll the deploy\nContinue.";
  assert.deepEqual(parseWakeNudge(text), { id: "n2", reason: "poll the deploy" });
});

test('parseWakeNudge treats "Reason: (none)" as no reason', () => {
  const text = "[wake_nudge n1] Scheduled wakeup fired (set 1m ago).\nReason: (none)\nContinue.";
  assert.deepEqual(parseWakeNudge(text), { id: "n1" });
});

test("parseWakeNudge rejects empty or undefined text", () => {
  assert.equal(parseWakeNudge(""), null);
  assert.equal(parseWakeNudge(undefined), null);
  assert.equal(parseWakeNudge(null), null);
});

test("parseWakeNudge rejects an ordinary message", () => {
  assert.equal(parseWakeNudge("Please style the wake nudge card."), null);
});

test("parseWakeNudge ignores the tag on a later line", () => {
  const text = "Here's what fired:\n[wake_nudge n1] Scheduled wakeup fired (set 1m ago).\nReason: (none)";
  assert.equal(parseWakeNudge(text), null);
});

test("parseWakeNudge tolerates CRLF and extra spaces", () => {
  const text = "[wake_nudge n5] Scheduled wakeup fired (set 2m ago).\r\nReason:   spaced reason  \r\nContinue.";
  assert.deepEqual(parseWakeNudge(text), { id: "n5", reason: "  spaced reason" });
});

test("wakeTitle names the nudge", () => {
  assert.equal(wakeTitle({ id: "n1" }), "Wake nudge n1");
});
