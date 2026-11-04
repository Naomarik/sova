import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { after, before, test } from "node:test";
import { git, ReleaseFixture } from "../../scripts/e2e-release/fixtures";
import { chatDoes, isReady, lastToolResults, ok, prepare, record, start, step, stepOf, threadCheckout, view, waitRecord } from "../../scripts/e2e-release/flow";
import { startReleaseServer, type ReleaseServer } from "../../scripts/e2e-release/server-kit";

/**
 * A local-only project's release (E2E-PLAN.md S21, al_1 a6, t24): no origin, merge.push false. Publish pushes
 * nothing and makes the numbered tag and the channel on this machine; the after-publish build reports where its
 * artifact is, and the artifact is never committed anywhere.
 */

let k: ReleaseServer;
let fx: ReleaseFixture;

before(async () => {
  k = await startReleaseServer();
  fx = new ReleaseFixture({ kind: "local", under: k.hs.scratch, versions: ["0.1.0"] });
  fx.seedLandings(1);
  await k.register(fx.project, fx.name);
});
after(async () => {
  const changes = await k?.stop();
  fx?.dispose();
  assert.deepEqual(changes ?? [], [], "the sentinel home is untouched");
});

test("S21: local-only Publish tags and moves the channel locally, pushes nothing; the artifact is reported, never committed", { timeout: 290_000 }, async () => {
  const v0 = await view(k, fx);
  assert.equal(v0.remote, false, "the view says Publish won't push");
  const rec = await start(k, fx);
  assert.deepEqual(rec.steps.map((s) => s.id), ["version", "notes", "bump", "commit", "checks", "publish", "artifact"]);
  const commit = await prepare(k, fx, rec, "0.2.0");
  let r = await waitRecord(k, fx, "ready", isReady, 240_000);
  const sha = fx.head();
  assert.ok(fx.isAncestor(commit, sha), "master carries the release commit");

  ok(await k.verb("release.publish", { project: fx.project, release: rec.id, confirm: true }), "release.publish");
  r = await waitRecord(k, fx, "published", (x) => x.state === "published");
  assert.equal(fx.tagAt("v0.2.0"), sha);
  assert.equal(fx.tagAt("stable"), sha);
  assert.equal(git(fx.project, ["remote"]), "", "still no remote");
  assert.match(String(r.publish?.pushed?.state ?? r.publish?.pushed ?? ""), /no-remote|not-pushed/, JSON.stringify(r.publish));

  // The artifact: the chat's build writes it into the gitignored dist/ of its checkout; a path inside the repo that
  // isn't ignored is refused.
  const co = threadCheckout(fx, r);
  const built = JSON.parse(execFileSync("node", [".sova/playbooks/release/scripts/release.mjs", "build", "0.2.0"], { cwd: co, encoding: "utf8" })) as { artifact: string; sha256: string; size: number };
  assert.ok(existsSync(built.artifact));
  // The fact wins (S11): a done report naming a file the repository tracks reads failed, with Sova's why.
  const [told] = await chatDoes(k, r, [step("artifact", "done", "app built", { facts: { artifact: `${co}/README.md`, size: 1 } })], undefined, { expectOk: false });
  assert.match(told ?? "", /inside the repository and not ignored/, told);
  const bad = await waitRecord(k, fx, "the tracked artifact path to fail its fact", (x) => stepOf(x, "artifact").state === "failed", 60_000, rec.id);
  assert.equal(stepOf(bad, "artifact").fact?.ok, false, JSON.stringify(stepOf(bad, "artifact")));
  assert.match(stepOf(bad, "artifact").fact?.why ?? "", /commit|track|ignored|repositor/i);
  assert.equal(bad.artifacts?.length ?? 0, 0, "no artifact recorded");
  void lastToolResults;

  ok(await k.verb("release.retry", { project: fx.project, release: rec.id, step: "artifact" }), "release.retry");
  await chatDoes(k, r, [step("artifact", "done", `app built: ${built.artifact}`, { facts: { artifact: built.artifact, sha256: built.sha256, size: built.size } })]);
  r = await waitRecord(k, fx, "artifact reported", (x) => stepOf(x, "artifact").state === "done", 60_000, rec.id);
  assert.deepEqual(r.artifacts?.map((a: { path: string }) => a.path), [built.artifact]);
  assert.equal(r.artifacts?.[0]?.sha256, built.sha256);
  assert.equal(r.artifacts?.[0]?.size, statSync(built.artifact).size);
  assert.ok(!fx.everCommitted().some((p) => p.startsWith("dist/")), "dist/ never committed on any ref");
  assert.ok(fx.clean(), "the main checkout has no tracked changes");
  const v = await view(k, fx);
  assert.equal(v.history[0]?.tag, "v0.2.0");
  assert.deepEqual(v.history[0]?.channels, ["stable"]);
});
