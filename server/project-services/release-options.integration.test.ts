import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { DEFAULT_STEPS, ReleaseFixture } from "../../scripts/e2e-release/fixtures";
import { chatDoes, isReady, ok, prepare, start, step, stepOf, waitRecord, type Rec } from "../../scripts/e2e-release/flow";
import { startReleaseServer, type ReleaseServer } from "../../scripts/e2e-release/server-kit";

/**
 * Release with Options through the real server: a release check the operator turned off at Start is left out of the
 * queue's frozen release checks (it never runs, so its failure can't hold Publish), and a turned-off held step
 * reported skipped lets the release reach ready; a plain Start still runs every release check.
 */

let k: ReleaseServer;
const fixtures: ReleaseFixture[] = [];
const STEPS = DEFAULT_STEPS.map((s) => (s.id === "try-live" ? { ...s, skippable: true as const } : s));
async function project(name: string): Promise<ReleaseFixture> {
  const fx = new ReleaseFixture({ under: k.hs.scratch, versions: ["0.1.0"], name, steps: STEPS });
  fixtures.push(fx);
  fx.seedLandings(1);
  fx.seedNames(k.hs.agentDir);
  await k.register(fx.project, fx.name);
  return fx;
}
const fullRuns = (fx: ReleaseFixture, since: number) => fx.calls().filter((c) => c.script === "full" && Number(c.at) >= since);

before(async () => {
  k = await startReleaseServer();
});
after(async () => {
  const changes = await k?.stop();
  for (const fx of fixtures) fx.dispose();
  assert.deepEqual(changes ?? [], [], "the sentinel home is untouched");
});

test("a release check turned off at Start never runs (its failure can't hold Publish); a turned-off held step reported skipped reaches ready", { timeout: 290_000 }, async () => {
  const fx = await project("quick");
  const since = Date.now();
  const rec: Rec = await start(k, fx, { kind: "minor", skipChecks: ["full"], skipSteps: ["try-live"] });
  assert.deepEqual(rec.options, { kind: "minor", skipSteps: ["try-live"], skipChecks: ["full"], off: [{ what: "step", id: "try-live", label: "Try it" }, { what: "check", id: "full", label: "Full tests" }] });
  // The release-only check would fail on this release commit, were it run.
  await prepare(k, fx, rec, "0.2.0", { releaseGate: "fail" });
  await waitRecord(k, fx, "the gating checks to pass", (x) => stepOf(x, "checks").state === "done", 240_000);
  assert.deepEqual(fullRuns(fx, since), [], "the turned-off release check never ran");
  assert.ok(fx.calls().some((c) => c.script === "unit" && Number(c.at) >= since), "the landing checks still ran");
  await chatDoes(k, rec, [step("try-live", "skipped", "Turned off at Start")]);
  const r = await waitRecord(k, fx, "ready", isReady, 60_000);
  assert.equal(stepOf(r, "try-live").state, "skipped");
  const bad = await k.verb("release.start", { project: fx.project, skipChecks: ["full"] });
  assert.equal(bad.json.error?.code, "release-refused", "one release at a time, options or not");
});

test("a plain Start still freezes and runs every release check", { timeout: 290_000 }, async () => {
  const fx = await project("plain");
  const since = Date.now();
  const rec = await start(k, fx);
  assert.equal(rec.options, undefined);
  await prepare(k, fx, rec, "0.2.0", { releaseGate: "fail" });
  await waitRecord(k, fx, "the release check to fail", (x) => stepOf(x, "checks").state === "failed", 240_000);
  assert.ok(fullRuns(fx, since).some((c) => c.result === "fail"), "the release-only check ran and failed");
  ok(await k.verb("release.abandon", { project: fx.project, release: rec.id, confirm: true }), "release.abandon");
});
