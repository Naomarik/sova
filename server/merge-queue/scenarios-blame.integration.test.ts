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
  // Which runs decide the blame, and where, is run.integration's; here only what the queue does with it.
  test("S4: a test the branch broke: back with its chat, master unmoved and unpushed, the owner told once which test", async () => {
    const { fx, h } = await setup();
    const base = fx.head();
    const b = fx.branch("red", { "tests/b.txt": "fail\n" });
    const e = await h.add({ branch: b.branch });
    const done = await h.waitEntry(e.id, settled);
    assert.equal(done.state, "with-chat", `${done.state}: ${done.reason}`);
    assert.match(done.reason ?? "", /tests\/b\.txt/);
    assert.equal(fx.head(), base, "master unmoved");
    assert.equal(fx.originHead(), base, "nothing pushed");
    const told = h.notices.filter((n) => n.branch === b.branch && n.kind === "needs-fix");
    assert.equal(told.length, 1, "told once");
    assert.match(told[0]!.text, /tests\/b\.txt/, "the owner chat is told which test");
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
    assert.equal(s.decision?.kind, "unattributed", "one decision for the user");
    assert.deepEqual(s.decision?.actions, ["land-anyway", "try-again"]);
    await assert.rejects(h.answer(e.id, "send-back" as never), /answer is/, "no Send Back");
    const again = await h.answer(e.id, "try-again");
    assert.equal(again.tries?.used ?? 0, 0, "Try Again uses no try");
    assert.equal(h.notices.filter((n) => n.branch === b.branch && n.kind !== "approved").length, 0, "nothing went to the chat");
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
    assert.equal(s.state, "landed", `${s.state}: ${s.reason} ${JSON.stringify(run.steps.map((x) => [x.id, x.result, x.detail]))}`);
    assert.notEqual(v.state, "paused", "the queue doesn't pause");
    assert.ok(!v.needsYou.some((x) => x.id === e.id), "no entry waits on the user");
    const why = "Unit tests is broken on master: no test ran (unit: --groups needs a value)";
    // The skipped steps, their flag and log are run.integration's (the release run's control case).
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
    assert.equal(s.state, "with-chat", `${s.state}: ${s.reason}`);
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
    assert.equal(s.state, "with-chat", `b.txt fails only with the branch, a.txt on master too: ${s.state}: ${s.reason} ${JSON.stringify(s.notes)}`);
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
    assert.notEqual(s.state, "with-chat", `a clean branch blamed for master's red test: ${s.reason}`);
    if (s.state === "landed") assert.ok(s.notes.some((n) => n.kind === "master-red"), `noted as master's: ${JSON.stringify(s.notes)} ${JSON.stringify(h.run(s.run!).steps.map((x) => [x.id, x.result, x.detail]))}`);
    else assert.equal(fx.head(), before);
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

  test("S7: setup broken only by the branch: back with its chat; the queue doesn't pause", async () => {
    const { fx, h } = await setup();
    const base = fx.head();
    const b = fx.branch("setup", { "setup.conf": "broken\n" });
    const e = await h.add({ branch: b.branch });
    const s = await h.waitEntry(e.id, (x) => settled(x) || x.runs.length > 2);
    assert.equal(s.state, "with-chat", `${s.state}: ${s.reason}`);
    assert.match(s.reason ?? "", /setup/i);
    assert.equal(fx.head(), base);
    assert.equal((await h.view()).state, "idle", "no pause for a branch's own breakage");
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
    assert.equal(fx.calls().filter((c) => c.script === "unit" || c.script === "build").length, 0);
  });

  test("S15a: one test command (no service): its runner is the check, in the copy", async () => {
    const { fx, h } = await setup({ checks: "test-command" });
    assert.equal((await h.view()).checks, "test-command");
    const b = fx.branch("b", { "b.txt": "b\n" });
    const l = await h.waitEntry((await h.add({ branch: b.branch })).id, settled);
    assert.equal(l.state, "landed", `${l.state}: ${l.reason}`);
    assert.ok(fx.calls().some((c) => c.script === "runner" && c.result === "pass" && c.cwd === mergeCopyOf(fx)));
  });
});
