import assert from "node:assert/strict";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { APP, LIST_PLUS, STATE, mergeCopyOf, mergesOnto, resolution, reviewer, settled, setup, testedHead } from "./testing/scenario-kit";
import { Fixture, git, until } from "./testing/repo";
import type { HarnessOptions } from "./testing/harness";
import type { MergeEntry } from "../../shared/merge-queue";

/**
 * The merge queue's use cases (team brief, TESTING): approval: pinning, drafts, cancel, typed words, refusals. Each on a real git repository in a temp dir with a bare
 * origin: the real queue on the real run, driven through the queue's verb methods (testing/harness.ts); only the
 * branch's chat, the merge thread and the reviewer chat are stood in for. Waits are on conditions.
 */
void [APP, LIST_PLUS, STATE, mergeCopyOf, mergesOnto, resolution, reviewer, settled, setup, testedHead, Fixture, git, until, existsSync, writeFileSync, join, assert];
export type _H = HarnessOptions | MergeEntry;

// ---------------------------------------------------------------- approval edges

describe("approval", () => {
  test("S11: a new commit on a queued branch: the approved commit lands; the row says 1 newer commit not included", async () => {
    const { fx, h } = await setup();
    const hold = fx.branch("hold", { "tests/h.txt": "gate hold\n" });
    const eh = await h.add({ branch: hold.branch });
    await until("hold at its gate", () => fx.atGate("hold"));
    const b = fx.branch("b", { "b.txt": "one\n" });
    const eb = await h.add({ branch: b.branch });
    const newer = fx.commitIn(b.checkout, { "b.txt": "two\n" }, "b: newer");
    fx.openGate("hold");
    assert.equal((await h.waitEntry(eh.id, settled)).state, "landed");
    const landed = await h.waitEntry(eb.id, settled);
    assert.equal(landed.state, "landed", `${landed.state}: ${landed.reason}`);
    assert.equal(landed.commit, b.commit, "still pinned");
    assert.equal(landed.newerCommits, 1);
    assert.equal(fx.fileAt(fx.head(), "b.txt"), "one\n");
    assert.ok(!fx.isAncestor(newer, fx.head()), "the newer commit is not on master");
  });

  test("S11b: a new commit while the branch is checking: the pinned commit is what lands", async () => {
    const { fx, h } = await setup();
    const b = fx.branch("b", { "tests/g.txt": "gate b\n" });
    const e = await h.add({ branch: b.branch });
    await until("b at its gate", () => fx.atGate("b"));
    const newer = fx.commitIn(b.checkout, { "later.txt": "x\n" }, "later");
    fx.openGate("b");
    const landed = await h.waitEntry(e.id, settled);
    assert.equal(landed.state, "landed", `${landed.state}: ${landed.reason}`);
    assert.ok(fx.isAncestor(b.commit, fx.head()) && !fx.isAncestor(newer, fx.head()));
    assert.equal(landed.newerCommits, 1);
  });

  test("S12: spec drafts edited after Land: 'drafts changed since you approved', waits; a new Land lands the edited docs", async () => {
    const { fx, h } = await setup();
    await fx.withSpec();
    const hold = fx.branch("hold", { "tests/h.txt": "gate hold\n" });
    const eh = await h.add({ branch: hold.branch });
    await until("hold at its gate", () => fx.atGate("hold"));
    const b = fx.branch("doc", { "README.md": "# doc\n" });
    fx.draft(b.checkout, "doc", "First words.");
    const eb = await h.add({ branch: b.branch });
    fx.editDraft(b.checkout, "doc", "Second words.");
    fx.openGate("hold");
    assert.equal((await h.waitEntry(eh.id, settled)).state, "landed");
    const w = await h.waitEntry(eb.id, settled);
    assert.equal(w.state, "drafts-changed", `${w.state}: ${w.reason}`);
    assert.ok(!fx.isAncestor(b.commit, fx.head()));
    assert.ok(h.notices.some((n) => n.kind === "drafts-changed" && n.branch === b.branch), "its chat is told");
    // The chat verifies its edited draft again (a note older than the prose is stale to the spec tool), then Land.
    fx.noteDraft(b.checkout, "doc");
    const again = await h.add({ branch: b.branch });
    const landed = await h.waitEntry(again.id, settled);
    assert.equal(landed.state, "landed", `${landed.state}: ${landed.reason}`);
    assert.match(fx.fileAt(landed.landed!.sha, ".sova/spec/claims/b/doc.md") ?? "", /Second words/);
  });

  test("S12b: Land without its specs: the drafts stay behind, nothing is made official", async () => {
    const { fx, h } = await setup();
    await fx.withSpec();
    const b = fx.branch("doc", { "README.md": "# doc\n" });
    fx.draft(b.checkout, "doc");
    const l = await h.waitEntry((await h.add({ branch: b.branch, withoutSpecs: true })).id, settled);
    assert.equal(l.state, "landed", `${l.state}: ${l.reason}`);
    assert.equal(fx.fileAt(fx.head(), ".sova/spec/claims/b/doc.md"), null);
  });

  test("S12c: sent back for its drafts, fixed with no commit: Land comes back at the same commit and lands", async () => {
    const { fx, h } = await setup();
    await fx.withSpec();
    const b = fx.branch("doc", { "README.md": "# doc\n" });
    // A draft whose note is older than its prose: the spec tool refuses to make it official.
    fx.draft(b.checkout, "doc", "First words.");
    fx.editDraft(b.checkout, "doc", "Second words.");
    const first = await h.add({ branch: b.branch });
    const back = await h.waitEntry(first.id, settled);
    assert.equal(back.state, "needs-fix", `${back.state}: ${back.reason}`);
    assert.match(back.reason ?? "", /drafts don't fit/);
    assert.equal(back.commit, b.commit);
    const before = await h.view();
    assert.ok(!(before.ready ?? []).some((r) => r.branch === b.branch), "no Land at the sent-back commit before its drafts change");
    // The chat fixes its draft: no commit.
    fx.noteDraft(b.checkout, "doc");
    const v = await h.waitView(
      (x) => (x.ready ?? []).some((r) => r.branch === b.branch && r.commit === b.commit) && x.needsFix.some((e) => e.id === first.id && e.redrafted === true),
      "the branch reads Ready again at the same commit, its sent-back entry redrafted",
      30_000,
    );
    assert.equal(v.needsFix.find((e) => e.id === first.id)?.sentBackFor, "drafts", "the entry records why it was sent back");
    // Land This Commit Again: an ordinary new approval of the same commit, with the current drafts.
    const again = await h.add({ branch: b.branch, commit: b.commit });
    assert.notEqual(again.id, first.id);
    const landed = await h.waitEntry(again.id, settled);
    assert.equal(landed.state, "landed", `${landed.state}: ${landed.reason}`);
    assert.equal(landed.commit, b.commit);
    assert.match(fx.fileAt(landed.landed!.sha, ".sova/spec/claims/b/doc.md") ?? "", /Second words/);
  });

  test("S12d: Remove from Queue on a sent-back entry: cancelled, nothing deleted; the branch reads as itself", async () => {
    const { fx, h } = await setup();
    await fx.withSpec();
    const b = fx.branch("doc", { "README.md": "# doc\n" });
    fx.draft(b.checkout, "doc", "First words.");
    fx.editDraft(b.checkout, "doc", "Second words.");
    const first = await h.add({ branch: b.branch });
    assert.equal((await h.waitEntry(first.id, settled)).state, "needs-fix");
    const removed = await h.cancel(first.id);
    assert.equal(removed.state, "cancelled");
    assert.equal(removed.reason, "removed by you");
    assert.ok(existsSync(b.checkout), "the folder stays");
    assert.ok(existsSync(join(b.checkout, ".sova/spec/drafts/doc")), "the drafts stay");
    assert.equal(git(fx.project, ["rev-parse", `refs/heads/${b.branch}`]).trim(), b.commit, "the branch stays");
    assert.ok(existsSync(h.runDir(removed.run!)), "the run's logs stay");
    const v = await h.view();
    assert.ok(!v.needsFix.some((e) => e.id === first.id), "no longer sent back");
  });

  test("S13: cancel while queued (never runs) and while checking (run aborted, master unmoved, the next entry runs)", async () => {
    const { fx, h } = await setup();
    const base = fx.head();
    const a = fx.branch("a", { "tests/g.txt": "gate a\n" });
    const b = fx.branch("b", { "b.txt": "b\n" });
    const c = fx.branch("c", { "c.txt": "c\n" });
    const ea = await h.add({ branch: a.branch });
    await until("a at its gate", () => fx.atGate("a"));
    const eb = await h.add({ branch: b.branch });
    const ec = await h.add({ branch: c.branch });
    assert.equal((await h.cancel(eb.id)).state, "cancelled");
    assert.equal((await h.cancel(ea.id)).state, "cancelled");
    assert.equal(fx.head(), base, "master unmoved by the aborted run");
    const lc = await h.waitEntry(ec.id, settled);
    assert.equal(lc.state, "landed", `${lc.state}: ${lc.reason}`);
    assert.ok(!fx.isAncestor(a.commit, lc.landed!.sha) && !fx.isAncestor(b.commit, lc.landed!.sha));
    assert.equal((await h.entry(eb.id)).runs.length, 0, "the cancelled queued entry never ran");
    const ra = h.run((await h.entry(ea.id)).run!);
    assert.ok(["void", "cancelled"].includes(ra.verdict), `a's run was aborted (${ra.verdict})`);
  });

  test("S16: typed 'land it' in the branch's own chat queues the branch at that commit", async () => {
    const { fx, h } = await setup();
    const b = fx.branch("typed", { "t.txt": "t\n" });
    const did = await h.typed({ branch: b.branch, commit: b.commit });
    assert.ok(did.some((d) => /queued/.test(d)), did.join("; "));
    const v = await h.view();
    const e = [...v.waiting, ...(v.current ? [] : [])].find((x) => x.branch === b.branch) ?? (await h.entry(v.current!.entry));
    assert.equal(e.commit, b.commit);
    assert.equal(e.approval.by, "typed");
    assert.equal((await h.waitEntry(e.id, settled)).state, "landed");
    assert.deepEqual(await h.ingest(), [], "each go-ahead is taken once");
  });

  test("S16b: typed 'land it, skip review' queues with the review skipped", async () => {
    let reviewed = 0;
    const { fx, h } = await setup({ review: true }, { reviewer: async () => (reviewed++, { verdict: "blocking", text: "would block" }) });
    const b = fx.branch("typed", { "t.txt": "t\n" });
    await h.typed({ branch: b.branch, commit: b.commit, withoutReview: true });
    const v = await h.view();
    const id = v.waiting.find((x) => x.branch === b.branch)?.id ?? v.current!.entry;
    const e = await h.entry(id);
    assert.equal(e.approval.withoutReview, true);
    assert.equal((await h.waitEntry(id, settled)).state, "landed");
    assert.equal(reviewed, 0, "the reviewer never ran");
  });

  test("S27: a project not set up: the approval is refused 'Not set up'; nothing runs", async () => {
    const { fx, h } = await setup({ checks: "unset" });
    const b = fx.branch("x", { "x.txt": "x\n" });
    const r = await h.tryAdd({ branch: b.branch });
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.message, /not set up/i);
    assert.equal((await h.view()).checks, "unset");
    assert.equal(fx.calls().length, 0);
  });

  test("S30: refusals: the target itself, nothing ahead, a TEMP head, uncommitted files; a second approval of one commit is one entry", async () => {
    const { fx, h } = await setup();
    assert.equal((await h.tryAdd({ branch: fx.target })).ok, false, "the target itself");
    git(fx.project, ["branch", "feat/empty", fx.target]);
    assert.equal((await h.tryAdd({ branch: "feat/empty" })).ok, false, "nothing ahead");
    const t = fx.branch("temp", { "t.txt": "t\n" }, { message: "TEMP: wip" });
    assert.equal((await h.tryAdd({ branch: t.branch })).ok, false, "a TEMP head");
    const u = fx.branch("dirty", { "u.txt": "u\n" });
    writeFileSync(join(u.checkout, "u.txt"), "uncommitted\n");
    const ru = await h.tryAdd({ branch: u.branch });
    assert.equal(ru.ok, false, "uncommitted files");
    const hold = fx.branch("hold", { "tests/h.txt": "gate hold\n" });
    await h.add({ branch: hold.branch });
    await until("held", () => fx.atGate("hold"));
    const b = fx.branch("b", { "b.txt": "b\n" });
    const e1 = await h.add({ branch: b.branch });
    const e2 = await h.add({ branch: b.branch });
    assert.equal(e2.id, e1.id, "the same commit approved twice is one entry");
    assert.equal((await h.view()).waiting.filter((x) => x.branch === b.branch).length, 1);
    fx.openGate("hold");
  });
});
