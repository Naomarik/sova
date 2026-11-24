// Run: npx tsx --test src/lib/updates.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import type { UpdateJob, UpdateTarget } from "../../shared/protocol";
import { goBackLabel, resultLine, upgradedLine, withdrawnTitle } from "./updates";

const target: UpdateTarget = { sha: "a".repeat(40), label: "v0.9.0", version: "v0.9.0", count: null } as UpdateTarget;

test("a copy on a withdrawn release is told so with the reason, never 'ahead', and offered to go back", () => {
  const r = { state: "withdrawn" as const, tag: "v0.10.0", why: "breaks settings on upgrade.", at: "2026-11-03T10:00:00Z", target, message: "v0.10.0 was withdrawn" };
  assert.equal(resultLine(r, { kind: "stable" }), "Stable is back on v0.9.0.");
  assert.equal(withdrawnTitle(r), "v0.10.0 was withdrawn: breaks settings on upgrade.");
  assert.equal(goBackLabel(target), "Go Back to v0.9.0");
});

test("a successful upgrade is one quiet line for a day; any other job has none", () => {
  const now = Date.parse("2026-11-23T12:00:00Z");
  const job = { id: "j", kind: "installer", from: { sha: null, label: "v0.17.1" }, to: { sha: "b".repeat(40), label: "v0.18.0" }, auto: false, startedAt: "2026-11-23T09:55:00Z", step: "done", state: "succeeded", detail: "Upgraded to v0.18.0.", logPath: "/x/log.txt", endedAt: "2026-11-23T10:00:00Z" } as const satisfies UpdateJob;
  assert.equal(upgradedLine(job, now), "Upgraded to v0.18.0 2h ago.");
  assert.equal(upgradedLine(job, Date.parse("2026-11-24T10:00:01Z")), null, "past a day");
  for (const state of ["failed", "rolled-back", "running"] as const) assert.equal(upgradedLine({ ...job, state }, now), null, state);
  assert.equal(upgradedLine(null, now), null);
});
