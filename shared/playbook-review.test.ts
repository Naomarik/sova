// The proposed run in words (§app.project-runtime/review): the banner and the one button. Pure.
import assert from "node:assert/strict";
import { test } from "node:test";
import { reviewAction, reviewBanner, reviewDetail } from "./playbook-review";

const run = { label: "Project verbs", branch: "sova/v-1a2b3c", target: "main", hash: "sha256:0123456789abcdef", approved: false };

test("waiting for approval: Approve & Merge, and the banner says both steps", () => {
  assert.deepEqual(reviewBanner(run), { title: "Project verbs proposes 0123456789ab on sova/v-1a2b3c.", body: "Approve it and merge it into main." });
  assert.equal(reviewAction(run), "Approve & Merge");
  assert.equal(reviewDetail(run), "Project verbs: approve 0123456789ab and merge into main");
});

test("approved: Merge Branch; no valid definition: no button, read the report", () => {
  assert.equal(reviewAction({ ...run, approved: true }), "Merge Branch");
  assert.equal(reviewBanner({ ...run, approved: true }).body, "It is approved: merge it into main.");
  const none = { ...run, hash: undefined };
  assert.equal(reviewAction(none), null);
  assert.deepEqual(reviewBanner(none), { title: "Project verbs proposes changes on sova/v-1a2b3c.", body: "Its branch has no valid definition: read its report." });
});
