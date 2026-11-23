// Run: pnpm test:int server/merge-queue/scenarios-rules.integration.test.ts
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { settled, setup } from "./testing/scenario-kit";
import { until } from "./testing/repo";

/**
 * The merge queue's folder rules, late picks and time limits (§app.merge-queue/rules, §app.merge-queue/checks,
 * §app.merge-queue/time-limit), each on a real git repository with the real queue on the real run
 * (testing/harness.ts); only the chats are stood in for. Waits are on conditions.
 */

const RULES = [{ paths: ["src/**"], check: "unit", select: ["tests/a.txt"], why: "the list changed: its own test" }];
const projectWith = (rules: unknown[]) => (text: string) => {
  const d = JSON.parse(text) as { merge: { rules?: unknown[] } };
  d.merge.rules = rules;
  return `${JSON.stringify(d, null, 2)}\n`;
};

describe("folder rules", () => {
  test("Sova applies the rules itself: the check runs as Triggered with the rule's reason and the matched paths", async () => {
    const { fx, h } = await setup({ merge: { rules: RULES } });
    const b = fx.branch("b", { "src/list.txt": "alpha\nbravo\ncharlie\ndelta\n" });
    const e = await h.waitEntry((await h.add({ branch: b.branch })).id, settled);
    assert.equal(e.state, "landed", `${e.state}: ${e.reason}`);
    const run = h.run(e.run!);
    const trig = run.checks.find((c) => c.source === "trigger");
    assert.deepEqual([trig?.id, trig?.select, trig?.why], ["unit+1", ["tests/a.txt"], "the list changed: its own test (src/list.txt)"]);
    assert.ok(run.steps.some((s) => s.id === "check:unit+1" && s.source === "trigger" && s.result === "passed"), JSON.stringify(run.steps.map((s) => s.id)));
    assert.deepEqual(run.rules, { from: "branch", count: 1 });
    // A branch whose change no rule matches sets nothing off.
    const c = fx.branch("c", { "README.md": "# demo 2\n" });
    const e2 = await h.waitEntry((await h.add({ branch: c.branch })).id, settled);
    assert.equal(h.run(e2.run!).checks.some((x) => x.source === "trigger"), false);
  });

  test("a branch's own rule edit takes effect on its own landing, and the run says what it changed", async () => {
    const { fx, h } = await setup();
    const own = [{ paths: ["README.md"], check: "unit", select: ["tests/b.txt"], why: "docs: run b" }];
    const def = projectWith(own)(JSON.stringify(fx.definition()));
    const b = fx.branch("b", { ".sova/project.json": def, "README.md": "# changed\n" });
    const e = await h.waitEntry((await h.add({ branch: b.branch })).id, settled);
    assert.equal(e.state, "landed", `${e.state}: ${e.reason}`);
    const run = h.run(e.run!);
    assert.deepEqual(run.rules?.changed, ["added: README.md → unit (tests/b.txt): docs: run b"]);
    assert.ok(run.checks.some((c) => c.source === "trigger" && c.why === "docs: run b (README.md)"), JSON.stringify(run.checks));
  });

  test("a branch whose own definition is refused goes back to its chat with the refusal; nothing else runs", async () => {
    const { fx, h } = await setup();
    const def = projectWith([{ paths: ["src/**"], check: "no-such-check", why: "x" }])(JSON.stringify(fx.definition()));
    const b = fx.branch("b", { ".sova/project.json": def });
    const e = await h.waitEntry((await h.add({ branch: b.branch })).id, settled);
    // Its dry run (a branch changing the project file has one) reads the definition first and refuses it: back to the
    // chat with the refusal, as the branch's to fix, and no check ran.
    assert.equal(e.state, "with-chat", `${e.state}: ${e.reason}`);
    assert.match(e.reason ?? "", /^your branch's \.sova\/project\.json at \w+ is invalid: \$\.merge\.rules\[0\]\.check: names no merge check "no-such-check": fix it in the branch$/);
    assert.equal(fx.callsSince(0).some((c) => c.script === "unit" || c.script === "build"), false);
  });
});

describe("late picks (q9)", () => {
  test("a pick made while the run checks still runs in that run, marked with when it arrived, before the push", async () => {
    const { fx, h } = await setup();
    const b = fx.branch("b", { "tests/h.txt": "gate late\n" });
    const e = await h.add({ branch: b.branch });
    await until("held", () => fx.atGate("late"));
    await h.extend(e.id, ["unit"], "the thread: run a alone too", ["tests/a.txt"]);
    fx.openGate("late");
    const done = await h.waitEntry(e.id, settled);
    assert.equal(done.state, "landed", `${done.state}: ${done.reason}`);
    const run = h.run(done.run!);
    const late = run.checks.find((c) => c.id === "unit+1");
    assert.ok(late?.addedAt && late.source === "picked" && late.why === "the thread: run a alone too", JSON.stringify(run.checks));
    assert.ok(run.steps.some((s) => s.id === "check:unit+1" && s.result === "passed"));
    // Once the run's checks are done the landing has begun: a pick for the landed entry is refused.
    await assert.rejects(h.extend(e.id, ["unit"], "too late", ["tests/b.txt"]), /landed|nothing to extend|landing/);
  });
});

describe("time limits (q2)", () => {
  test("past the limit with the branch, finishing on the target alone: the branch's, sent back like a failure", async () => {
    const { fx, h } = await setup({ unitTimeout: 3 });
    const b = fx.branch("b", { "tests/x.txt": "hang\n" });
    const e = await h.waitEntry((await h.add({ branch: b.branch })).id, settled);
    assert.ok(e.state === "with-chat" || e.state === "needs-fix", `${e.state}: ${e.reason}`);
    const run = h.run(e.run!);
    assert.equal(run.verdict, "failed");
    assert.equal(run.blame, "branch");
    assert.match(run.why ?? "", /Unit tests ran past its 3 s time limit with your branch and finishes in \d+ s on master alone/);
    assert.ok(run.steps.some((s) => s.id === "rerun-master:unit" && /the time-out is the branch's/.test(s.detail ?? "")), JSON.stringify(run.steps.map((s) => [s.id, s.detail])));
  });

  test("past the limit on the target alone too: the queue pauses at once and asks; never voided, never run again by itself", async () => {
    const { fx, h } = await setup({ unitTimeout: 3, files: { "tests/x.txt": "hang\n" } });
    const b = fx.branch("b", { "README.md": "# b\n" });
    const e = await h.add({ branch: b.branch });
    const v = await h.waitView((x) => x.paused?.kind === "time-limit", "paused on the time limit");
    assert.match(v.paused!.why, /Unit tests \(3 s\) runs past its time limit on master alone too, so not feat\/b's/);
    const now = await h.entry(e.id);
    assert.equal(now.state, "queued", "it keeps its place in line");
    assert.equal(now.runs.length, 1, "one run, no void-and-requeue");
    assert.equal(h.run(now.runs[0]!).verdict, "machine");
  });
});
