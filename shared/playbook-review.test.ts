// The proposed run in words (§app.project-runtime/review): the banner and the one button. Pure.
import assert from "node:assert/strict";
import { test } from "node:test";
import { reviewAction, reviewBanner, reviewDetail } from "./playbook-review";

const run = { label: "Project verbs", branch: "sova/v-1a2b3c", target: "main", hash: "sha256:0123456789abcdef" };

test("a valid proposal: Merge Branch, and the banner says to read it and merge it", () => {
  assert.deepEqual(reviewBanner(run), { title: "Project verbs proposes 0123456789ab on sova/v-1a2b3c.", body: "Read it, then merge it into main." });
  assert.equal(reviewAction(run), "Merge Branch");
  assert.equal(reviewDetail(run), "Project verbs: merge 0123456789ab into main");
});

test("no valid definition: no button, read the report", () => {
  const none = { ...run, hash: undefined };
  assert.equal(reviewAction(none), null);
  assert.deepEqual(reviewBanner(none), { title: "Project verbs proposes changes on sova/v-1a2b3c.", body: "Its branch has no valid definition: read its report." });
});

test("a deploy-setup run's proposal is its deploy recipe", () => {
  const dep = { ...run, proposes: "deploy" as const, hash: undefined };
  assert.equal(reviewDetail(dep), "Project verbs: its branch sova/v-1a2b3c has no valid deploy recipe: read its report");
  assert.equal(reviewBanner(dep).body, "Its branch has no valid deploy recipe: read its report.");
});
