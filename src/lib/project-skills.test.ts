import assert from "node:assert/strict";
import { test } from "node:test";
import { approveAllChange, shortDescription, sourceLabel, waitingNotice, waitingSkills } from "./project-skills";

test("the waiting notice counts in digits and is absent when nothing waits", () => {
  assert.equal(waitingNotice(0), null);
  assert.equal(waitingNotice(1), "1 skill to approve for this project.");
  assert.equal(waitingNotice(3), "3 skills to approve for this project.");
});

test("a source names its folder only when it has one", () => {
  assert.equal(sourceLabel({ kind: "project" }), "Project");
  assert.equal(sourceLabel({ kind: "subfolder", folder: "packages/api" }), "Subfolder · packages/api");
  assert.equal(sourceLabel({ kind: "user" }), "Your skills");
  assert.equal(sourceLabel({ kind: "claude" }), "Claude folder");
});

test("a description is one line, cut with an ellipsis past its limit", () => {
  assert.equal(shortDescription("a\n  b"), "a b");
  assert.equal(shortDescription(undefined), "");
  const cut = shortDescription("x".repeat(200), 10);
  assert.equal(cut.length, 10);
  assert.ok(cut.endsWith("…"));
});

test("Approve All approves exactly the waiting skills, in one change", () => {
  const skills = [
    { name: "alpha", project: "approved" as const },
    { name: "beta", project: "disallowed" as const },
    { name: "delta", project: "waiting" as const },
    { name: "free" },
    { name: "gamma", project: "waiting" as const },
  ];
  const names = waitingSkills(skills);
  assert.deepEqual(names, ["delta", "gamma"]);
  assert.deepEqual(approveAllChange(names), { delta: "approved", gamma: "approved" });
  // Nothing waits: no notice, and nothing to send.
  assert.deepEqual(waitingSkills(skills.filter((k) => k.project !== "waiting")), []);
  assert.deepEqual(approveAllChange([]), {});
});
