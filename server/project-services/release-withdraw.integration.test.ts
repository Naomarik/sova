import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { join } from "node:path";
import { git, ReleaseFixture } from "../../scripts/e2e-release/fixtures";
import { checkForUpdate } from "../updates/check";
import { gitIn } from "../updates/git";
import { chatDoes, ok, publishOne, step, stepOf, view, waitRecord } from "../../scripts/e2e-release/flow";
import { startReleaseServer, type ReleaseServer } from "../../scripts/e2e-release/server-kit";

/**
 * Withdraw (E2E-PLAN.md S26, S28; al_1 q7, a8): the channel moves back to the previous release (on origin too,
 * leased), the release reads withdrawn with its reason in its notes, the numbered tag never moves, and the
 * playbook's withdraw steps run after. A local-only project moves its channel locally and pushes nothing.
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

test("S26 + S27: Withdraw moves stable back here and on origin; v0.3.0 stays; a copy on it is told it was withdrawn", { timeout: 290_000 }, async () => {
  const fx = new ReleaseFixture({ under: k.hs.scratch, versions: ["0.1.0", "0.2.0"] });
  fixtures.push(fx);
  fx.seedLandings(1);
  fx.seedNames(k.hs.agentDir);
  await k.register(fx.project, fx.name);
  const prev = fx.tagAt("v0.2.0")!;
  const { rec, sha } = await publishOne(k, fx, "0.3.0");
  assert.equal(fx.originTag("stable"), sha);
  const tagObject = fx.tagObject("v0.3.0");

  // S27, before: an installed copy on v0.3.0 following Stable is up to date.
  const copy = join(fx.root, "installed-copy");
  git(fx.root, ["clone", "-q", fx.origin!, copy]);
  git(copy, ["checkout", "-q", "--detach", "v0.3.0"]);
  const check = () => checkForUpdate({ git: gitIn(copy), repo: fx.origin!, source: { kind: "stable" }, kind: "installer", head: git(copy, ["rev-parse", "HEAD"]), branch: null });
  assert.equal((await check()).result.state, "up-to-date");

  const noConfirm = await k.verb("release.withdraw", { project: fx.project, release: rec.id, why: "breaks login" });
  assert.equal(noConfirm.json.error?.code, "needs-confirm", JSON.stringify(noConfirm.json));
  assert.equal(fx.tagAt("stable"), sha);
  const noWhy = await k.verb("release.withdraw", { project: fx.project, release: rec.id, confirm: true });
  assert.notEqual(noWhy.status, 200, `a withdraw needs its reason: ${JSON.stringify(noWhy.json)}`);

  ok(await k.verb("release.withdraw", { project: fx.project, release: rec.id, why: "breaks login", confirm: true }), "release.withdraw");
  const r = await waitRecord(k, fx, "withdrawn", (x) => x.state === "withdrawn", 120_000, rec.id);
  assert.equal(r.withdrawn?.why, "breaks login");
  assert.match(r.notes ?? "", /withdrawn/i);
  assert.match(r.notes ?? "", /breaks login/);
  assert.equal(fx.tagAt("stable"), prev, "stable back on v0.2.0");
  assert.equal(fx.originTag("stable"), prev, "and on origin");
  assert.equal(fx.tagAt("v0.3.0"), sha, "the numbered tag never moves");
  assert.equal(fx.tagObject("v0.3.0"), tagObject, "not even re-made");
  assert.equal(fx.originTag("v0.3.0"), sha);
  assert.equal(git(fx.project, ["rev-parse", "master"]), fx.originHead(), "master untouched by Withdraw");

  const v = await view(k, fx);
  assert.equal(v.latest, "v0.2.0", "latest skips the withdrawn release");
  const item = v.history.find((h) => h.tag === "v0.3.0");
  assert.equal(item?.withdrawn?.why, "breaks login");
  assert.deepEqual(item?.channels, []);
  assert.deepEqual(v.history.find((h) => h.tag === "v0.2.0")?.channels, ["stable"]);

  // S27: every copy learns it through the marker on origin; the copy on v0.3.0 is told it was withdrawn and why,
  // with an offer to go back to v0.2.0, never "ahead".
  assert.equal(fx.originTag("withdrawn/v0.3.0"), sha, `origin carries the withdrawn marker at the release: ${JSON.stringify(fx.originRefs())}`);
  assert.equal(git(fx.project, ["cat-file", "-t", "refs/tags/withdrawn/v0.3.0"]), "tag", "annotated");
  const told = (await check()).result as Record<string, any>;
  assert.equal(told.state, "withdrawn", JSON.stringify(told));
  assert.equal(told.tag, "v0.3.0");
  assert.equal(told.why, "breaks login");
  assert.equal(told.target?.sha, prev, "the offer goes back to v0.2.0");
  assert.equal(told.target?.version, "v0.2.0");

  // The playbook's withdraw step runs after, reported by the release chat.
  assert.equal(stepOf(r, "page-withdrawn").state === "done", false);
  await chatDoes(k, r, [step("page-withdrawn", "done", "release page marked withdrawn")]);
  await waitRecord(k, fx, "withdraw step done", (x) => stepOf(x, "page-withdrawn").state === "done", 60_000, rec.id);

  // A second Withdraw is refused and moves nothing.
  const again = await k.verb("release.withdraw", { project: fx.project, release: rec.id, why: "again", confirm: true });
  assert.notEqual(again.status, 200, JSON.stringify(again.json));
  assert.equal(fx.originTag("stable"), prev);
});

test("S28: Withdraw on a local-only project moves the channel locally and pushes nothing", { timeout: 290_000 }, async () => {
  const fx = new ReleaseFixture({ kind: "local", under: k.hs.scratch, versions: ["0.1.0"] });
  fixtures.push(fx);
  fx.seedLandings(1);
  await k.register(fx.project, fx.name);
  const prev = fx.tagAt("v0.1.0")!;
  const { rec, sha } = await publishOne(k, fx, "0.2.0");
  assert.equal(fx.tagAt("stable"), sha);
  ok(await k.verb("release.withdraw", { project: fx.project, release: rec.id, why: "bad build", confirm: true }), "release.withdraw");
  await waitRecord(k, fx, "withdrawn", (x) => x.state === "withdrawn", 120_000, rec.id);
  assert.equal(fx.tagAt("stable"), prev);
  assert.equal(fx.tagAt("v0.2.0"), sha);
  assert.equal(fx.tagAt("withdrawn/v0.2.0"), sha, "the withdrawn marker, locally");
  assert.match(git(fx.project, ["tag", "-l", "--format=%(contents)", "withdrawn/v0.2.0"]), /bad build/);
  assert.equal(git(fx.project, ["remote"]), "");
});
