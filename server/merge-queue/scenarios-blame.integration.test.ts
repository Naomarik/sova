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

  test("S5h: a test check broken on master (a usage error, exit 2, no test run on the merge, the tip and master alone): skipped for the branch and flagged, the branch lands; no pause, never Can't tell; a later run that runs tests lifts the flag", async () => {
    const { fx, h } = await setup({ unitIsTestCommand: true, files: { "unit.usage": "1\n" } });
    const b = fx.branch("ok", { "b.txt": "b\n" });
    const e = await h.add({ branch: b.branch });
    const s = await h.waitEntry(e.id, settled);
    const v = await h.view();
    const run = h.run(s.run!);
    const steps = run.steps.map((x) => [x.id, x.result, x.detail]);
    assert.equal(s.state, "landed", `${s.state}: ${s.reason} ${JSON.stringify(steps)}`);
    assert.notEqual(v.state, "paused", "the queue doesn't pause");
    assert.ok(!v.needsYou.some((x) => x.id === e.id), "no entry waits on the user");
    const why = "Unit tests is broken on master: no test ran (unit: --groups needs a value)";
    for (const id of ["check:unit", "rerun-tip:unit", "rerun-master:unit"]) assert.equal(run.steps.find((x) => x.id === id)?.result, "skipped", `${id} reads skipped: ${JSON.stringify(steps)}`);
    const onMaster = run.steps.find((x) => x.id === "rerun-master:unit")!;
    assert.equal(onMaster.detail, why);
    assert.equal(onMaster.broken, true);
    assert.match(h.log(run.id, onMaster.id), /--groups needs a value/, "its log is kept");
    assert.ok(s.notes.some((n) => n.kind === "master-red" && n.text === why), `noted: ${JSON.stringify(s.notes)}`);
    assert.deepEqual(v.heads.targetBroken?.map((x) => [x.check, x.why, x.run, x.step]), [["unit", why, run.id, "rerun-master:unit"]], "flagged in Needs you");
    assert.equal(h.flags.length, 1, "the user is told once");
    assert.equal(h.notices.filter((n) => n.kind === "needs-fix").length, 0, "no chat told to fix anything");
    // A second branch skips it too, and the user isn't told again.
    const c = fx.branch("ok2", { "c.txt": "c\n" });
    const sc = await h.waitEntry((await h.add({ branch: c.branch })).id, settled);
    assert.equal(sc.state, "landed", `${sc.state}: ${sc.reason}`);
    assert.equal(h.flags.length, 1, "told once per broken check");
    // The fix: a branch that makes the check run tests again lands, and the flag is lifted.
    const fix = fx.branch("fix", { "unit.usage": null });
    const sf = await h.waitEntry((await h.add({ branch: fix.branch })).id, settled);
    assert.equal(sf.state, "landed", `${sf.state}: ${sf.reason}`);
    assert.equal((await h.view()).heads.targetBroken, undefined, "lifted once the check runs tests");
  });

  test("S5e3: sent back, then the branch moves on (a merge of master and a fix): the row counts the branch's own 2 commits, says why the newest can't land while its folder is dirty, and the re-land pins the newest commit", async () => {
    const { fx, h } = await setup({ files: { "build.conf": "broken\n" } });
    const b = fx.branch("ok", { "b.txt": "b\n" });
    const e = await h.add({ branch: b.branch });
    assert.equal((await h.waitEntry(e.id, settled)).state, "unattributed");
    assert.equal((await h.answer(e.id, "send-back")).state, "needs-fix");
    // master moves on by three commits, the branch merges them in and commits its fix.
    for (let i = 0; i < 3; i++) fx.commitIn(fx.project, { [`m${i}.txt`]: `${i}\n`, ...(i === 2 ? { "build.conf": "ok\n" } : {}) }, `master ${i}`);
    git(b.checkout, ["merge", "-q", "--no-edit", fx.target]);
    const tip = fx.commitIn(b.checkout, { "b.txt": "b2\n" }, "the fix");
    writeFileSync(join(b.checkout, "scratch.txt"), "x\n");
    const sent = (await h.view()).needsFix.find((x) => x.id === e.id)!;
    assert.equal(sent.newerCommits, 2, "the merge of master and the fix: never master's own three");
    assert.equal(sent.newerBlocked, "1 uncommitted file in its folder: commit or remove them first");
    await assert.rejects(h.add({ branch: b.branch }), /uncommitted/, "Land refuses the newest commit for the same reason");
    git(b.checkout, ["clean", "-fq"]);
    // The reading is kept a few seconds (view() runs often): the row catches up by itself.
    await h.waitView((v) => v.needsFix.find((x) => x.id === e.id)?.newerBlocked === undefined, "clean: nothing blocks it");
    // The re-land posts no commit: the queue pins the branch's newest.
    const again = await h.add({ branch: b.branch });
    assert.equal(again.commit, tip);
    const l = await h.waitEntry(again.id, settled);
    assert.equal(l.state, "landed", `${l.state}: ${l.reason}`);
    assert.ok(fx.isAncestor(tip, fx.head()));
  });

  test("S5i: a test check that exits with no report at all on the merge, the tip and master (a crash midway, or a runner that writes none): real failures may be in there, so never skipped: Can't tell whose failure", async () => {
    const { fx, h } = await setup({ unitIsTestCommand: true, files: { "unit.crash": "1\n" } });
    const before = fx.head();
    const b = fx.branch("ok", { "b.txt": "b\n" });
    const s = await h.waitEntry((await h.add({ branch: b.branch })).id, settled);
    assert.equal(s.state, "unattributed", `${s.state}: ${s.reason}`);
    assert.equal((await h.view()).heads.targetBroken, undefined);
    assert.equal(h.flags.length, 0);
    assert.equal(fx.head(), before, "master unmoved");
    assert.ok(!h.run(s.run!).steps.some((x) => x.result === "skipped" && x.broken), "nothing marked broken");
  });

  test("S5e4: sent back, then the commit is amended (the sent-back commit is no ancestor of the tip): the row says the branch was rewritten, counts nothing, still says why the newest can't land, and the re-land lands the amended commit", async () => {
    const { fx, h } = await setup({ files: { "build.conf": "broken\n" } });
    const b = fx.branch("ok", { "b.txt": "b\n" });
    const e = await h.add({ branch: b.branch });
    assert.equal((await h.waitEntry(e.id, settled)).state, "unattributed");
    assert.equal((await h.answer(e.id, "send-back")).state, "needs-fix");
    fx.commitIn(fx.project, { "build.conf": "ok\n" }, "master fixes its build");
    git(b.checkout, ["commit", "-q", "--amend", "-m", "ok: amended"]);
    const tip = git(b.checkout, ["rev-parse", "HEAD"]);
    assert.notEqual(tip, b.commit);
    writeFileSync(join(b.checkout, "scratch.txt"), "x\n");
    const sent = (await h.view()).needsFix.find((x) => x.id === e.id)!;
    assert.equal(sent.newerRewritten, true);
    assert.equal(sent.newerCommits, undefined, "no count: nothing to count past a rewrite");
    assert.equal(sent.newerBlocked, "1 uncommitted file in its folder: commit or remove them first");
    git(b.checkout, ["clean", "-fq"]);
    await h.waitView((v) => v.needsFix.find((x) => x.id === e.id)?.newerBlocked === undefined, "clean: nothing blocks it");
    const again = await h.add({ branch: b.branch });
    assert.equal(again.commit, tip, "the amended commit, not the one sent back");
    const l = await h.waitEntry(again.id, settled);
    assert.equal(l.state, "landed", `${l.state}: ${l.reason}`);
    assert.ok(fx.isAncestor(tip, fx.head()));
  });

  test("S5h2: the same exit-2 failure in a check that isn't the project's test command stays Can't tell whose failure (only a test check is ever broken on the target)", async () => {
    const { fx, h } = await setup({ files: { "unit.usage": "1\n" } });
    const b = fx.branch("ok", { "b.txt": "b\n" });
    const s = await h.waitEntry((await h.add({ branch: b.branch })).id, settled);
    assert.equal(s.state, "unattributed", `${s.state}: ${s.reason}`);
    assert.equal((await h.view()).heads.targetBroken, undefined);
    assert.equal(h.flags.length, 0);
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
