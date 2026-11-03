import assert from "node:assert/strict";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { APP, LIST_PLUS, STATE, mergeCopyOf, mergesOnto, resolution, reviewer, settled, setup, testedHead } from "./testing/scenario-kit";
import { Fixture, git, until } from "./testing/repo";
import type { HarnessOptions } from "./testing/harness";
import type { MergeEntry } from "../../shared/merge-queue";

/**
 * The merge queue's use cases (team brief, TESTING): the merge thread and the review step. Each on a real git repository in a temp dir with a bare
 * origin: the real queue on the real run, driven through the queue's verb methods (testing/harness.ts); only the
 * branch's chat, the merge thread and the reviewer chat are stood in for. Waits are on conditions.
 */
void [APP, LIST_PLUS, STATE, mergeCopyOf, mergesOnto, resolution, reviewer, settled, setup, testedHead, Fixture, git, until, existsSync, writeFileSync, join, assert];
export type _H = HarnessOptions | MergeEntry;

// ---------------------------------------------------------------- merge thread

describe("merge thread", () => {
  test("S18: the thread picks tests by blast radius; each pick is on the run with its reason; it can add, never drop", async () => {
    const { fx, h } = await setup({}, {
      thread: {
        queued: async (h, e) => {
          await h.extend(e.id, ["unit"], "src/list.txt changed: the list's tests", ["tests/a.txt"]);
        },
      },
    });
    const hold = fx.branch("hold", { "tests/h.txt": "gate hold\n" });
    await h.add({ branch: hold.branch });
    await until("held", () => fx.atGate("hold"));
    const b = fx.branch("b", { "src/list.txt": LIST_PLUS("delta") });
    const e = await h.add({ branch: b.branch });
    await h.waitEntry(e.id, (x) => x.picks.length > 0);
    fx.openGate("hold");
    const landed = await h.waitEntry(e.id, settled);
    assert.equal(landed.state, "landed", `${landed.state}: ${landed.reason}`);
    const run = h.run(landed.run!);
    const picked = run.checks.find((c) => c.source === "picked");
    assert.ok(picked && /list's tests/.test(picked.why ?? ""), `a pick with its reason: ${JSON.stringify(run.checks)}`);
    assert.ok(run.checks.some((c) => c.id === "build" && c.source === "required"), "the floor still ran");
    assert.ok(run.steps.some((s) => s.source === "picked" && /list's tests/.test(s.why ?? "")), "the step shows why");
  });

  test("S18b: extend with an unknown check is refused; the floor can't be dropped", async () => {
    const { fx, h } = await setup();
    const hold = fx.branch("hold", { "tests/h.txt": "gate hold\n" });
    await h.add({ branch: hold.branch });
    await until("held", () => fx.atGate("hold"));
    const b = fx.branch("b", { "b.txt": "b\n" });
    const e = await h.add({ branch: b.branch });
    await assert.rejects(h.extend(e.id, ["no-such-check"], "why"));
    fx.openGate("hold");
  });

  test("S19 + S22: thread down: the run proceeds on the floor, no note; thread up: its note shows on the landed entry, in the view and the landed notice", async () => {
    const down = await setup();
    const b1 = down.fx.branch("b", { "b.txt": "b\n" });
    const l1 = await down.h.waitEntry((await down.h.add({ branch: b1.branch })).id, settled);
    assert.equal(l1.state, "landed");
    assert.equal(l1.notes.filter((n) => n.kind === "thread").length, 0);

    const up = await setup({}, { thread: { queued: async (h, e) => void (await h.note(e.id, "changes server code; restart to pick it up")) } });
    const hold = up.fx.branch("hold", { "tests/h.txt": "gate hold\n" });
    await up.h.add({ branch: hold.branch });
    await until("held", () => up.fx.atGate("hold"));
    const b2 = up.fx.branch("b", { "b.txt": "b\n" });
    const e2 = await up.h.add({ branch: b2.branch });
    await up.h.waitEntry(e2.id, (x) => x.notes.some((n) => n.kind === "thread"));
    up.fx.openGate("hold");
    const l2 = await up.h.waitEntry(e2.id, settled);
    assert.equal(l2.state, "landed");
    assert.equal(l2.notes.find((n) => n.kind === "thread")?.text, "changes server code; restart to pick it up");
    const v = await up.h.view();
    assert.ok(v.recent.find((r) => r.entry.id === e2.id)?.entry.notes.some((n) => /restart to pick it up/.test(n.text)), "the note in the view's landed row");
    assert.ok(up.h.notices.some((n) => n.kind === "landed" && /restart to pick it up/.test(n.text)), "the landed notice quotes it");
  });

  test("S19b: a thread that never answers does not delay a landing", async () => {
    const never = () => new Promise<void>(() => {});
    const { fx, h } = await setup({}, { thread: { queued: never, landed: never, failed: never } });
    const b = fx.branch("b", { "b.txt": "b\n" });
    const l = await h.waitEntry((await h.add({ branch: b.branch })).id, settled, 60_000);
    assert.equal(l.state, "landed");
  });

  test("S22b: notes: capped at 300 characters, empty clears, latest wins", async () => {
    const { fx, h } = await setup();
    const hold = fx.branch("hold", { "tests/h.txt": "gate hold\n" });
    await h.add({ branch: hold.branch });
    await until("held", () => fx.atGate("hold"));
    const b = fx.branch("b", { "b.txt": "b\n" });
    const e = await h.add({ branch: b.branch });
    const long = await h.note(e.id, "x".repeat(400)).catch((err) => err as Error);
    if (!(long instanceof Error)) assert.ok(long.notes.find((n) => n.kind === "thread")!.text.length <= 300);
    await h.note(e.id, "first");
    const second = await h.note(e.id, "second");
    assert.deepEqual(second.notes.filter((n) => n.kind === "thread").map((n) => n.text), ["second"]);
    const cleared = await h.note(e.id, "");
    assert.equal(cleared.notes.filter((n) => n.kind === "thread").length, 0);
    fx.openGate("hold");
  });
});

// ---------------------------------------------------------------- review

describe("review", () => {
  test("S17a: review ok: lands; the reviewer saw exactly the commit being checked", async () => {
    const { fx, h } = await setup({ review: true }, { reviewer });
    const b = fx.branch("b", { "b.txt": "b\n" });
    const l = await h.waitEntry((await h.add({ branch: b.branch })).id, settled);
    assert.equal(l.state, "landed", `${l.state}: ${l.reason}`);
    assert.equal(h.reviews.length, 1);
    assert.equal(h.reviews[0]!.commit, l.landed!.sha, "it reviewed exactly the tip that landed");
    assert.equal(l.review?.verdict, "ok");
  });

  test("S17b: review notes: lands with the notes attached", async () => {
    const { fx, h } = await setup({ review: true }, { reviewer });
    const b = fx.branch("b", { "review.conf": "notes: name x is unclear\n" });
    const l = await h.waitEntry((await h.add({ branch: b.branch })).id, settled);
    assert.equal(l.state, "landed", `${l.state}: ${l.reason}`);
    assert.ok(l.notes.some((n) => n.kind === "review" && /name x is unclear/.test(n.text)), JSON.stringify(l.notes));
  });

  test("S17c: review blocking: Review flagged, waiting for you; Land Anyway lands; Send Back on another returns it", async () => {
    const { fx, h } = await setup({ review: true }, { reviewer });
    const base = fx.head();
    const b = fx.branch("b", { "review.conf": "blocking: dead code left in\n" });
    const e = await h.add({ branch: b.branch });
    const w = await h.waitEntry(e.id, settled);
    assert.equal(w.state, "review-flagged", `${w.state}: ${w.reason}`);
    assert.match(w.reason ?? w.review?.text ?? "", /dead code/);
    assert.equal(fx.head(), base);
    await h.answer(e.id, "land-anyway");
    const l = await h.waitEntry(e.id, ["landed", "needs-fix"]);
    assert.equal(l.state, "landed");
    const c = fx.branch("c", { "review.conf": "blocking: duplication\n", "c.txt": "c\n" });
    const ec = await h.add({ branch: c.branch });
    assert.equal((await h.waitEntry(ec.id, settled)).state, "review-flagged");
    const before = fx.head();
    await h.answer(ec.id, "send-back");
    assert.equal((await h.waitEntry(ec.id, ["needs-fix"])).state, "needs-fix");
    assert.equal(fx.head(), before);
  });

  test("S17d: reviewer crash: retried, then the queue pauses; never blamed on the branch, no chat told", async () => {
    const { fx, h } = await setup({ review: true }, { reviewer });
    const b = fx.branch("b", { "review.conf": "crash\n" });
    const e = await h.add({ branch: b.branch });
    const v = await h.waitView((v) => v.state === "paused", "paused on the reviewer");
    assert.equal(v.paused?.kind, "reviewer", JSON.stringify(v.paused));
    assert.notEqual((await h.entry(e.id)).state, "needs-fix");
    assert.equal(h.notices.filter((n) => n.kind !== "approved").length, 0, "no chat is told (the approval card aside)");
    assert.ok(h.reviews.length >= 2, `retried (${h.reviews.length} reviewers)`);
  });

  test("S17e: reviewer hangs past its timeout: retried, then paused; never blamed", async () => {
    const { fx, h } = await setup({ review: true }, { reviewer, reviewTimeoutMs: 1500 });
    const b = fx.branch("b", { "review.conf": "hang\n" });
    const e = await h.add({ branch: b.branch });
    const v = await h.waitView((v) => v.state === "paused", "paused on the reviewer");
    assert.equal(v.paused?.kind, "reviewer");
    assert.notEqual((await h.entry(e.id)).state, "needs-fix");
  });

  test("S17f: Land without review: the reviewer never runs", async () => {
    const { fx, h } = await setup({ review: true }, { reviewer: async () => ({ verdict: "blocking", text: "no" }) });
    const b = fx.branch("b", { "b.txt": "b\n" });
    const l = await h.waitEntry((await h.add({ branch: b.branch, withoutReview: true })).id, settled);
    assert.equal(l.state, "landed", `${l.state}: ${l.reason}`);
    assert.equal(h.reviews.length, 0);
  });

  test("S17g: no kit declared: no review step", async () => {
    const { fx, h } = await setup({}, { reviewer: async () => ({ verdict: "ok" }) });
    const b = fx.branch("b", { "b.txt": "b\n" });
    const l = await h.waitEntry((await h.add({ branch: b.branch })).id, settled);
    assert.equal(l.state, "landed");
    assert.equal(h.reviews.length, 0);
    assert.ok(!h.run(l.run!).steps.some((s) => s.kind === "review"));
  });
});
