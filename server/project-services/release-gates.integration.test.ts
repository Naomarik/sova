import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { DEFAULT_POINTER, git, ReleaseFixture, until } from "../../scripts/e2e-release/fixtures";
import { chatDoes, isReady, mergeAdd, notes, ok, prepare, start, step, stepOf, view, waitEntry, waitRecord, type Rec } from "../../scripts/e2e-release/flow";
import { startReleaseServer, type ReleaseServer } from "../../scripts/e2e-release/server-kit";

/**
 * What stops a release (E2E-PLAN.md S11, S14, S18, S19, S24, S25): a failed gating check refuses Publish; Abandon
 * reverts a landed release commit as a queue landing (never a reset) and lifts the freeze; a report whose facts
 * Sova can disprove reads failed; a quiet release chat raises Needs you; a tag-only release publishes master's tip.
 * The quiet time is shortened through the server's knob.
 */

let k: ReleaseServer;
const fixtures: ReleaseFixture[] = [];
async function project(o: ConstructorParameters<typeof ReleaseFixture>[0] = {}): Promise<ReleaseFixture> {
  const fx = new ReleaseFixture({ under: k.hs.scratch, versions: ["0.1.0"], ...o });
  fixtures.push(fx);
  fx.seedLandings(1);
  fx.seedNames(k.hs.agentDir);
  await k.register(fx.project, fx.name);
  return fx;
}
async function attention(): Promise<Array<Record<string, any>>> {
  const r = await k.http("GET", "/api/overseer/attention");
  const j = r.json as Record<string, any>;
  return (Array.isArray(j) ? j : (j.items ?? j.attention ?? [])) as Array<Record<string, any>>;
}
const abandon = async (fx: ReleaseFixture, rec: Rec) => ok(await k.verb("release.abandon", { project: fx.project, release: rec.id, why: "test over", confirm: true }), "release.abandon");

before(async () => {
  k = await startReleaseServer({ env: { SOVA_RELEASE_QUIET_MS: "4000", SOVA_RELEASE_STALL_POLL_MS: "500" } });
});
after(async () => {
  const changes = await k?.stop();
  for (const fx of fixtures) fx.dispose();
  assert.deepEqual(changes ?? [], [], "the sentinel home is untouched");
});

test("S18 + S25: a failed release-only check refuses Publish; Abandon before anything landed lifts the freeze", { timeout: 290_000 }, async () => {
  const fx = await project({ name: "red" });
  const base = fx.head();
  const other = fx.branch("other", { "src/other.txt": "other\n" });
  const rec = await start(k, fx);
  const waiting = await mergeAdd(k, fx, other.branch);
  await prepare(k, fx, rec, "0.2.0", { releaseGate: "fail" });
  const r = await waitRecord(k, fx, "the release checks to fail", (x) => stepOf(x, "checks").state === "failed", 240_000);
  assert.notEqual(r.state, "ready");
  const v = await view(k, fx);
  assert.equal(v.gates?.checksPassed, false, JSON.stringify(v.gates));
  assert.ok((v.gates?.why ?? []).length > 0, "the view says why Publish isn't offered");
  assert.ok(fx.calls().some((c) => c.script === "full" && c.result === "fail"), "the release-only check is what failed");
  assert.ok((await attention()).some((i) => i.kind === "release-failed"), "Needs you: release-failed");

  const before = fx.facts();
  const pub = await k.verb("release.publish", { project: fx.project, release: rec.id, confirm: true });
  assert.equal(pub.json.error?.code, "release-refused", JSON.stringify(pub.json));
  assert.deepEqual(fx.facts(), before, "no tag, channel, master or origin moved");
  assert.equal(fx.head(), base, "the failed release commit never landed");

  const noConfirm = await k.verb("release.abandon", { project: fx.project, release: rec.id, why: "red" });
  assert.equal(noConfirm.json.error?.code, "needs-confirm", JSON.stringify(noConfirm.json));
  await abandon(fx, rec);
  const gone = await waitRecord(k, fx, "abandoned", (x) => x.state === "abandoned", 60_000, rec.id);
  assert.equal(gone.abandoned?.revert ?? null, null, "nothing to revert");
  assert.equal(fx.tagAt("v0.2.0"), null);
  const landed = await waitEntry(k, fx, "the waiting branch to land once the freeze lifts", (e) => e.id === waiting.id && e.state === "landed" && e.landed?.pushed !== "pending", 240_000);
  assert.equal(fx.originHead(), landed.landed?.sha);
  assert.equal((await view(k, fx)).open, null);
});

test("S24: Abandon after the release commit landed reverts it as a queue landing, never a reset", { timeout: 290_000 }, async () => {
  const fx = await project({ name: "back" });
  const base = fx.head();
  const originBase = fx.originHead();
  const rec = await start(k, fx);
  const commit = await prepare(k, fx, rec, "0.2.0");
  await waitRecord(k, fx, "checks passed", (x) => stepOf(x, "checks").state === "done", 240_000);
  const landedRelease = fx.head();
  assert.ok(fx.isAncestor(commit, landedRelease));
  assert.equal(fx.originHead(), originBase, "unpushed");

  await abandon(fx, rec);
  const gone = await waitRecord(k, fx, "abandoned with its revert landed", (x) => x.state === "abandoned" && !!x.abandoned?.revert, 240_000, rec.id);
  const revert = await waitEntry(k, fx, "the revert landing", (e) => e.id === gone.abandoned?.revert && e.state === "landed", 240_000);
  assert.equal(revert.release, rec.id, "the revert is the release's entry");
  assert.ok(fx.isAncestor(landedRelease, fx.head()), "master moved forward from the release commit (no reset)");
  assert.equal(fx.head() === landedRelease, false);
  assert.equal(git(fx.project, ["rev-parse", `${fx.head()}^{tree}`]), git(fx.project, ["rev-parse", `${base}^{tree}`]), "the revert restores the base's files");
  assert.equal(fx.liveTreeHead(), fx.head(), "the main checkout followed master");
  assert.equal(fx.tagAt("v0.2.0"), null, "no tag");
  assert.equal(fx.tagAt("stable"), fx.tagAt("v0.1.0"), "the channel never moved");
  // The freeze is lifted: pushes resume through the queue as usual.
  await until("origin to get master with the revert", () => fx.originHead() === fx.head(), 120_000, 200);
  assert.equal(fx.originTag("v0.2.0"), null);
});

