import assert from "node:assert/strict";
import { test } from "node:test";
import { needsYouCount, needsYouLabel, orgCountsLine } from "./org-cards";

test("needsYouCount sums the kinds; absent is 0", () => {
  assert.equal(needsYouCount(undefined), 0);
  assert.equal(needsYouCount({ replies: 0, links: 0, proposals: 0, conflicts: 0 }), 0);
  assert.equal(needsYouCount({ replies: 2, links: 1, proposals: 3, conflicts: 1 }), 7);
});

test("needsYouLabel names each kind that waits, singular and plural", () => {
  assert.equal(needsYouLabel(undefined), "");
  assert.equal(needsYouLabel({ replies: 0, links: 0, proposals: 0, conflicts: 0 }), "");
  assert.equal(needsYouLabel({ replies: 1, links: 0, proposals: 0, conflicts: 0 }), "1 reply");
  assert.equal(needsYouLabel({ replies: 2, links: 1, proposals: 0, conflicts: 0 }), "2 replies · 1 link to send");
  assert.equal(needsYouLabel({ replies: 0, links: 2, proposals: 1, conflicts: 2 }), "2 links to send · 1 person to approve · 2 conflicts to settle");
  assert.equal(needsYouLabel({ replies: 0, links: 0, proposals: 3, conflicts: 0 }), "3 people to approve");
});

test("orgCountsLine", () => {
  assert.equal(orgCountsLine({ people: 1, projects: 0, openBatons: 1 }), "1 person · 0 projects · 1 open hand-off");
  assert.equal(orgCountsLine({ people: 4, projects: 2, openBatons: 0 }), "4 people · 2 projects · 0 open hand-offs");
});
