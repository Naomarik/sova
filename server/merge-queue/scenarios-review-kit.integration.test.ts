import assert from "node:assert/strict";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { mergeCopyOf, reviewer, settled, setup } from "./testing/scenario-kit";
import { git, until } from "./testing/repo";
import type { HarnessOptions } from "./testing/harness";
import { reviewCopyPath } from "./scratch";

/**
 * The review kit's freedom (§app.merge-queue/review-kit): what the branch's own kit declares, the run saying plainly that
 * the branch changed its own review, the kit's hash and model on each verdict, and the reviewer that fixes what it finds
 * (merge.reviewFixes) going the way a chat's fix goes. Real queue, real run, real git; the reviewer chat and the merge
 * thread are stand-ins (testing/harness.ts). The confined start of a reviewer with a shell is reviewer.test.ts's.
 */

const KIT = ".sova/playbook-config/review";

/** A fixer stand-in: in its own folder, a blocking `review.conf` is fixed (made ok) and committed, then answered
 *  blocking with the finding; anything else as the plain stand-in answers it. `mode` "ref-only": it writes the hidden
 *  fix ref and commits nothing. */
const fixer =
  (mode: "commit" | "ref-only" = "commit"): HarnessOptions["reviewer"] =>
  async (o) => {
    const own = o.start.own;
    const conf = git(o.copy, ["show", `${o.commit}:review.conf`]).trim();
    if (!own?.fixes || !conf.startsWith("blocking")) return reviewer!(o);
    const entry = /-review-(mq_[0-9a-z]+)$/.exec(o.copy)?.[1];
    // A commit on top of the branch's that HEAD never moves to: a fix only if the hidden ref were believed.
    if (mode === "ref-only") git(o.copy, ["update-ref", `refs/sova-mq/review-fix/${entry}`, git(o.copy, ["-c", "user.name=R", "-c", "user.email=r@example.invalid", "commit-tree", "-p", "HEAD", "-m", "not a fix", "HEAD^{tree}"])]);
    else {
      writeFileSync(join(o.copy, "review.conf"), "ok\n");
      git(o.copy, ["add", "review.conf"]);
      git(o.copy, ["-c", "user.name=R", "-c", "user.email=r@example.invalid", "commit", "-q", "-m", "review: drop the dead code"]);
    }
    return { verdict: "blocking", text: `Dead code left in.\n- [dead-code] review.conf:1: ${conf.slice(9).trim()}` };
  };

