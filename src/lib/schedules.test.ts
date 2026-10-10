// The schedule's one line in the Playbooks dialog and the permits panel (§chat.schedules/where-shown).
import assert from "node:assert/strict";
import { test } from "node:test";
import { canApprove, canRevoke, eventsText, scheduleLine } from "./schedules";
import { clockTime } from "./format";

const text = "Every 30 min · When a Claude limit resets";

test("each state reads as the schedule, then its state", () => {
  assert.equal(scheduleLine({ when: "x", text, state: "needs-approval", pin: "p" }), `${text} · Needs approval`);
  const next = new Date(Date.now() + 10 * 60_000).toISOString();
  assert.equal(scheduleLine({ when: "x", text, state: "active", id: "s1", next }), `${text} · Next ${clockTime(next)}`);
  assert.equal(scheduleLine({ when: "x", text: "When a Claude limit resets", state: "active", id: "s1" }), "When a Claude limit resets · Approved");
  assert.equal(scheduleLine({ when: "x", text, state: "paused", id: "s1", reason: "Changed since you approved it" }), `${text} · Paused: Changed since you approved it`);
  assert.equal(scheduleLine({ when: "x", text, state: "paused", id: "s1", reason: "Paused after 10 runs nobody opened." }), `${text} · Paused after 10 runs nobody opened.`);
  assert.equal(scheduleLine({ when: "every 10m", state: "invalid", reason: "every takes 30m" }), "Schedule not valid: every takes 30m");
  assert.equal(scheduleLine({ when: "daily 09:00", state: "not-project", reason: "Schedules run only from a project's playbooks." }), "Schedules run only from a project's playbooks.");
});

test("Approve applies to an unapproved or paused schedule with a pin; Revoke to an approved one", () => {
  assert.ok(canApprove({ when: "x", state: "needs-approval", pin: "p" }));
  assert.ok(!canApprove({ when: "x", state: "needs-approval" }), "no pin: nothing to approve");
  assert.ok(canApprove({ when: "x", state: "paused", pin: "p", id: "s1" }));
  assert.ok(!canApprove({ when: "x", state: "active", pin: "p", id: "s1" }));
  assert.ok(canRevoke({ when: "x", state: "active", id: "s1" }));
  assert.ok(canRevoke({ when: "x", state: "paused", id: "s1" }));
  assert.ok(!canRevoke({ when: "x", state: "needs-approval", id: "s1", pin: "p" }));
});

test("an approved schedule with only event triggers says when it runs", () => {
  assert.equal(eventsText({ when: "x", text: "When a Claude limit resets", state: "active", id: "s1" }), "Runs when a Claude limit resets.");
  assert.equal(eventsText({ when: "x", text: "When a branch is ready to merge", state: "active", id: "s1" }), "Runs when a branch is ready to merge.");
  assert.equal(eventsText({ when: "x", text: "When a Claude limit resets · When a branch is ready to merge", state: "active", id: "s1" }), "Runs when a Claude limit resets or when a branch is ready to merge.");
  assert.equal(scheduleLine({ when: "x", text: "When a branch is ready to merge · Every 6 hours", state: "needs-approval", pin: "p" }), "When a branch is ready to merge · Every 6 hours · Needs approval");
});
