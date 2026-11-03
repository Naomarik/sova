import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { ReleaseFixture, until } from "../../scripts/e2e-release/fixtures";
import { mergeAdd, ok, publishOne, view, waitEntry } from "../../scripts/e2e-release/flow";
import { startReleaseServer, type ReleaseServer } from "../../scripts/e2e-release/server-kit";

/**
 * The hand-off from a release to Deploy (E2E-PLAN.md S8, S34, S36; al_1 q2, a7): after Publish, Plan Deploy of the
 * release's commit ships it to the stand-in target (a local folder, no host), and the release's history item names
 * the target it runs on; a target that takes releases only refuses an unnamed commit and a withdrawn release.
 */

let k: ReleaseServer;
const fixtures: ReleaseFixture[] = [];
before(async () => {
  k = await startReleaseServer();
});
after(async () => {
  const changes = await k?.stop();
  for (const fx of fixtures) fx.dispose();
  assert.deepEqual(changes ?? [], [], "the sentinel home is untouched");
});

async function project(o: ConstructorParameters<typeof ReleaseFixture>[0]): Promise<ReleaseFixture> {
  const fx = new ReleaseFixture({ under: k.hs.scratch, versions: ["0.1.0"], ...o });
  fixtures.push(fx);
  fx.seedLandings(1);
  fx.seedNames(k.hs.agentDir);
  await k.register(fx.project, fx.name);
  return fx;
}

/** Plan Deploy of `commit` to `site`, then Deploy it, as the operator's two confirms; resolves with the run's state. */
async function deploy(fx: ReleaseFixture, commit: string): Promise<string> {
  const planned = ok(await k.verb("deploy.plan", { project: fx.project, target: "site", commit }), "deploy.plan");
  const plan = planned.json.deploy.plan as { planId: string; commit: string; checks: { id: string; ok: boolean }[] };
  assert.equal(plan.commit, commit);
  const started = ok(await k.verb("deploy.run", { project: fx.project, plan: plan.planId, confirm: true }), "deploy.run");
  const id = started.json.deploy.record.id as string;
  const done = await until("the deploy to settle", async () => {
    const s = await k.verb("deploy.status", { project: fx.project, target: "site" });
    const recs = JSON.stringify(s.json);
    const m = new RegExp(`"id":"${id}"[^}]*?"state":"(\\w[\\w-]*)"`).exec(recs);
    return m && m[1] !== "running" && m[1] !== "planned" ? m[1] : null;
  }, 120_000, 250);
  return done;
}

test("S34 + S8: release, publish, then Plan Deploy of v0.2.0 ships it; the history shows where it runs", { timeout: 290_000 }, async () => {
  const fx = await project({ name: "chain" });
  const { sha } = await publishOne(k, fx, "0.2.0");
  const v = await view(k, fx);
  assert.deepEqual(v.deployTargets, ["site"], "the Releases view offers Plan Deploy for each target");
  assert.equal(await deploy(fx, sha), "succeeded");
  assert.equal(fx.deployedVersion(), sha, "the stand-in target runs the release");
  await until("the history to name the target", async () => (await view(k, fx)).history.find((h) => h.tag === "v0.2.0")?.deployedTo?.includes("site"), 30_000, 250);
});

test("S36: a releases-only target refuses an unnamed commit and a withdrawn release, ships a release", { timeout: 290_000 }, async () => {
  const fx = await project({ name: "only", deploy: { releasesOnly: true } });
  const { rec, sha } = await publishOne(k, fx, "0.2.0");
  // A landing after the release: master's tip is a commit no release names.
  const b = fx.branch("after", { "src/after.txt": "after\n" });
  const e = await mergeAdd(k, fx, b.branch);
  const landed = await waitEntry(k, fx, "the landing", (x) => x.id === e.id && x.state === "landed" && x.landed?.pushed !== "pending", 240_000);
  const tip = landed.landed!.sha as string;
  const unnamed = await k.verb("deploy.plan", { project: fx.project, target: "site", commit: tip });
  const said = JSON.stringify(unnamed.json);
  assert.ok(unnamed.status !== 200 || /releases?\b.*only|not a release|numbered release/i.test(said), `an unnamed commit is refused: ${said.slice(0, 500)}`);
  assert.equal(await deploy(fx, sha), "succeeded", "the release ships");
  ok(await k.verb("release.withdraw", { project: fx.project, release: rec.id, why: "bad", confirm: true }), "withdraw");
  await until("withdrawn", async () => (await view(k, fx)).history.find((h) => h.tag === "v0.2.0")?.withdrawn, 120_000, 250);
  const withdrawn = await k.verb("deploy.plan", { project: fx.project, target: "site", commit: sha });
  assert.ok(withdrawn.status !== 200 || /withdrawn/i.test(JSON.stringify(withdrawn.json)), `a withdrawn release is refused: ${JSON.stringify(withdrawn.json).slice(0, 500)}`);
});