describe("review kit", () => {
  test("the branch's own kit runs: the run says it changed its own review (and gave its reviewer a shell), each pass is a fresh reviewer in a folder of its own, and the verdict records the kit's hash and model", async () => {
    const { fx, h } = await setup({ review: true }, { reviewer });
    const b = fx.branch("b", { [`${KIT}/PLAYBOOK.md`]: "---\ntitle: Review kit\npasses: 2\ntools: shell\ntime-limit: 5\n---\n\nReview it.\n" });
    const l = await h.waitEntry((await h.add({ branch: b.branch })).id, settled);
    assert.equal(l.state, "landed", `${l.state}: ${l.reason}`);
    const run = h.run(l.run!);
    const hash = git(fx.project, ["rev-parse", `${l.landed!.sha}:${KIT}`]);
    assert.deepEqual(
      { path: run.review?.path, hash: run.review?.hash, model: run.review?.model, decl: run.review?.decl, changed: run.review?.changed, shellByBranch: run.review?.shellByBranch },
      { path: KIT, hash, model: "test/reviewer", decl: { passes: 2, timeLimitMin: 5, tools: ["shell"] }, changed: [{ status: "A", path: `${KIT}/PLAYBOOK.md` }], shellByBranch: true },
    );
    assert.equal(l.review?.kit?.hash, hash, "the verdict carries the kit's hash");
    assert.equal(l.review?.kit?.model, "test/reviewer", "and the model it ran on");
    const step = run.steps.find((s) => s.id === "review")!;
    assert.match(step.why ?? "", /this branch changed its own review: A \.sova\/playbook-config\/review\/PLAYBOOK\.md; this branch gave its reviewer a shell/);
    assert.match(h.log(run.id, "review"), /\+passes: 2/, "the kit's diff is in the step's log");
    assert.equal(h.reviews.length, 2, "two passes, two reviewers");
    assert.deepEqual(h.reviews.map((r) => [r.start.profile, r.start.pass?.n, r.start.copy]), [1, 2].map((n) => ["merge-reviewer-shell", n, reviewCopyPath(fx.project, l.id)]), "a shell never runs in the merge copy");
    assert.ok(!existsSync(reviewCopyPath(fx.project, l.id)), "its folder goes when the review ends");
  });

  test("a kit the branch didn't touch: nothing said about it, the default read-only reviewer in the merge copy", async () => {
    const { fx, h } = await setup({ review: true }, { reviewer });
    const b = fx.branch("b", { "b.txt": "b\n" });
    const l = await h.waitEntry((await h.add({ branch: b.branch })).id, settled);
    assert.equal(l.state, "landed", `${l.state}: ${l.reason}`);
    const run = h.run(l.run!);
    assert.equal(run.review?.changed, undefined);
    assert.equal(run.review?.decl, undefined);
    assert.equal(run.steps.find((s) => s.id === "review")?.why, `review kit ${KIT}`);
    assert.deepEqual(h.reviews.map((r) => [r.start.profile, r.start.own]), [["merge-reviewer", undefined]]);
    assert.equal(h.reviews[0]!.start.copy, mergeCopyOf(fx));
  });

  test("reviewFixes: the reviewer's own commit goes on the branch, the thread checks it like a chat's fix, the checks run again, and it lands re-pinned with no new Land", async () => {
    let checked = "";
    const { fx, h } = await setup({ review: true, merge: { reviewFixes: true } }, { reviewer: fixer(), thread: { fix: async (hh, e, ev) => void ((checked = `${ev.by}:${ev.fixCommit}`), await hh.rule(e.id, { ruling: "checked", request: ev.request! })) } });
    const b = fx.branch("b", { "review.conf": "blocking: dead code left in\n", "b.txt": "b\n" });
    const e = await h.add({ branch: b.branch });
    const l = await h.waitEntry(e.id, (x) => x.state === "landed" && !!x.landed && x.landed.pushed !== "pending");
    const fix = git(fx.project, ["rev-parse", `refs/heads/${b.branch}`]);
    assert.notEqual(fix, b.commit, "the branch moved to the reviewer's fix");
    assert.equal(git(b.checkout, ["rev-parse", "HEAD"]), fix, "its folder fast-forwarded to it");
    assert.equal(git(b.checkout, ["status", "--porcelain"]), "", "and is clean");
    assert.equal(checked, `reviewer:${fix}`, "the thread was asked to check the reviewer's fix");
    assert.equal(l.commit, fix, "the approval re-pinned at the fix");
    assert.deepEqual(l.approval.fixes?.map((f) => [f.commit, f.by]), [[fix, "reviewer"]]);
    const req = l.requests?.find((r) => r.answer?.kind === "fixed");
    assert.ok(req?.answer?.kind === "fixed" && req.answer.by === "reviewer", JSON.stringify(l.requests));
    assert.match(req!.text, /fixed them itself/);
    assert.ok(fx.isAncestor(fix, fx.head()), "what landed holds the fix");
    assert.equal(l.reviews?.at(-1)?.fix?.commit, fix);
    assert.equal(h.reviews.length, 2, "reviewed again after the fix");
    assert.equal(git(fx.project, ["for-each-ref", "refs/sova-mq/review-fix/"]), "", "no hidden ref left behind");
  });

  test("reviewFixes with no merge thread to check it: the fix is on the branch but never lands unchecked", async () => {
    const { fx, h } = await setup({ review: true, merge: { reviewFixes: true } }, { reviewer: fixer() });
    const base = fx.head();
    const b = fx.branch("b", { "review.conf": "blocking: dead code left in\n" });
    const e = await h.add({ branch: b.branch });
    const w = await h.waitEntry(e.id, (x) => x.state === "with-chat" && x.standing?.phase === "waiting-thread");
    assert.notEqual(git(fx.project, ["rev-parse", `refs/heads/${b.branch}`]), b.commit);
    await new Promise((r) => setTimeout(r, 1500));
    assert.equal((await h.entry(e.id)).state, "with-chat");
    assert.equal(fx.head(), base, "nothing landed");
    assert.equal(w.commit, b.commit, "the approval is still at the commit the user approved");
  });

  test("a fix is read from the reviewer's folder only: a hidden ref it wrote with no commit is no fix, and the review goes to the chat as usual", async () => {
    const { fx, h } = await setup({ review: true, merge: { reviewFixes: true } }, { reviewer: fixer("ref-only"), thread: { review: async (hh, e) => void (await hh.rule(e.id, { ruling: "chat-fixes" })) } });
    const b = fx.branch("b", { "review.conf": "blocking: dead code left in\n" });
    const e = await h.add({ branch: b.branch });
    const w = await h.waitEntry(e.id, (x) => x.state === "with-chat" && !!x.requests?.some((r) => r.kind === "fix"));
    assert.equal(git(fx.project, ["rev-parse", `refs/heads/${b.branch}`]), b.commit, "the branch didn't move");
    assert.equal(w.reviews?.at(-1)?.fix, undefined);
    assert.equal(w.requests!.at(-1)!.answer, undefined, "the chat's to answer");
    assert.match(w.requests!.at(-1)!.text, /dead code left in/);
  });

  test("a branch that moved while its reviewer fixed it: the fix isn't taken, the findings go to the chat", async () => {
    let b: ReturnType<typeof import("./testing/repo").Fixture.prototype.branch> | undefined;
    let fxRef: import("./testing/repo").Fixture | undefined;
    const moving: HarnessOptions["reviewer"] = async (o) => {
      const a = await fixer()!(o);
      if (o.start.own?.fixes && fxRef && b) fxRef.commitIn(b.checkout, { "later.txt": "later\n" }, "later work");
      return a;
    };
    const { fx, h } = await setup({ review: true, merge: { reviewFixes: true } }, { reviewer: moving, thread: { review: async (hh, e) => void (await hh.rule(e.id, { ruling: "chat-fixes" })) } });
    fxRef = fx;
    b = fx.branch("b", { "review.conf": "blocking: dead code left in\n" });
    const e = await h.add({ branch: b.branch });
    const w = await h.waitEntry(e.id, (x) => x.state === "with-chat" && !!x.requests?.some((r) => r.kind === "fix"));
    await until("findings with the chat", async () => !(await h.entry(e.id)).requests!.at(-1)!.answer);
    assert.equal(w.reviews?.at(-1)?.fix, undefined);
    assert.match(git(fx.project, ["log", "-1", "--format=%s", `refs/heads/${b.branch}`]), /later work/, "the branch is the chat's, as it left it");
  });
});
