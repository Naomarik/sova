import assert from "node:assert/strict";
import { test } from "node:test";
import type { DeployRecordView } from "../../shared/project-contract";
import { checksLine, deployDot, deployHistory, deployProgress, historyResult, overridesAsked, planDeadline, progressLine, recordLine, rollbackWord, shipConfirmLine } from "./project-deploy";

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

test("deadline, rollback and the overrides a refusal asks for", () => {
  const now = Date.parse("2026-10-04T10:00:00.000Z");
  assert.equal(planDeadline("2026-10-04T10:14:30.000Z", now), "Expires in 15 min");
  assert.equal(planDeadline("2026-10-04T09:59:00.000Z", now), "Expired: plan again");
  assert.equal(rollbackWord({ rollback: { none: "x" }, verifiedCommit: null }), null);
  assert.equal(rollbackWord({ rollback: "redeploy-previous", verifiedCommit: "a" }), "Deploys the last verified commit before this one again.");
  assert.deepEqual(overridesAsked("Not planned: the required tests failed (give overrideTests: your reason)."), { tests: true, dirty: false });
});

test("Deploy Now's confirm ends the about's sentence before the next one, never doubling it", () => {
  assert.equal(shipConfirmLine("317a3cf2aa0b", "prod", "Fixture target: a local folder"), "This ships 317a3cf to prod: Fixture target: a local folder. Everyone using it gets it.");
  assert.equal(shipConfirmLine("317a3cf2aa0b", "prod", "The public site."), "This ships 317a3cf to prod: The public site. Everyone using it gets it.");
});

test("a plan's checks fold to one line, open when any was let through", () => {
  const ok = { ok: true };
  assert.deepEqual(checksLine([ok, ok, ok, ok, ok, ok]), { line: "6 checks passed", open: false });
  assert.deepEqual(checksLine([ok, ok, { ok: false }]), { line: "2 checks passed · 1 let through", open: true });
  assert.deepEqual(checksLine([ok]), { line: "1 check passed", open: false });
});

const step = (key: string, exit: number | null = 0) => ({ key, exit, ms: 1000 });
const strip = (steps: { label: string; state: string }[]) => steps.map((s) => `${s.label}:${s.state}`).join(" ");
const PLAN = { steps: [{ key: "build.build" }, { key: "steps.upload" }, { key: "steps.switch" }], verify: { url: "https://x/", expect: 200 } };

test("the progress strip: steps ran, the one running, what waits, the URL check last", () => {
  // With the plan in hand every step is named, running or not.
  assert.equal(strip(deployProgress(rec({ steps: [step("build.build")] }), PLAN)), "Build:done Upload:now Switch:waiting Check URL:waiting");
  assert.equal(strip(deployProgress(rec({ steps: [] }), PLAN)), "Build:now Upload:waiting Switch:waiting Check URL:waiting");
  // Every step ran, the check not yet back: the check is what runs.
  assert.equal(strip(deployProgress(rec({ steps: PLAN.steps.map((s) => step(s.key)) }), PLAN)), "Build:done Upload:done Switch:done Check URL:now");
  // Without the plan the strip ends at the running step and invents nothing after it.
  assert.equal(strip(deployProgress(rec({ steps: [step("build.build")] }))), "Build:done Step 2:now");
  // Ended: a failed step and the check each say so; nothing is running.
  assert.equal(strip(deployProgress(rec({ state: "failed", steps: [step("build.build"), step("steps.upload", 3)] }))), "Build:done Upload:failed");
  const ok = rec({ state: "succeeded", steps: PLAN.steps.map((s) => step(s.key)), verify: { url: "https://x/", status: 200, ok: true, detail: "" } });
  assert.equal(strip(deployProgress(ok)), "Build:done Upload:done Switch:done Check URL:done");
  assert.equal(deployProgress(ok).filter((s) => s.state === "now").length, 0);
});

test("the progress line counts the steps only when the strip knows them all", () => {
  const r = rec({ target: "site", steps: [step("build.build")] });
  assert.equal(progressLine(r, deployProgress(r, PLAN)), "Deploying 1a2b3c4 to site · step 2 of 4 · upload");
  assert.equal(progressLine(r, deployProgress(r)), "Deploying 1a2b3c4 to site · step 2");
  assert.equal(progressLine(rec({ kind: "rollback", target: "site" }), deployProgress(rec({ kind: "rollback" }), PLAN)), "Rolling back 1a2b3c4 to site · step 1 of 4 · build");
});

test("a History row's result: the URL check when there was one, else the record's state", () => {
  const checked = historyResult(rec({ state: "succeeded", verify: { url: "https://sova.example/", status: 200, ok: true, detail: "" } }));
  assert.deepEqual(checked, { chip: { word: "200", tone: "success" }, text: "sova.example answered" });
  assert.equal(historyResult(rec({ state: "verify-failed", verify: { url: "https://a/", status: 502, ok: false, detail: "" } })).chip!.tone, "error");
  assert.deepEqual(historyResult(rec({ state: "succeeded" })).chip, { word: "Deployed", tone: "success" });
  assert.deepEqual(historyResult(rec({ state: "succeeded", kind: "rollback" })).chip!.word, "Rolled back");
  assert.deepEqual(historyResult(rec({ state: "failed" })), { chip: { word: "Failed", tone: "error" }, text: "" });
  assert.deepEqual(historyResult(rec({ state: "failed", steps: [step("build.build"), step("steps.upload", 1)] })).text, "at upload");
});

test("History merges every target's records, newest first, each once", () => {
  const a = rec({ id: "a", startedAt: "2026-10-01T00:00:00Z" });
  const b = rec({ id: "b", target: "site", startedAt: "2026-10-03T00:00:00Z" });
  const c = rec({ id: "c", startedAt: "2026-10-02T00:00:00Z" });
  assert.deepEqual(deployHistory([[c, a], [b], [a]]).map((r) => r.id), ["b", "c", "a"]);
});

test("the Deploy tab's dot: a deploy running, else an overseer's request, else none", () => {
  const req = { id: "rq", target: "prod", commit: null, why: "", by: "overseer", at: "" };
  assert.equal(deployDot(undefined), null);
  assert.equal(deployDot([]), null);
  assert.equal(deployDot([{ last: rec({ state: "succeeded" }), request: null }]), null);
  assert.equal(deployDot([{ last: rec({ state: "succeeded" }), request: req }]), "asked");
  assert.equal(deployDot([{ last: null, request: req }, { last: rec({}), request: null }]), "running");
});
