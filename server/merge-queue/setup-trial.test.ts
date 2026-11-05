import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { MergeCheckDecl } from "../../shared/project-contract";
import type { MergeTrial } from "../../shared/merge-queue";
import type { Caller } from "../project-services/engine";
import { merger } from "./routes";
import { changedSections, releaseFolders, trialReleaseChecks, untriedWhy } from "./setup-branch";
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

  test("Land waits for a passing trial of exactly that commit", () => {
    const t = (commit: string, verdict: MergeTrial["verdict"]): MergeTrial => ({ run: "mr_1", commit, verdict, by: { kind: "operator" }, startedAt: "" });
    const c = "a".repeat(40);
    assert.match(untriedWhy([], c)!, /^This setup branch has no passing trial at aaaaaaa: run a trial of it first\.$/);
    assert.match(untriedWhy([t(c, "running")], c)!, /still running/);
    assert.match(untriedWhy([t(c, "failed")], c)!, /did not pass/);
    assert.equal(untriedWhy([t(c, "passed")], c), null);
    assert.ok(untriedWhy([t("b".repeat(40), "passed")], c), "another commit's pass doesn't count");
  });
});

describe("merge.try and the land gate", () => {
  const setup = () => {
    const k = makeKit();
    const call = merger({
      queues: k.queues,
      served: { isListed: () => true, served: async () => true, bareView: async () => { throw new Error("served"); } },
      rootOf: async (p) => (p.startsWith(k.repo.scratch) ? k.repo.root : null),
    });
    const chat: Caller = { kind: "session", id: "setup-chat", root: k.repo.root, own: [] };
    return { k, call, chat };
  };

  test("a setup branch is refused until a trial of its head passes; a new commit needs a new trial", async () => {
    const { k, call, chat } = setup();
    try {
      const b = k.repo.branch("setup/checks", { ".sova/project.json": DEF_TEXT("true") });
      const refused = await call("merge.add", { project: k.repo.root, branch: "setup/checks" }, op);
      assert.equal(refused.ok, false);
      assert.equal(refused.error?.message, `This setup branch has no passing trial at ${b.head.slice(0, 7)}: run a trial of it first.`);
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
      await call("merge.cancel", { entry: landed.merge!.entry!.id }, op);
      // A new commit on the branch: its trial doesn't carry over.
      const next = k.repo.commitOn(b.path, { ".sova/project.json": DEF_TEXT("true && true") });
      const again = await call("merge.add", { project: k.repo.root, branch: "setup/checks" }, op);
      assert.equal(again.ok, false);
      assert.match(again.error!.message, new RegExp(`no passing trial at ${next.slice(0, 7)}`));
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

  test("a second trial while one runs is busy; an overseer may not run one", async () => {
    const { k, call, chat } = setup();
    try {
      k.repo.branch("setup/a", { ".sova/project.json": DEF_TEXT("true") });
      let release: () => void = () => {};
      const held = new Promise<void>((r) => (release = r));
      k.run.set(async () => (await held, {}));
      const first = await call("merge.try", { project: k.repo.root, branch: "setup/a" }, chat);
      assert.equal(first.ok, true, first.error?.message);
      const second = await call("merge.try", { project: k.repo.root, branch: "setup/a" }, op);
      assert.equal(second.error?.code, "busy");
      const po = await call("merge.try", { project: k.repo.root, branch: "setup/a" }, { kind: "project-overseer", id: "po", root: k.repo.root, act: async () => {} } as unknown as Caller);
      assert.equal(po.error?.code, "forbidden");
      release();
      const q = await k.q();
      await until(() => q.trials()[0]?.verdict !== "running", "the trial's end");
    } finally {
      await k.done();
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
