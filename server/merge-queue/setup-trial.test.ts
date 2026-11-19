import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { MergeCheckDecl } from "../../shared/project-contract";
import type { MergeTrial } from "../../shared/merge-queue";
import type { Caller } from "../project-services/engine";
import { merger } from "./routes";
import { changedFilesOf, changedSections, dryRunMergeChecks, dryRunReasons, dryRunWhyLine, releaseFolders, trialEndedText, trialReleaseChecks, untriedWhy } from "./setup-branch";
import type { ProjectDef } from "../../shared/project-contract";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeRepo, untilAborted } from "./testing/queue-kit";
import { realGit } from "./guard";
import { makeKit, until } from "./testing/queue-kit";

const op: Caller = { kind: "operator" };
const check = (id: string, run = ["true"]): MergeCheckDecl => ({ id, label: id, run, timeout: 60, rerun: false, requires: [] }) as MergeCheckDecl;
const DEF_TEXT = (cmd: string) => `${JSON.stringify({ version: 1, merge: { checks: [{ id: "unit", label: "Unit", run: ["sh", "-c", cmd] }] } }, null, 2)}\n`;

describe("a setup branch (pure rules)", () => {
  test("only the pipeline sections count, compared by value", () => {
    assert.deepEqual(changedSections(null, { version: 1 }), []);
    assert.deepEqual(changedSections({ merge: { checks: "none" } }, { merge: { checks: "none" }, open: { endpoint: "x" } }), []);
    assert.deepEqual(changedSections({ merge: { target: "main", checks: "none" } }, { merge: { checks: "none", target: "main" } }), [], "key order is not a change");
    assert.deepEqual(changedSections({ release: { playbook: "a" } }, { release: { playbook: "b" }, deploy: { targets: [] } }), ["release", "deploy"]);
  });

  test("services count only when a merge check requires the one changed, on either side", () => {
    const svc = (name: string, port = 1) => ({ name, start: ["x"], ports: { http: port } });
    const merge = (requires: string[]) => ({ checks: [{ id: "unit", run: ["true"], requires }] });
    // A required service edited, added or removed: gated.
    assert.deepEqual(changedSections({ services: [svc("db")], merge: merge(["db"]) }, { services: [svc("db", 2)], merge: merge(["db"]) }), ["services"]);
    assert.deepEqual(changedSections({ services: [], merge: merge([]) }, { services: [svc("db")], merge: merge([]) }), [], "an unrequired service added: conformance's");
    assert.deepEqual(changedSections({ services: [svc("db")], merge: merge(["db"]) }, { services: [], merge: merge(["db"]) }), ["services"], "a required one removed");
    // The target's checks require it, the branch's don't any more: still gated (merge changed too).
    assert.deepEqual(changedSections({ services: [svc("db")], merge: merge(["db"]) }, { services: [svc("db", 3)], merge: merge([]) }), ["services", "merge"]);
    // The map form, keyed by name.
    assert.deepEqual(changedSections({ services: { db: { start: ["a"] } }, merge: merge(["db"]) }, { services: { db: { start: ["b"] } }, merge: merge(["db"]) }), ["services"]);
    assert.deepEqual(changedSections({ services: { db: { start: ["a"] } }, merge: merge(["db"]) }, { services: { db: { start: ["a"] }, web: { start: ["w"] } }, merge: merge(["db"]) }), []);
    // Only an unrequired service edited, a required one left alone: not gated.
    assert.deepEqual(changedSections({ services: [svc("db"), svc("web")], merge: merge(["db"]) }, { services: [svc("db"), svc("web", 9)], merge: merge(["db"]) }), []);
  });

  test("the release playbook folders: either side's, plus the default", () => {
    assert.deepEqual(releaseFolders({ release: { playbook: "./ops/release/" } }, null), ["ops/release", ".sova/playbooks/release"]);
  });

  test("a trial runs the release checks that are new, changed or named; the rest are not run", () => {
    const target = [check("e2e"), check("bench")];
    const branch = [check("e2e"), check("bench", ["false"]), check("smoke")];
    const r = trialReleaseChecks(branch, target, []);
    assert.deepEqual(r.run.map((c) => c.id), ["bench", "smoke"]);
    assert.deepEqual(r.notRun.map((c) => c.id), ["e2e"]);
    assert.deepEqual(trialReleaseChecks(branch, target, ["e2e"]).notRun, []);
  });

  test("Merge Branch waits for a passing dry run of exactly that commit, in dry-run words, never \"fix it\"", () => {
    const t = (commit: string, verdict: MergeTrial["verdict"], more: Partial<MergeTrial> = {}): MergeTrial => ({ run: "mr_1", commit, verdict, by: { kind: "operator" }, startedAt: "", ...more });
    const c = "a".repeat(40);
    assert.equal(untriedWhy([], c), "This setup branch has no passing dry run at aaaaaaa: run one first.");
    assert.match(untriedWhy([t(c, "running")], c)!, /dry run at aaaaaaa is still running/);
    assert.match(untriedWhy([t(c, "void", { stopped: { by: "operator", at: "" } })], c)!, /stopped by you: nothing failed\. Run it again\.$/);
    assert.match(untriedWhy([t(c, "machine", { why: "no disk" })], c)!, /couldn't run \(no disk\): that's the machine, not this branch\. Run it again\.$/);
    assert.match(untriedWhy([t(c, "failed", { failure: { kind: "dry-run", run: "mr_1", commit: c, whose: "master", line: "Unit fails at aaaaaaa: it fails. Fails on master too: not this branch's.", checks: [] } })], c)!, /Fails on master too: not this branch's/);
    for (const v of ["running", "void", "machine", "failed"] as const) assert.doesNotMatch(untriedWhy([t(c, v)], c)!, /trial|fix it/i, v);
    assert.equal(untriedWhy([t(c, "passed")], c), null);
    assert.ok(untriedWhy([t("b".repeat(40), "passed")], c), "another commit's pass doesn't count");
  });

  test("a dry run runs only the merge checks the branch adds or changes, or whose required service it changes", () => {
    const def = (checks: MergeCheckDecl[]) => ({ version: 1, merge: { checks } }) as unknown as ProjectDef;
    const target = def([check("unit"), check("lint"), { ...check("e2e"), requires: ["db"] }]);
    const branch = def([check("unit"), { ...check("lint"), label: "Lint renamed" }, { ...check("lint2"), run: ["x"] }, { ...check("e2e"), requires: ["db"] }, { ...check("unit2") }]);
    const r = dryRunMergeChecks(branch, target, []);
    assert.deepEqual(r.run.map((c) => c.id), ["lint2", "unit2"], "a label alone isn't a change to run");
    assert.deepEqual(r.notRun.map((c) => c.id), ["unit", "lint", "e2e"]);
    assert.deepEqual(dryRunMergeChecks(branch, target, ["db"]).run.map((c) => c.id), ["lint2", "e2e", "unit2"], "a check whose required service changed runs");
    const changed = def([{ ...check("unit"), timeout: 9 }]);
    assert.deepEqual(dryRunMergeChecks(changed, def([check("unit")]), []).run.map((c) => c.id), ["unit"], "a time limit is part of the check");
  });

  test("why a branch needs a dry run, said from its change, the first named then how many more", () => {
    const def = (checks: MergeCheckDecl[], more: Record<string, unknown> = {}) => ({ version: 1, merge: { checks }, ...more }) as unknown as ProjectDef;
    const target = def([check("unit"), check("old")]);
    const branch = def([{ ...check("unit"), run: ["y"], label: "Unit" }, { ...check("play"), label: "Playbook tests" }]);
    const reasons = dryRunReasons(branch, target, { sections: ["merge"], services: [], playbook: false });
    assert.deepEqual(reasons, ["adds the merge check Playbook tests", "changes the merge check Unit", "removes the merge check old"].sort((a, b) => reasons.indexOf(a) - reasons.indexOf(b)));
    assert.ok(reasons.includes("adds the merge check Playbook tests") && reasons.includes("changes the merge check Unit") && reasons.includes("removes the merge check old"));
    assert.equal(dryRunWhyLine(reasons), `${reasons[0]} and 2 more`);
    assert.deepEqual(dryRunReasons(target, target, { sections: [], services: ["db"], playbook: true }), ["changes the service db a merge check needs", "changes the release playbook"]);
    assert.deepEqual(dryRunReasons(def([], { merge: { checks: [], push: false } }), def([]), { sections: ["merge"], services: [], playbook: false }), ["changes the merge settings"]);
  });

  test("the chat's note says dry run, and never asks it to fix what isn't its own", () => {
    const run = { id: "mr_1", entry: "trial", project: "p", branch: "b", base: "c", commit: "c", steps: [], checks: [], verdict: "failed", startedAt: "" } as never;
    const t = (more: Partial<MergeTrial>): MergeTrial => ({ run: "mr_1", commit: "c".repeat(40), branch: "setup/x", verdict: "failed", by: { kind: "chat", session: "s" }, startedAt: "", ...more });
    const shared = trialEndedText(t({ failure: { kind: "dry-run", run: "mr_1", commit: "c".repeat(40), whose: "master", line: "x", checks: [{ id: "u", label: "Unit", step: "s", whose: "master" }] } }), run, { target: "master" });
    assert.match(shared, /^The dry run of setup\/x at ccccccc failed: Unit · fails on master too: not this branch's\./);
    assert.doesNotMatch(shared, /\btrial\b|Fix what failed/);
    const stopped = trialEndedText(t({ verdict: "void", stopped: { by: "operator", at: "" } }), run, { target: "master" });
    assert.match(stopped, /was stopped by you: nothing failed\. It needs a new dry run before it lands\./);
    const superseded = trialEndedText(t({ verdict: "void", stopped: { by: "superseded", at: "" } }), run, { target: "master", land: { commit: "d".repeat(40) } });
    assert.match(superseded, /Land runs its own dry run of setup\/x at ddddddd.*no need to start another/);
    assert.doesNotMatch(superseded, /run it again/i);
  });
});

describe("merge.try and the land gate", () => {
  const setup = () => {
    const k = makeKit();
    const call = merger({
      queues: k.queues,
      served: { isListed: () => true, served: async () => true, bareView: async () => { throw new Error("served"); } },
      rootOf: async (p) => (p.startsWith(k.repo.scratch) ? k.repo.root : null),
      isThreadChat: (root, sid) => root === k.repo.root && sid === "the-thread",
      isReviewerChat: (sid) => sid === "a-reviewer",
    });
    const chat: Caller = { kind: "session", id: "setup-chat", root: k.repo.root, own: [] };
    return { k, call, chat };
  };

  test("Land on a setup branch runs its dry run first, then lands by itself with no second Land", async () => {
    const { k, call } = setup();
    try {
      const b = k.repo.branch("setup/land", { ".sova/project.json": DEF_TEXT("true") });
      const landed = await call("merge.add", { project: k.repo.root, branch: "setup/land" }, op);
      assert.equal(landed.ok, true, landed.error?.message);
      assert.equal(landed.merge?.entry?.standing?.phase, "dry-run", "Approved · dry run first");
      const q = await k.q();
      const e = await until(async () => ((await k.entry(landed.merge!.entry!.id)).state === "landed" ? true : null), "the landing");
      assert.ok(e);
      const t = q.trials().find((x) => x.commit === b.head);
      assert.equal(t?.verdict, "passed");
      assert.deepEqual(t?.by, { kind: "land", entry: landed.merge!.entry!.id });
      assert.deepEqual(k.run.inputs.map((i) => !!i.tryOnly), [true, false], "the dry run, then the landing run");
    } finally {
      await k.done();
    }
  });

  test("a Land's dry run that fails on the branch's change goes back to its chat, its Land standing", async () => {
    const { k, call } = setup();
    try {
      const b = k.repo.branch("setup/red", { ".sova/project.json": DEF_TEXT("false") });
      k.run.set(async (input) => (input.tryOnly ? { verdict: "failed", why: "Unit fails", trialFailure: { kind: "dry-run", commit: input.commit, whose: "branch", line: "Unit fails at x. This branch's change breaks it.", checks: [{ id: "unit", label: "Unit", step: "rerun-tip:unit", whose: "branch" }] } } : {}));
      const landed = await call("merge.add", { project: k.repo.root, branch: "setup/red" }, op);
      const id = landed.merge!.entry!.id;
      const e = await until(async () => ((await k.entry(id)).state === "with-chat" ? k.entry(id) : null), "back with the chat");
      assert.equal(e.approval.standing, true, "the Land stands");
      assert.match(e.reason ?? "", /This branch's change breaks it/);
      assert.equal(k.run.inputs.filter((i) => !i.tryOnly).length, 0, "nothing landed");
      const view = await (await k.q()).view();
      const row = view.needsFix.find((x) => x.id === id);
      assert.equal(row?.dryRun?.state, "failed");
      assert.equal(row?.failure?.whose, "branch");
      assert.equal(row?.dryRun?.commit, b.head);
    } finally {
      await k.done();
    }
  });

  test("a Land's dry run failing on the target too waits for the user; Land Anyway lands it", async () => {
    const { k, call } = setup();
    try {
      k.repo.branch("setup/shared", { ".sova/project.json": DEF_TEXT("false") });
      k.run.set(async (input) => (input.tryOnly ? { verdict: "failed", why: "x", trialFailure: { kind: "dry-run", commit: input.commit, whose: "master", line: "Unit fails at x: it fails. Fails on master too: not this branch's.", checks: [{ id: "unit", label: "Unit", step: "rerun-tip:unit", whose: "master" }] } } : {}));
      const landed = await call("merge.add", { project: k.repo.root, branch: "setup/shared" }, op);
      const id = landed.merge!.entry!.id;
      const e = await until(async () => ((await k.entry(id)).state === "unattributed" ? k.entry(id) : null), "the user's decision");
      assert.ok(e.dryRunHold);
      const any = await call("merge.answer", { entry: id, answer: "land-anyway" }, op);
      assert.equal(any.ok, true, any.error?.message);
      await until(async () => ((await k.entry(id)).state === "landed" ? true : null), "the landing");
      assert.equal(k.run.inputs.filter((i) => i.tryOnly).length, 1, "no second dry run");
    } finally {
      await k.done();
    }
  });

  test("a chat's dry run passes, then Land lands it at once; a new commit needs a new dry run", async () => {
    const { k, call, chat } = setup();
    try {
      const b = k.repo.branch("setup/checks", { ".sova/project.json": DEF_TEXT("true") });
      const tried = await call("merge.try", { project: k.repo.root, branch: "setup/checks" }, chat);
      assert.equal(tried.ok, true, tried.error?.message);
      assert.equal(tried.merge?.trial?.commit, b.head);
      assert.deepEqual(tried.merge?.trial?.by, { kind: "chat", session: "setup-chat" });
      const q = await k.q();
      await until(() => q.trials().find((t) => t.commit === b.head && t.verdict !== "running"), "the trial's end");
      assert.equal(q.trials()[0]!.verdict, "passed");
      assert.equal(k.run.inputs.at(-1)?.tryOnly, true, "a trial merges nothing");
      assert.equal(k.run.inputs.at(-1)?.base, b.head, "on the branch's head, not the target");
      const landed = await call("merge.add", { project: k.repo.root, branch: "setup/checks" }, op);
      assert.equal(landed.ok, true, landed.error?.message);
      assert.equal(landed.merge?.entry?.standing, undefined, "its head passed: no dry run first");
      await call("merge.cancel", { entry: landed.merge!.entry!.id }, op);
      // A new commit on the branch: its dry run doesn't carry over.
      const next = k.repo.commitOn(b.path, { ".sova/project.json": DEF_TEXT("true && true") });
      const dr = await q.dryRunOf("setup/checks", next);
      assert.equal(dr?.state, "needed");
      assert.equal(dr?.older?.commit, b.head, "the older commit's pass is only history");
    } finally {
      await k.done();
    }
  });

  test("the merge thread and a run's reviewer run no trial; another chat of the project does", async () => {
    const { k, call } = setup();
    try {
      k.repo.branch("setup/t", { ".sova/project.json": DEF_TEXT("true") });
      for (const id of ["the-thread", "a-reviewer"]) {
        const r = await call("merge.try", { project: k.repo.root, branch: "setup/t" }, { kind: "session", id, root: k.repo.root, own: [] });
        assert.equal(r.error?.code, "forbidden", id);
      }
      assert.equal(k.run.inputs.length, 0, "a refused caller started nothing");
      const ok = await call("merge.try", { project: k.repo.root, branch: "setup/t" }, { kind: "session", id: "other", root: k.repo.root, own: [] });
      assert.equal(ok.ok, true, ok.error?.message);
      const q = await k.q();
      await until(() => q.trials()[0]?.verdict !== "running", "the trial's end");
    } finally {
      await k.done();
    }
  });

  test("the proposal's files: every file the branch changes, sorted, setup marked by the gate's rule", async () => {
    const { k } = setup();
    try {
      const b = k.repo.branch("setup/files", { ".sova/project.json": DEF_TEXT("true"), ".sova/playbooks/release/release.json": "{}\n", "scripts/check.sh": "true\n", ".sova/spec/drafts/x.md": "x\n" });
      const files = await changedFilesOf(realGit, k.repo.root, k.repo.target, b.head);
      assert.deepEqual(files, [
        { path: ".sova/playbooks/release/release.json", status: "A", setup: true },
        { path: ".sova/project.json", status: "A", setup: true },
        { path: ".sova/spec/drafts/x.md", status: "A", setup: false },
        { path: "scripts/check.sh", status: "A", setup: false },
      ]);
      // A project.json edit that leaves the counted sections alone isn't setup.
      const p = k.repo.branch("feat/open", { "a.txt": "changed\n" });
      assert.deepEqual(await changedFilesOf(realGit, k.repo.root, k.repo.target, p.head), [{ path: "a.txt", status: "M", setup: false }]);
    } finally {
      await k.done();
    }
  });

  test("a branch that leaves the setup alone needs no trial", async () => {
    const { k, call } = setup();
    try {
      k.repo.branch("feat/plain", { "b.txt": "b\n" });
      const r = await call("merge.add", { project: k.repo.root, branch: "feat/plain" }, op);
      assert.equal(r.ok, true, r.error?.message);
    } finally {
      await k.done();
    }
  });

  test("a second press answers with the running dry run; another branch's waits its turn; an overseer may not run one", async () => {
    const { k, call, chat } = setup();
    try {
      k.repo.branch("setup/a", { ".sova/project.json": DEF_TEXT("true") });
      const bb = k.repo.branch("setup/b", { ".sova/project.json": DEF_TEXT("true && true") });
      let release: () => void = () => {};
      const held = new Promise<void>((r) => (release = r));
      k.run.set(async () => (await held, {}));
      const first = await call("merge.try", { project: k.repo.root, branch: "setup/a" }, chat);
      assert.equal(first.ok, true, first.error?.message);
      const second = await call("merge.try", { project: k.repo.root, branch: "setup/a" }, op);
      assert.equal(second.ok, true, second.error?.message);
      assert.equal(second.merge?.trial?.run, first.merge?.trial?.run, "the same dry run, never a second");
      const other = await call("merge.try", { project: k.repo.root, branch: "setup/b" }, op);
      assert.equal(other.merge?.waiting?.branch, "setup/b");
      assert.equal(other.merge?.waiting?.after, "the dry run of setup/a");
      const qv = await (await k.q()).view();
      assert.equal(qv.trialNow?.trial.branch, "setup/a");
      assert.equal(qv.trialsWaiting?.[0]?.branch, "setup/b");
      assert.equal((await (await k.q()).dryRunOf("setup/b", bb.head))?.state, "waiting");
      const po = await call("merge.try", { project: k.repo.root, branch: "setup/a" }, { kind: "project-overseer", id: "po", root: k.repo.root, act: async () => {} } as unknown as Caller);
      assert.equal(po.error?.code, "forbidden");
      release();
      const q = await k.q();
      await until(() => q.trials().find((t) => t.branch === "setup/b" && t.verdict === "passed"), "the waiting one's turn, then its end");
      assert.equal(q.trials().find((t) => t.branch === "setup/a")?.verdict, "passed");
    } finally {
      await k.done();
    }
  });

  test("Stop Dry Run frees the copy at once and blames nothing; a waiting one leaves the wait", async () => {
    const { k, call, chat } = setup();
    try {
      k.repo.branch("setup/s", { ".sova/project.json": DEF_TEXT("true") });
      k.repo.branch("setup/w", { ".sova/project.json": DEF_TEXT("true && true") });
      k.run.set(untilAborted);
      const first = await call("merge.try", { project: k.repo.root, branch: "setup/s" }, chat);
      const w = await call("merge.try", { project: k.repo.root, branch: "setup/w" }, op);
      const q = await k.q();
      const unw = await q.stopTrial({ waiting: w.merge!.waiting!.id, by: { kind: "operator" } });
      assert.equal(unw.waiting?.branch, "setup/w");
      const other = await call("merge.stop-try", { run: first.merge!.trial!.run }, { kind: "session", id: "someone-else", root: k.repo.root, own: [] });
      assert.equal(other.error?.code, "forbidden", "a chat stops only its own");
      const own = await call("merge.stop-try", { run: first.merge!.trial!.run }, chat);
      assert.equal(own.ok, true, own.error?.message);
      const t = await until(() => q.trials().find((x) => x.branch === "setup/s" && x.verdict !== "running"), "the stop");
      assert.equal(t.verdict, "void");
      assert.equal(t.stopped?.by, "chat");
      assert.equal(q.file.trialsWaiting?.length ?? 0, 0);
    } finally {
      await k.done();
    }
  });

  test("a dry run the records still call running when Sova starts reads stopped by a restart, and so does its run", async () => {
    const repo = makeRepo();
    const k = makeKit({ repo });
    let file = "";
    let snapshot = "";
    let runId = "";
    try {
      k.repo.branch("setup/r", { ".sova/project.json": DEF_TEXT("true") });
      k.run.set(untilAborted);
      const q = await k.q();
      const r = await q.trial({ branch: "setup/r", by: { kind: "operator" } });
      runId = r.trial!.run;
      file = join(q.store.dir, "queue.json");
      snapshot = readFileSync(file, "utf8");
      const runFile = join(q.store.runDir(runId), "run.json");
      const runSnap = readFileSync(runFile, "utf8");
      await k.queues.stop();
      // As a crash leaves them: still running.
      writeFileSync(file, snapshot);
      writeFileSync(runFile, runSnap);
    } catch (err) {
      await k.done();
      repo.done();
      throw err;
    }
    const k2 = makeKit({ repo });
    try {
      const q2 = await k2.q();
      const t = q2.trials().find((x) => x.run === runId)!;
      assert.equal(t.verdict, "void");
      assert.equal(t.stopped?.by, "restart");
      assert.equal(q2.store.readRun(runId)?.verdict, "void");
      assert.equal((await q2.view()).trialNow, undefined, "never running from a saved record");
    } finally {
      await k2.done();
      repo.done();
    }
  });

  test("merge.setup stays the operator's: a chat's call is refused with and without dryRun, the target unmoved", async () => {
    const { k, call, chat } = setup();
    try {
      const before = k.repo.head();
      for (const dryRun of [false, true]) {
        const r = await call("merge.setup", { project: k.repo.root, command: "true", dryRun }, chat);
        assert.equal(r.ok, false, `dryRun ${dryRun}`);
        assert.equal(r.error?.code, "forbidden");
      }
      assert.equal(k.repo.head(), before);
      assert.equal(k.run.inputs.length, 0, "nothing ran in the merge copy");
    } finally {
      await k.done();
    }
  });
});
