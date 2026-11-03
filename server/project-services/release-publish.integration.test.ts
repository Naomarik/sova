import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { git, ReleaseFixture } from "../../scripts/e2e-release/fixtures";
import { chatDoes, holdAndContinue, isReady, mergeAdd, mergeView, ok, prepare, record, start, step, stepOf, view, waitEntry, waitRecord } from "../../scripts/e2e-release/flow";
import { startReleaseServer, type ReleaseServer } from "../../scripts/e2e-release/server-kit";

/**
 * One release of a project that publishes to a remote (a bare origin), start to after-publish (E2E-PLAN.md S9, S10,
 * S15, S16, S17, S20, S22): the operator's acts on the operator route, the release chat's reports through its own
 * tool, every outcome read from git (local refs, origin's refs, the main checkout's HEAD).
 */

let k: ReleaseServer;
let fx: ReleaseFixture;

before(async () => {
  k = await startReleaseServer();
  fx = new ReleaseFixture({ under: k.hs.scratch, versions: ["0.1.0", "0.2.0"] });
  fx.seedLandings(2);
  fx.seedNames(k.hs.agentDir);
  await k.register(fx.project, fx.name);
});
after(async () => {
  const changes = await k?.stop();
  fx?.dispose();
  assert.deepEqual(changes ?? [], [], "the sentinel home is untouched");
});

