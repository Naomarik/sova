import assert from "node:assert/strict";
import { test } from "node:test";
import type { DeployRecordView } from "../../shared/project-contract";
import { overridesAsked, planDeadline, recordLine, rollbackWord, tickProgress } from "./project-deploy";

// The Deploy panel's words (§app.project-runtime/deploy-panel).

const rec = (over: Partial<DeployRecordView>): DeployRecordView => ({
  id: "dp_0123456789abcdef",
  target: "prod",
  kind: "deploy",
  commit: "1a2b3c4d5e6f",
  planId: "pl_0123456789abcdef",
  deployHash: "sha256:ab",
  by: "operator",
  startedAt: "2026-10-04T10:00:00.000Z",
  endedAt: null,
  state: "running",
  steps: [],
  verify: null,
  overrides: {},
  ...over,
});

test("a record reads as what happened, the commit short", () => {
  assert.equal(recordLine(rec({}), 3), "Deploying 1a2b3c4 · step 1 of 3");
  assert.equal(recordLine(rec({ steps: [{ key: "steps.a", exit: 0, ms: 1 }] }), 3), "Deploying 1a2b3c4 · step 2 of 3");
  assert.equal(recordLine(rec({ state: "succeeded", verify: { url: "https://x.test/health", status: 200, ok: true, detail: "" } })), "Deployed 1a2b3c4 · https://x.test/health answered 200");
  assert.equal(recordLine(rec({ state: "failed", detail: "steps.sync exited with 3" })), "Deploy of 1a2b3c4 failed: steps.sync exited with 3");
  assert.equal(recordLine(rec({ kind: "rollback", state: "verify-failed", detail: "…/health answered 503, expected 200" })), "Rollback of 1a2b3c4 ran, and its verify failed: …/health answered 503, expected 200");
  assert.equal(recordLine(rec({ kind: "rollback", state: "succeeded" })), "Rolled back to 1a2b3c4");
});

test("ticks, deadline, rollback and the overrides a refusal asks for", () => {
  assert.deepEqual(tickProgress({ keys: ["a", "b", "c"] }, new Set(["a"])), { left: 2, line: "1 of 3 steps ticked" });
  assert.deepEqual(tickProgress({ keys: ["a"] }, new Set(["a"])), { left: 0, line: "Every step ticked." });
  const now = Date.parse("2026-10-04T10:00:00.000Z");
  assert.equal(planDeadline("2026-10-04T10:14:30.000Z", now), "Expires in 15 min");
  assert.equal(planDeadline("2026-10-04T09:59:00.000Z", now), "Expired: plan again");
  assert.equal(rollbackWord({ rollback: { none: "x" }, verifiedCommit: null }), null);
  assert.equal(rollbackWord({ rollback: "redeploy-previous", verifiedCommit: "a" }), "Deploys the last verified commit before this one again.");
  assert.deepEqual(overridesAsked("Not planned: the required tests failed (give overrideTests: your reason)."), { tests: true, dirty: false });
});
