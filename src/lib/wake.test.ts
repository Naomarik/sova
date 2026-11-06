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

test("a job card carries when its job ended, the latest of several; a card from before that line has none", async () => {
  const { jobCardText } = await import("../../pi-config/extensions/subagents/job-store.ts");
  type JobRecord = import("../../pi-config/extensions/subagents/job-store.ts").JobRecord;
  const job = (id: string, endedAt: number): JobRecord => ({ v: 1, id, sessionId: "s", path: "/s.jsonl", kind: "kept", command: "make lab > lab.log &", cwd: "/w", unit: "u", driver: "systemd", startedAt: endedAt - 300_000, bootId: "b", output: "/w/lab.log", ended: { at: endedAt, how: "exited", card: "wake" } });
  const end = Date.parse("2026-11-04T14:32:05.000Z");
  const one = jobCardText([job("j1", end)], {});
  assert.match(one, /\nEnded at 2026-11-04T14:32:05\.000Z\.\n/);
  assert.deepEqual(parseWakeNudge(one), { id: "j1", job: true, reason: "make lab > lab.log &", endedAt: end });
  // Late: the end time is still the job's, not the delivery's.
  assert.equal(parseWakeNudge(jobCardText([job("j1", end)], { late: 3_600_000 }))?.endedAt, end);
  const two = jobCardText([job("j1", end + 60_000), job("j2", end)], {});
  assert.equal(parseWakeNudge(two)?.endedAt, end + 60_000);
  // An older row: no end line, so no end time (the card shows its arrival), and it still parses.
  const old = "[job j1] Background job ended.\nj1: `make lab > lab.log &`, ran 5m.\nOutput: /w/lab.log\nIt ended on its own; its output says whether it worked.\nRead its output and decide what to do next. Prioritize any newer user message.";
  assert.deepEqual(parseWakeNudge(old), { id: "j1", job: true, reason: "make lab > lab.log &" });
  // Only the card's own line counts, never a quoted lookalike in the command.
  assert.equal(parseWakeNudge("[job j1] Background job ended.\nj1: `echo Ended at 2026-01-01T00:00:00.000Z.`, ran 1m.")?.endedAt, undefined);
});