test("a release of a remote-publishing project: freeze, checks, hold, publish in one push, after-steps", async () => {
  const base = fx.head();
  const originBase = fx.originHead();
  assert.equal(originBase, base);
  const other = fx.branch("other", { "src/other.txt": "other\n" });

  // S9: Start Release opens a record whose plan is the manifest plus Sova's two steps, and its chat.
  const rec = await start(k, fx);
  assert.equal(rec.state, "preparing");
  assert.equal(rec.base, base);
  assert.deepEqual(rec.steps.map((s) => s.id), ["version", "notes", "bump", "commit", "checks", "try-live", "publish", "page", "page-withdrawn"]);
  assert.ok(rec.steps.every((s) => s.state === "waiting" || s.state === "running"), JSON.stringify(rec.steps));
  const mv = await mergeView(k, fx);
  assert.equal(mv.release?.id, rec.id, "the Merge Queue tab shows the freeze");
  // A second Start while one is open is refused.
  const again = await k.verb("release.start", { project: fx.project });
  assert.notEqual(again.status, 200, JSON.stringify(again.json));

  // S17: a landing approved during the open release waits, and master stays where the release is.
  const waiting = await mergeAdd(k, fx, other.branch);
  await waitEntry(k, fx, "the other branch waiting for the release", (e) => e.id === waiting.id && e.state === "queued" && /release/i.test(e.reason ?? ""));

  // S10: the chat reports each step; the record shows each with its summary and who sent it.
  const commit = await prepare(k, fx, rec, "0.3.0");
  let r = await record(k, fx);
  for (const id of ["version", "notes", "bump", "commit"]) {
    assert.equal(stepOf(r, id).state, "done", id);
    assert.equal(stepOf(r, id).by, "thread", `${id} reported by the release chat`);
    assert.ok(stepOf(r, id).summary, `${id} has a summary`);
  }
  assert.equal(r.version, "0.3.0");
  assert.equal(r.tag, "v0.3.0");
  assert.match(r.notes ?? "", /landings since/);

  // S16: the release commit enters the queue as a marked release entry, is checked (merge set + release-only
  // checks, in a merge copy) and lands locally, unpushed.
  const rentry = await waitEntry(k, fx, "the release entry", (e) => e.release === rec.id);
  assert.equal(rentry.approval?.by, "release");
  r = await waitRecord(k, fx, "the release checks to pass", (x) => stepOf(x, "checks").state === "done", 240_000);
  const ran = fx.calls().filter((c) => c.script === "unit" || c.script === "full");
  assert.ok(ran.some((c) => c.script === "full"), "the release-only check ran");
  assert.ok(ran.every((c) => c.cwd !== fx.project), "checks ran in a merge copy, never the main checkout");
  assert.ok(fx.isAncestor(commit, fx.head()), "master carries the release commit");
  assert.ok(!fx.isAncestor(other.commit, fx.head()), "and nothing else landed");
  assert.equal(fx.liveTreeHead(), fx.head(), "the main checkout follows master");
  assert.equal(fx.originHead(), originBase, "nothing pushed before Publish");
  assert.equal(fx.originTag("v0.3.0"), null);
  assert.equal(fx.tagAt("v0.3.0"), null, "no tag before Publish");

  // S15: the held try-out waits for the operator's Continue.
  await holdAndContinue(k, fx, r);
  r = await waitRecord(k, fx, "ready to publish", isReady);
  const v = await view(k, fx);
  assert.equal(v.gates?.checksPassed, true, JSON.stringify(v.gates));

  // The waiting landing is still waiting, master still the release (absence: the queue starts an entry within
  // a tick of being free, so 2 s holds several of its passes).
  await new Promise((res) => setTimeout(res, 2000));
  const releaseSha = fx.head();
  assert.ok(fx.isAncestor(commit, releaseSha) && !fx.isAncestor(other.commit, releaseSha), "master frozen on the release");
  assert.ok((await waitEntry(k, fx, "other still queued", (e) => e.id === waiting.id)).state === "queued");

  // S20: Publish needs its confirm, then goes out in one push: master, the numbered tag and the channel.
  const noConfirm = await k.verb("release.publish", { project: fx.project, release: rec.id });
  assert.equal(noConfirm.json.error?.code, "needs-confirm", JSON.stringify(noConfirm.json));
  assert.equal(fx.originTag("v0.3.0"), null);
  ok(await k.verb("release.publish", { project: fx.project, release: rec.id, confirm: true }), "release.publish");
  r = await waitRecord(k, fx, "published", (x) => x.state === "published");
  assert.equal(fx.tagAt("v0.3.0"), releaseSha);
  assert.equal(fx.tagAt("stable"), releaseSha);
  assert.equal(fx.originHead(), releaseSha, "origin master is the release");
  assert.equal(fx.originTag("v0.3.0"), releaseSha);
  assert.equal(fx.originTag("stable"), releaseSha);
  assert.equal(git(fx.project, ["cat-file", "-t", "refs/tags/v0.3.0"]), "tag", "annotated");
  assert.match(git(fx.project, ["tag", "-l", "--format=%(contents)", "v0.3.0"]), /landings since/, "the tag carries the notes");
  assert.equal(fx.tagAt("v0.2.0"), git(fx.project, ["rev-parse", "v0.2.0^{commit}"]), "older tags untouched");
  assert.equal(r.publish?.by, "operator");
  assert.ok(r.commit === commit || r.commit === releaseSha, `the record names the release commit (${r.commit})`);

  // The freeze lifts: the waiting landing lands on top and pushes as usual.
  const landed = await waitEntry(k, fx, "the other branch to land after Publish", (e) => e.id === waiting.id && e.state === "landed" && e.landed?.pushed !== "pending", 240_000);
  assert.ok(fx.isAncestor(releaseSha, fx.head()));
  assert.equal(fx.originHead(), landed.landed?.sha);
  assert.equal(fx.tagAt("v0.3.0"), releaseSha, "the numbered tag never moves");

  // S22: a failed after-publish step never undoes Publish; Retry Step runs it again.
  const pub = fx.facts();
  await chatDoes(k, r, [step("page", "running", "making the release page"), step("page", "failed", "release page: host refused")]);
  await waitRecord(k, fx, "page failed", (x) => stepOf(x, "page").state === "failed", 60_000, rec.id);
  assert.equal((await record(k, fx, rec.id)).state, "published");
  assert.deepEqual(fx.facts().tags, pub.tags, "no tag moved");
  ok(await k.verb("release.retry", { project: fx.project, release: rec.id, step: "page" }), "release.retry");
  await waitRecord(k, fx, "page waiting again", (x) => stepOf(x, "page").state !== "failed", 60_000, rec.id);
  await chatDoes(k, r, [step("page", "done", "release page made", { facts: { url: "https://example.invalid/releases/v0.3.0" } })]);
  await waitRecord(k, fx, "page done", (x) => stepOf(x, "page").state === "done", 60_000, rec.id);

  // The Releases view: v0.3.0 newest, stable on it, made by Sova.
  const after = await view(k, fx);
  assert.equal(after.open, null);
  assert.equal(after.latest, "v0.3.0");
  assert.equal(after.history[0]?.tag, "v0.3.0");
  assert.deepEqual(after.history[0]?.channels, ["stable"]);
  assert.equal(after.history[0]?.record, rec.id);
  assert.deepEqual(after.history[1]?.channels, []);
});
