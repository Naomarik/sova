// Run: npx tsx --test src/lib/push-draft.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import type { PushSettings } from "../../shared/protocol";
import { pushDraftProblem, rebasePush, samePush, toPushDraft } from "./push-draft";

const base: PushSettings = {
  version: 1,
  enabled: true,
  contact: null,
  kinds: { "needs-input": true, "open-questions": true, error: true, "baton-needs-you": true, "worker-error": false, "playbook-review": true, "whatsapp-down": true },
  quietHours: { enabled: false, start: "22:00", end: "07:00" },
};

test("a rebase keeps the user's edits and follows the file everywhere else, per kind", () => {
  const mine = { ...toPushDraft(base), contact: "mailto:ops@example.test", kinds: { ...base.kinds, error: false } };
  const fresh: PushSettings = { ...base, enabled: false, kinds: { ...base.kinds, "worker-error": true }, quietHours: { enabled: true, start: "23:00", end: "06:00" } };
  const r = rebasePush(mine, base, fresh);
  assert.equal(r.contact, "mailto:ops@example.test");
  assert.equal(r.enabled, false);
  assert.equal(r.kinds.error, false);
  assert.equal(r.kinds["worker-error"], true);
  assert.deepEqual(r.quietHours, fresh.quietHours);
  assert.equal(samePush(toPushDraft(fresh), fresh), true);
  assert.equal(samePush(r, fresh), false);
  // A blank contact is none.
  assert.equal(samePush({ ...toPushDraft(base), contact: "  " }, base), true);
});

test("Save waits for a valid contact and quiet hours, naming the form", () => {
  assert.equal(pushDraftProblem(toPushDraft(base)), null);
  assert.match(pushDraftProblem({ ...toPushDraft(base), contact: "ops@example.test" })!, /^Phone Notifications: .*mailto:/);
  assert.match(pushDraftProblem({ ...toPushDraft(base), quietHours: { enabled: true, start: "07:00", end: "07:00" } })!, /same time/);
  assert.match(pushDraftProblem({ ...toPushDraft(base), quietHours: { enabled: true, start: "", end: "07:00" } })!, /start and an end/);
});