test("S11: a report Sova can disprove reads failed (the fact wins), and adds no release entry", { timeout: 290_000 }, async () => {
  const fx = await project({ name: "facts" });
  const stray = fx.branch("stray", { "src/stray.txt": "x\n" });
  const rec = await start(k, fx);
  // The version's tag already exists.
  const [taken] = await chatDoes(k, rec, [step("version", "done", "v0.1.0", { facts: { version: "0.1.0" } })], undefined, { expectOk: false });
  assert.match(taken ?? "", /release-refused.*v0\.1\.0 already exists/s, "the chat is told why");
  let r = await waitRecord(k, fx, "the taken version to fail", (x) => stepOf(x, "version").state === "failed", 60_000);
  assert.equal(stepOf(r, "version").fact?.ok, false, JSON.stringify(stepOf(r, "version")));
  assert.equal(r.version, null, "the disproved version isn't taken");
  // Report the right one, then a commit that is not on the release branch.
  ok(await k.verb("release.retry", { project: fx.project, release: rec.id, step: "version" }), "retry version");
  await chatDoes(k, rec, [step("version", "done", "v0.2.0", { facts: { version: "0.2.0" } }), notes("- notes"), step("notes", "done", "notes"), step("bump", "done", "bumped")]);
  await chatDoes(k, rec, [step("commit", "done", "Release v0.2.0", { facts: { commit: stray.commit, branch: String(rec.thread?.branch) } })], undefined, { expectOk: false });
  r = await waitRecord(k, fx, "the stray commit to fail", (x) => stepOf(x, "commit").state === "failed", 60_000);
  assert.equal(stepOf(r, "commit").fact?.ok, false);
  assert.match(stepOf(r, "commit").fact?.why ?? "", /branch|release/i);
  assert.equal(r.entry, null, "no release entry for a disproved commit");
  assert.equal(r.commit, null);
  await abandon(fx, rec);
  await waitRecord(k, fx, "abandoned", (x) => x.state === "abandoned", 60_000, rec.id);
});

test("S14: a release chat quiet past quietMin while frozen shows in Needs you, and a report clears it", { timeout: 290_000 }, async () => {
  const fx = await project({ name: "quiet" });
  const rec = await start(k, fx);
  // The knob makes quietMin 4 s and the stall check every 0.5 s.
  const item = await until("the quiet-chat item", async () => (await attention()).find((i) => i.kind === "release-quiet"), 60_000, 250);
  assert.match(String(item.href ?? ""), /releases/, JSON.stringify(item));
  assert.match(JSON.stringify(item), /No word from the release chat/i, JSON.stringify(item));
  assert.ok((await view(k, fx)).quiet, "the view carries quiet");
  await chatDoes(k, rec, [step("version", "running", "looking at the landings")]);
  await until("quiet to clear after a report", async () => !(await view(k, fx)).quiet, 30_000, 200);
  await abandon(fx, rec);
  await waitRecord(k, fx, "abandoned", (x) => x.state === "abandoned", 60_000, rec.id);
  await until("the quiet item gone", async () => !(await attention()).some((i) => i.kind === "release-quiet"), 30_000, 250);
});

test("S19: a tag-only release checks and publishes master's tip, with no release commit", { timeout: 290_000 }, async () => {
  const fx = await project({
    name: "tagonly",
    release: { ...DEFAULT_POINTER, commit: false },
    steps: [
      { id: "version", label: "Pick the version", phase: "prepare" },
      { id: "notes", label: "Draft the notes", phase: "prepare" },
    ],
  });
  const base = fx.head();
  const rec = await start(k, fx);
  assert.deepEqual(rec.steps.map((s) => s.id), ["version", "notes", "checks", "publish"]);
  assert.equal(rec.commit, base, "the release is of the target tip at start");
  await chatDoes(k, rec, [step("version", "done", "v0.2.0", { facts: { version: "0.2.0" } }), notes("- tag only"), step("notes", "done", "notes")]);
  await waitRecord(k, fx, "ready", isReady, 240_000);
  assert.ok(fx.calls().some((c) => c.script === "full" && c.head === base), "the gating checks ran on the tip");
  ok(await k.verb("release.publish", { project: fx.project, release: rec.id, confirm: true }), "publish");
  await waitRecord(k, fx, "published", (x) => x.state === "published", 120_000, rec.id);
  assert.equal(fx.head(), base, "no commit made");
  assert.equal(fx.tagAt("v0.2.0"), base);
  assert.equal(fx.originTag("v0.2.0"), base);
  assert.equal(fx.originTag("stable"), base);
  assert.equal(fx.originHead(), base);
});
