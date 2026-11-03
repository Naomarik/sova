import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { APP, settled, setup } from "./testing/scenario-kit";
import { git } from "./testing/repo";
import { draftsLeft } from "../spec-drafts-state";
import { backfillLandedDrafts } from "./landed-drafts";

/**
 * A branch the queue landed with its spec drafts: the drafts stay in the branch folder, marked with the landing's
 * receipt, and read as landed (no "its spec drafts didn't make it"); without the receipt, or once edited, they don't.
 * The real queue on the real run (testing/harness.ts) on a real git repository.
 */

/** Ancestry asked of git in the branch folder, as readiness asks it. */
const ancestor = async (commit: string, ref: string, cwd: string) => {
  try {
    git(cwd, ["merge-base", "--is-ancestor", commit, ref]);
    return true;
  } catch {
    return false;
  }
};
const draftJson = (checkout: string, name: string) => JSON.parse(readFileSync(join(checkout, ".sova/spec/drafts", name, "draft.json"), "utf8")) as { promotions: unknown[]; landed?: { commit: string; hash: string; target: string } };

describe("drafts a queue landing made official", () => {
  test("landed with its drafts: the branch folder's drafts carry the landing's receipt and read as landed", async () => {
    const { fx, h } = await setup();
    await fx.withSpec();
    const b = fx.branch("doc", { "src/app.txt": APP("line 3 changed") });
    fx.draft(b.checkout, "doc");
    assert.deepEqual(await draftsLeft(b.checkout, ancestor), ["doc"], "before the landing the draft isn't official");
    const e = await h.add({ branch: b.branch });
    const landed = await h.waitEntry(e.id, settled);
    assert.equal(landed.state, "landed", `${landed.state}: ${landed.reason}`);
    const tip = fx.head();
    assert.match(fx.fileAt(tip, ".sova/spec/claims/b/doc.md") ?? "", /The doc feature does its one thing/);
    const d = draftJson(b.checkout, "doc");
    assert.equal(d.landed?.commit, tip, "the receipt names the spec commit that landed");
    assert.equal(d.landed?.target, fx.target);
    assert.ok(d.promotions.length > 0, "the spec tool's own promotion receipt is copied back");
    assert.deepEqual(await draftsLeft(b.checkout, ancestor), [], "a landed draft doesn't count as lost");
    // A receipt whose commit isn't on the branch it names speaks for nothing.
    const file = join(b.checkout, ".sova/spec/drafts/doc/draft.json");
    git(fx.project, ["branch", "elsewhere", `${tip}~1`]);
    writeFileSync(file, JSON.stringify({ ...d, landed: { ...d.landed, target: "elsewhere" } }, null, 2));
    assert.deepEqual(await draftsLeft(b.checkout, ancestor), ["doc"]);
  });

  test("a draft edited after its landing reads as not landed again", async () => {
    const { fx, h } = await setup();
    await fx.withSpec();
    const b = fx.branch("doc", { "src/app.txt": APP("line 3 changed") });
    fx.draft(b.checkout, "doc");
    const e = await h.add({ branch: b.branch });
    const landed = await h.waitEntry(e.id, settled);
    assert.equal(landed.state, "landed", `${landed.state}: ${landed.reason}`);
    assert.deepEqual(await draftsLeft(b.checkout, ancestor), []);
    writeFileSync(join(b.checkout, ".sova/spec/drafts/doc/spec/claims/b/doc.md"), "# §b/doc\n\nThe doc feature now does two things.\n");
    assert.deepEqual(await draftsLeft(b.checkout, ancestor), ["doc"], "the receipt no longer speaks for the edited draft");
  });

  test("landed without its specs: no receipt, and the drafts still read as not landed", async () => {
    const { fx, h } = await setup();
    await fx.withSpec();
    const b = fx.branch("doc", { "src/app.txt": APP("line 3 changed") });
    fx.draft(b.checkout, "doc");
    const e = await h.add({ branch: b.branch, withoutSpecs: true });
    const landed = await h.waitEntry(e.id, settled);
    assert.equal(landed.state, "landed", `${landed.state}: ${landed.reason}`);
    assert.equal(fx.fileAt(fx.head(), ".sova/spec/claims/b/doc.md"), null, "no docs landed");
    assert.equal(draftJson(b.checkout, "doc").landed, undefined);
    assert.deepEqual(await draftsLeft(b.checkout, ancestor), ["doc"]);
  });

  test("a run that fails after its docs commit writes no receipt", async () => {
    const { fx, h } = await setup();
    await fx.withSpec();
    const b = fx.branch("doc", { "src/app.txt": APP("line 3 changed"), "tests/a.txt": "fail" });
    fx.draft(b.checkout, "doc");
    const e = await h.add({ branch: b.branch });
    const done = await h.waitEntry(e.id, settled);
    assert.notEqual(done.state, "landed", `${done.state}: ${done.reason}`);
    assert.equal(h.run(done.run!).steps.find((x) => x.kind === "docs")?.result, "passed", "the docs commit was made before the failing check");
    assert.equal(draftJson(b.checkout, "doc").landed, undefined);
    assert.deepEqual(await draftsLeft(b.checkout, ancestor), ["doc"]);
  });

  test("the one-off backfill marks a draft that landed before receipts, once; never one edited since", async () => {
    const { fx, h } = await setup();
    await fx.withSpec();
    const b = fx.branch("doc", { "src/app.txt": APP("line 3 changed") });
    fx.draft(b.checkout, "doc");
    const e = await h.add({ branch: b.branch });
    const landed = await h.waitEntry(e.id, settled);
    assert.equal(landed.state, "landed", `${landed.state}: ${landed.reason}`);
    const spec = fx.head();
    // As a branch landed before this change left it: no receipt in the folder.
    const file = join(b.checkout, ".sova/spec/drafts/doc/draft.json");
    const { landed: _gone, ...before } = draftJson(b.checkout, "doc");
    writeFileSync(file, JSON.stringify(before, null, 2) + "\n");
    assert.deepEqual(await draftsLeft(b.checkout, ancestor), ["doc"]);
    const dry = backfillLandedDrafts({ worktree: b.checkout, commit: spec.slice(0, 9), target: fx.target, write: false });
    assert.deepEqual(dry.rows, [{ draft: "doc", state: "marked" }]);
    assert.equal(draftJson(b.checkout, "doc").landed, undefined, "a dry run writes nothing");
    backfillLandedDrafts({ worktree: b.checkout, commit: spec, target: fx.target, write: true });
    assert.equal(draftJson(b.checkout, "doc").landed?.commit, spec);
    assert.deepEqual(await draftsLeft(b.checkout, ancestor), []);
    const again = readFileSync(file, "utf8");
    assert.deepEqual(backfillLandedDrafts({ worktree: b.checkout, commit: spec, target: fx.target, write: true }).rows, [{ draft: "doc", state: "current" }]);
    assert.equal(readFileSync(file, "utf8"), again, "idempotent");
    // Not official at a commit before the docs landed: left alone.
    writeFileSync(file, JSON.stringify(before, null, 2) + "\n");
    const early = backfillLandedDrafts({ worktree: b.checkout, commit: landed.landed!.from, target: fx.target, write: true });
    assert.equal(early.rows[0]?.state, "not-landed");
    assert.equal(draftJson(b.checkout, "doc").landed, undefined);
    // Edited since it landed: not what the spec at that commit says, so left alone, at the very commit that landed it.
    const claim = join(b.checkout, ".sova/spec/drafts/doc/spec/claims/b/doc.md");
    const said = readFileSync(claim, "utf8");
    writeFileSync(claim, "# §b/doc\n\nThe doc feature now does two things.\n");
    const edited = backfillLandedDrafts({ worktree: b.checkout, commit: spec, target: fx.target, write: true });
    assert.equal(edited.rows[0]?.state, "not-landed");
    assert.equal(draftJson(b.checkout, "doc").landed, undefined, "no receipt for a draft edited since");
    assert.deepEqual(await draftsLeft(b.checkout, ancestor), ["doc"]);
    writeFileSync(claim, said);
    const after = fx.commitIn(b.checkout, { "src/later.txt": "later\n" }, "doc: after landing");
    assert.throws(() => backfillLandedDrafts({ worktree: b.checkout, commit: after, target: fx.target, write: true }), /is not on/);
  });
});
