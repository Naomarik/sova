import assert from "node:assert/strict";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { APP, LIST_PLUS, STATE, mergeCopyOf, mergesOnto, resolution, reviewer, settled, setup, testedHead } from "./testing/scenario-kit";
import { Fixture, git, until } from "./testing/repo";
import type { HarnessOptions } from "./testing/harness";
import type { MergeEntry } from "../../shared/merge-queue";

/**
 * The merge queue's use cases (team brief, TESTING): blame and the checks a project declares. Each on a real git repository in a temp dir with a bare
 * origin: the real queue on the real run, driven through the queue's verb methods (testing/harness.ts); only the
 * branch's chat, the merge thread and the reviewer chat are stood in for. Waits are on conditions.
 */
void [APP, LIST_PLUS, STATE, mergeCopyOf, mergesOnto, resolution, reviewer, settled, setup, testedHead, Fixture, git, until, existsSync, writeFileSync, join, assert];
export type _H = HarnessOptions | MergeEntry;

// ---------------------------------------------------------------- blame

describe("blame", () => {
  test("S4: a test the branch broke: rerun on the tip and on master alone in the same copy, blamed on the branch, master unmoved, the owner told", async () => {
    const { fx, h } = await setup();
    const base = fx.head();
    const b = fx.branch("red", { "tests/b.txt": "fail\n" });
    const mark = fx.calls().length;
    const e = await h.add({ branch: b.branch });
    const done = await h.waitEntry(e.id, settled);
    assert.equal(done.state, "needs-fix", `${done.state}: ${done.reason}`);
    assert.match(done.reason ?? "", /tests\/b\.txt/);
    assert.equal(fx.head(), base, "master unmoved");
    assert.equal(fx.originHead(), base, "nothing pushed");
    const calls = fx.callsSince(mark).filter((c) => c.script === "unit");
    assert.ok(calls.every((c) => c.cwd === mergeCopyOf(fx)), "every run of the check, reruns included, in the merge copy");
    const reruns = calls.filter((c) => c.argv.includes("tests/b.txt"));
    assert.ok(reruns.some((c) => c.head === base && c.result === "pass"), "the failing file passed on master alone");
    assert.ok(reruns.some((c) => c.head !== base && c.result === "fail"), "and failed again on the merge");
    assert.equal(h.run(done.run!).blame, "branch");
    const told = h.notices.filter((n) => n.branch === b.branch && n.kind === "needs-fix");
    assert.equal(told.length, 1, "told once");
    assert.match(told[0]!.text, /tests\/b\.txt/, "the owner chat is told which test");
  });

  test("S5: a test failing on master too: noted on the landing, does not block, nobody told to fix", async () => {
    const { fx, h } = await setup({ files: { "tests/a.txt": "fail\n" } });
    const b = fx.branch("ok", { "b.txt": "b\n" });
    const e = await h.add({ branch: b.branch });
    const landed = await h.waitEntry(e.id, settled);
    assert.equal(landed.state, "landed", `${landed.state}: ${landed.reason}`);
    assert.ok(landed.notes.some((n) => n.kind === "master-red" && /tests\/a\.txt/.test(n.text)), `noted: ${JSON.stringify(landed.notes)}`);
    assert.equal(h.notices.filter((n) => n.kind === "needs-fix").length, 0);
  });

  test("S5e: a whole check red on master too and naming nothing (build): Can't tell whose failure · waiting for you; never landed, never blamed, no pause, no chat told; Send Back hands it back", async () => {
    const { fx, h } = await setup({ files: { "build.conf": "broken\n" } });
    const before = fx.head();
    const b = fx.branch("ok", { "b.txt": "b\n" });
    const e = await h.add({ branch: b.branch });
    const s = await h.waitEntry(e.id, settled);
    const v = await h.view();
    assert.equal(s.state, "unattributed", `${s.state}: ${s.reason}; queue ${v.state} ${JSON.stringify(v.paused)}`);
    assert.notEqual(v.state, "paused", "the queue doesn't pause");
    assert.ok(v.needsYou.some((x) => x.id === e.id), "waits in Needs you");
    assert.match(s.reason ?? "", /can't tell whose failure/i);
    assert.equal(fx.head(), before, "master unmoved");
    assert.equal(h.notices.filter((n) => n.kind !== "approved").length, 0, "no chat told while it waits");
    const c = fx.branch("other", { "c.txt": "c\n" });
    const ec = await h.add({ branch: c.branch });
    const sc = await h.waitEntry(ec.id, settled);
    assert.equal(sc.state, "unattributed", "the line moves on past it (the next branch is judged on its own)");
    const back = await h.answer(e.id, "send-back");
    assert.equal(back.state, "needs-fix", `${back.state}: ${back.reason}`);
    assert.ok(h.notices.some((n) => n.kind === "sent-back" && n.branch === b.branch), "its chat is told on Send Back");
    assert.equal(fx.head(), before);
  });

  test("S5e2: Can't tell whose failure, then Land Anyway: lands the tested tip, pushed", async () => {
    const { fx, h } = await setup({ files: { "build.conf": "broken\n" } });
    const b = fx.branch("ok", { "b.txt": "b\n" });
    const e = await h.add({ branch: b.branch });
    const s = await h.waitEntry(e.id, settled);
    assert.equal(s.state, "unattributed", `${s.state}: ${s.reason}`);
    await h.answer(e.id, "land-anyway");
    const l = await h.waitEntry(e.id, settled);
    assert.equal(l.state, "landed", `${l.state}: ${l.reason}`);
    assert.equal(l.landed?.sha, fx.head());
    assert.ok(fx.isAncestor(b.commit, fx.head()), "the branch is on master");
    assert.equal(fx.originHead(), fx.head(), "pushed");
  });

  test("S5f: names only, the same count on both sides with other names (master fails a; the branch fixes a and breaks b): the branch's, needs a fix naming b", async () => {
    const { fx, h } = await setup({ files: { "unit.names-only": "1\n", "tests/a.txt": "fail\n" } });
    const before = fx.head();
    const b = fx.branch("swap", { "tests/a.txt": "pass\n", "tests/b.txt": "fail\n" });
    const e = await h.add({ branch: b.branch });
    const s = await h.waitEntry(e.id, settled);
    assert.equal(s.state, "needs-fix", `${s.state}: ${s.reason}`);
    assert.match(s.reason ?? "", /b\.txt/);
    assert.doesNotMatch(s.reason ?? "", /\ba\.txt/);
    assert.equal(fx.head(), before, "master unmoved");
  });

  test("S5c: failures named without a file (Kaocha): a branch's NEW failing test is the branch's even while another test is red on master", async () => {
    const { fx, h } = await setup({ files: { "unit.names-only": "1\n", "tests/a.txt": "fail\n" } });
    const before = fx.head();
    const b = fx.branch("newbreak", { "tests/b.txt": "fail\n" });
    const e = await h.add({ branch: b.branch });
    const s = await h.waitEntry(e.id, settled);
    assert.equal(s.state, "needs-fix", `b.txt fails only with the branch, a.txt on master too: ${s.state}: ${s.reason} ${JSON.stringify(s.notes)}`);
    assert.match(s.reason ?? "", /b\.txt/);
    assert.equal(fx.head(), before, "master unmoved");
  });

  test("S5d: failures named without a file, the same ones red on master: noted, lands", async () => {
    const { fx, h } = await setup({ files: { "unit.names-only": "1\n", "tests/a.txt": "fail\n" } });
    const b = fx.branch("ok2", { "b2.txt": "b\n" });
    const e = await h.add({ branch: b.branch });
    const s = await h.waitEntry(e.id, settled);
    assert.equal(s.state, "landed", `${s.state}: ${s.reason}`);
    assert.ok(s.notes.some((n) => n.kind === "master-red"), "noted");
  });

  test("S5g: failures whose file is a bare name, not a repo path (nasabii), red on master alone: a clean branch is never blamed for them", async () => {
    const { fx, h } = await setup({ files: { "unit.basename": "1\n", "tests/a.txt": "fail\n" } });
    const before = fx.head();
    const b = fx.branch("clean", { "doc.txt": "a comment-only change\n" });
    const e = await h.add({ branch: b.branch });
    const s = await h.waitEntry(e.id, settled);
    assert.notEqual(s.state, "needs-fix", `a clean branch blamed for master's red test: ${s.reason}`);
    if (s.state === "landed") assert.ok(s.notes.some((n) => n.kind === "master-red"), `noted as master's: ${JSON.stringify(s.notes)} ${JSON.stringify(h.run(s.run!).steps.map((x) => [x.id, x.result, x.detail]))}`);
    else assert.equal(fx.head(), before);
  });

  test("S26: a flaky test (passes on rerun): noted, lands", async () => {
    const { fx, h } = await setup();
    const b = fx.branch("flaky", { "tests/c.txt": "flaky\n" });
    const e = await h.add({ branch: b.branch });
    const landed = await h.waitEntry(e.id, settled);
    assert.equal(landed.state, "landed", `${landed.state}: ${landed.reason}`);
    assert.ok(landed.notes.some((n) => n.kind === "flaky" && /tests\/c\.txt/.test(n.text)), `noted flaky: ${JSON.stringify(landed.notes)}`);
  });

  test("S6: setup broken on master too: retried once, then paused; nobody blamed, no chat told; the setup log kept from its first line", async () => {
    const { fx, h } = await setup({ files: { "setup.conf": "broken\n" } });
    const base = fx.head();
    const b = fx.branch("ok", { "b.txt": "b\n" });
    const e = await h.add({ branch: b.branch });
    const v = await h.waitView((v) => v.state === "paused", "the queue paused");
    assert.equal(v.paused?.kind, "machine", JSON.stringify(v.paused));
    assert.match(v.paused?.why ?? "", /setup/i);
    const now = await h.entry(e.id);
    assert.equal(now.state, "queued", "back in line, not blamed");
    assert.equal(fx.head(), base);
    assert.equal(h.notices.filter((n) => n.kind !== "approved").length, 0, "no chat is told (the approval card aside)");
    assert.ok(now.runs.length >= 2, `retried once (${now.runs.length} runs)`);
    const run = h.run(now.runs.at(-1)!);
    assert.notEqual(run.blame, "branch");
    const st = run.steps.find((s) => s.kind === "setup" && s.result === "failed")!;
    assert.ok(st, "a failed setup step");
    const lg = h.log(run.id, st.id);
    assert.match(lg, /setup: start/, "the setup log from its first line");
    assert.match(lg, /broken/);
  });

  test("S6b: setup that fails once on the machine: the retry passes and the branch lands, never blamed", async () => {
    const { fx, h } = await setup({ files: { "setup.conf": "broken-once\n" } });
    const b = fx.branch("ok", { "b.txt": "b\n" });
    const e = await h.add({ branch: b.branch });
    const s = await h.waitEntry(e.id, settled);
    assert.equal(s.state, "landed", `${s.state}: ${s.reason}`);
    assert.equal(h.notices.filter((n) => n.kind === "needs-fix").length, 0);
  });

  test("S7: setup broken only by the branch: blamed on the branch, with the setup log; the queue doesn't pause", async () => {
    const { fx, h } = await setup();
    const base = fx.head();
    const b = fx.branch("setup", { "setup.conf": "broken\n" });
    const e = await h.add({ branch: b.branch });
    const s = await h.waitEntry(e.id, (x) => settled(x) || x.runs.length > 2);
    assert.equal(s.state, "needs-fix", `${s.state}: ${s.reason}`);
    assert.match(s.reason ?? "", /setup/i);
    assert.equal(fx.head(), base);
    assert.equal(h.run(s.run!).blame, "branch");
    assert.ok(fx.calls().some((c) => c.script === "setup" && c.head === base && c.result === "pass"), "setup passed on master alone");
    assert.equal((await h.view()).state, "idle", "no pause for a branch's own breakage");
  });

  test("S21: a dependency change runs the offline install step; a broken one is the branch's", async () => {
    const { fx, h } = await setup();
    const good = fx.branch("deps", { "deps.lock": "v2\n" });
    const mark = fx.calls().length;
    const eg = await h.add({ branch: good.branch });
    const lg = await h.waitEntry(eg.id, settled);
    assert.equal(lg.state, "landed", `${lg.state}: ${lg.reason}`);
    assert.ok(fx.callsSince(mark).some((c) => c.script === "install" && c.result === "pass"), "install ran for the new lockfile");
    assert.ok(h.run(lg.run!).steps.some((s) => s.kind === "install"), "an install step on the run");
    const plain = fx.branch("plain", { "p.txt": "p\n" });
    const m2 = fx.calls().length;
    const ep = await h.waitEntry((await h.add({ branch: plain.branch })).id, settled);
    assert.equal(ep.state, "landed");
    assert.ok(!fx.callsSince(m2).some((c) => c.script === "install"), "no install without a lockfile change");
    const bad = fx.branch("deps-bad", { "deps.lock": "v3 broken\n" });
    const s = await h.waitEntry((await h.add({ branch: bad.branch })).id, settled);
    assert.equal(s.state, "needs-fix", `${s.state}: ${s.reason}`);
    assert.equal(h.run(s.run!).blame, "branch");
  });
});

// ---------------------------------------------------------------- what the project declares

describe("checks the project declares", () => {
  test("S14: a project with no tests: lands after a clean merge, labelled No checks declared", async () => {
    const { fx, h } = await setup({ checks: "none" });
    const b = fx.branch("b", { "b.txt": "b\n" });
    const landed = await h.waitEntry((await h.add({ branch: b.branch })).id, settled);
    assert.equal(landed.state, "landed", `${landed.state}: ${landed.reason}`);
    assert.equal((await h.view()).checks, "none");
    assert.equal(h.run(landed.run!).noChecks, true);
    assert.ok(landed.notes.some((n) => n.kind === "no-checks" && /No checks declared/i.test(n.text)), JSON.stringify(landed.notes));
    assert.equal(fx.calls().filter((c) => c.script === "unit" || c.script === "build").length, 0);
  });

  test("S15a: one test command (no service): its runner is the check, in the copy; a red file is rerun by selector", async () => {
    const { fx, h } = await setup({ checks: "test-command" });
    assert.equal((await h.view()).checks, "test-command");
    const b = fx.branch("b", { "b.txt": "b\n" });
    const l = await h.waitEntry((await h.add({ branch: b.branch })).id, settled);
    assert.equal(l.state, "landed", `${l.state}: ${l.reason}`);
    assert.ok(fx.calls().some((c) => c.script === "runner" && c.result === "pass" && c.cwd === mergeCopyOf(fx)));
    const red = fx.branch("red", { "tests/b.txt": "fail\n" });
    const r = await h.waitEntry((await h.add({ branch: red.branch })).id, settled);
    assert.equal(r.state, "needs-fix", `${r.state}: ${r.reason}`);
    assert.ok(fx.calls().some((c) => c.script === "runner" && c.argv.includes("tests/b.txt")), "rerun by selector");
  });
});
