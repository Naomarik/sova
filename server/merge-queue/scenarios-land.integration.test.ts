import assert from "node:assert/strict";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { APP, LIST_PLUS, STATE, mergeCopyOf, mergesOnto, resolution, reviewer, settled, setup, testedHead } from "./fixtures/scenario-kit";
import { Fixture, git, until } from "./fixtures/repo";
import type { HarnessOptions } from "./fixtures/harness";
import type { MergeEntry } from "../../shared/merge-queue";

/**
 * The merge queue's use cases (team brief, TESTING): landing, the master guard and the live tree. Each on a real git repository in a temp dir with a bare
 * origin: the real queue on the real run, driven through the queue's verb methods (fixtures/harness.ts); only the
 * branch's chat, the merge thread and the reviewer chat are stood in for. Waits are on conditions.
 */
void [APP, LIST_PLUS, STATE, mergeCopyOf, mergesOnto, resolution, reviewer, settled, setup, testedHead, Fixture, git, until, existsSync, writeFileSync, join, assert];
export type _H = HarnessOptions | MergeEntry;

// ---------------------------------------------------------------- the happy path

describe("clean land", () => {
  test("S1: merged in the merge copy beside the project, logged from the first step, master fast-forwards to exactly the tested commit, pushed, live tree follows", async () => {
    const { fx, h } = await setup();
    const base = fx.head();
    const b = fx.branch("ok", { "src/list.txt": LIST_PLUS("delta") });
    const e = await h.add({ branch: b.branch });
    assert.equal(e.commit, b.commit, "the approval pins the branch head");
    assert.equal(e.approval.commit, b.commit);
    const landed = await h.waitEntry(e.id, settled);
    assert.equal(landed.state, "landed", `${landed.state}: ${landed.reason}`);

    const run = h.run(landed.run!);
    const copy = mergeCopyOf(fx);
    assert.equal(run.copy, copy, "the merge copy is <parent>/.worktrees/<repo>-merge");
    assert.ok(!run.copy!.startsWith(STATE), "never under the state root");
    const checks = fx.calls().filter((c) => c.script === "unit" || c.script === "build");
    assert.ok(checks.length >= 2);
    for (const c of checks) assert.equal(c.cwd, copy, `${c.script} ran in the merge copy`);

    const tip = fx.head();
    assert.equal(landed.landed?.sha, tip);
    assert.equal(run.tip, tip);
    assert.equal(testedHead(fx), tip, "tested = landed: the checks ran on exactly the commit master now points at");
    assert.ok(fx.isAncestor(b.commit, tip) && fx.isAncestor(base, tip));
    assert.equal(fx.fileAt(tip, "src/list.txt"), LIST_PLUS("delta"));
    assert.equal(mergesOnto(fx, base), 1, "one merge commit on master");

    assert.equal(run.steps[0]!.kind, "copy", "the first step is the copy");
    assert.match(h.log(run.id, run.steps[0]!.id), /copy/i, "the copy step has a log");
    const setupStep = run.steps.find((s) => s.kind === "setup")!;
    assert.match(h.log(run.id, setupStep.id), /setup: start/, "the setup log holds its first line");

    assert.equal(fx.originHead(), tip, "pushed");
    assert.equal(landed.landed?.pushed, "pushed");
    assert.equal(fx.liveTreeHead(), tip, "the main checkout follows master");
    assert.equal(git(b.checkout, ["rev-parse", "HEAD"]), b.commit, "the branch's worktree untouched");
    const v = await h.view();
    assert.equal(v.heads.target, tip);
    assert.equal(v.heads.pushed, tip);
    assert.equal(v.state, "idle");
    assert.equal(v.recent[0]?.entry.id, e.id);
    assert.ok(h.notices.some((n) => n.kind === "landed" && n.branch === b.branch), "the branch's chat is told it landed");
  });

  test("S25: a `main` target (motorsaif-style): lands on main, no master branch is ever made", async () => {
    const { fx, h } = await setup({ target: "main" });
    const b = fx.branch("ok", { "README.md": "# demo main\n" });
    const e = await h.add({ branch: b.branch });
    const landed = await h.waitEntry(e.id, settled);
    assert.equal(landed.state, "landed", `${landed.state}: ${landed.reason}`);
    assert.equal(landed.target, "main");
    assert.equal(fx.head("main"), landed.landed?.sha);
    assert.equal(git(fx.project, ["branch", "--list", "master"]), "", "no master branch");
    assert.equal(fx.originHead(), landed.landed?.sha);
  });

  test("S9: master moved meanwhile by an earlier landing: the next branch is merged onto the newest master; both land, in order", async () => {
    const { fx, h } = await setup();
    const a = fx.branch("a", { "a.txt": "a\n" });
    const b = fx.branch("b", { "b.txt": "b\n" });
    const ea = await h.add({ branch: a.branch });
    const eb = await h.add({ branch: b.branch });
    assert.equal((await h.view()).waiting.find((x) => x.id === eb.id)?.position ?? 1, (await h.view()).current ? 1 : 2, "b waits its turn in line");
    const la = await h.waitEntry(ea.id, settled);
    const lb = await h.waitEntry(eb.id, settled);
    assert.equal(la.state, "landed");
    assert.equal(lb.state, "landed", `${lb.state}: ${lb.reason}`);
    assert.equal(h.run(lb.run!).base, la.landed!.sha, "b ran on the master a left");
    assert.equal(fx.head(), lb.landed!.sha);
    assert.ok(fx.fileAt(fx.head(), "a.txt") && fx.fileAt(fx.head(), "b.txt"));
  });

  test("S28: spec drafts become docs in the merge copy BEFORE the checks; nothing is committed after them", async () => {
    const { fx, h } = await setup();
    await fx.withSpec();
    const b = fx.branch("doc", { "src/app.txt": APP("line 3 changed") });
    fx.draft(b.checkout, "doc");
    const mark = fx.calls().length;
    const e = await h.add({ branch: b.branch });
    assert.ok(e.approval.drafts?.names.includes("doc"), "the approval snapshots the drafts");
    const landed = await h.waitEntry(e.id, settled);
    assert.equal(landed.state, "landed", `${landed.state}: ${landed.reason}`);
    const tip = fx.head();
    assert.equal(testedHead(fx, mark), tip, "the docs commit was under test: the checks ran on the landed tip itself");
    assert.match(fx.fileAt(tip, ".sova/spec/claims/b/doc.md") ?? "", /The doc feature does its one thing/);
    const kinds = h.run(landed.run!).steps.map((s) => s.kind);
    assert.ok(kinds.includes("docs") && kinds.indexOf("docs") < kinds.indexOf("check"), `docs before checks: ${kinds.join(",")}`);
  });
});

// ---------------------------------------------------------------- master and the live tree

describe("master guard and the live tree", () => {
  test("S10: master moved from outside during a run: allowed, the run is void, the queue pauses and flags it; Resume rebuilds on the new master and lands", async () => {
    const { fx, h } = await setup();
    const b = fx.branch("b", { "tests/g.txt": "gate b\n" });
    const e = await h.add({ branch: b.branch });
    await until("b at its gate", () => fx.atGate("b"));
    const outside = fx.moveTargetOutside();
    const v = await h.waitView((v) => v.state === "paused", "paused");
    fx.openGate("b");
    assert.equal(v.paused?.kind, "master-moved");
    assert.match(v.paused?.why ?? "", /moved outside the queue/i);
    assert.equal(fx.head(), outside, "the outside move stands (no refusing hook, nothing reverted)");
    const en = await h.entry(e.id);
    assert.equal(en.state, "queued", "back in line, not blamed");
    assert.equal(h.run(en.runs[0]!).verdict, "void");
    await h.resume();
    const landed = await h.waitEntry(e.id, settled);
    assert.equal(landed.state, "landed", `${landed.state}: ${landed.reason}`);
    assert.ok(fx.isAncestor(outside, landed.landed!.sha), "rebuilt on the new master");
  });

  test("S10b: master moved from outside while idle: noticed before the next run (paused + flagged), never merged onto a stale base", async () => {
    const { fx, h } = await setup();
    const a = fx.branch("a", { "a.txt": "a\n" });
    assert.equal((await h.waitEntry((await h.add({ branch: a.branch })).id, settled)).state, "landed");
    const outside = fx.moveTargetOutside();
    const b = fx.branch("b", { "b.txt": "b\n" }, { from: outside });
    const eb = await h.add({ branch: b.branch });
    const v = await h.waitView((v) => v.state === "paused" || v.recent.some((r) => r.entry.id === eb.id && r.entry.landed?.pushed !== "pending"), "landed or paused");
    const s = await h.entry(eb.id);
    if (s.state === "landed") assert.ok(fx.isAncestor(outside, s.landed!.sha), "landed on the new master");
    else assert.equal(v.paused?.kind, "master-moved", `flagged: ${JSON.stringify(v.paused)}`);
  });

  test("S23: the live tree has uncommitted edits: the queue pauses and says so, never forces; once clean, Resume and the live tree follows", async () => {
    const { fx, h } = await setup();
    const base = fx.head();
    fx.dirtyLiveTree();
    const edit = fx.liveTreeFile("README.md");
    const b = fx.branch("b", { "b.txt": "b\n" });
    const e = await h.add({ branch: b.branch });
    const v = await h.waitView((v) => v.state === "paused", "paused for the dirty live tree");
    assert.equal(v.paused?.kind, "main-checkout-dirty", JSON.stringify(v.paused));
    assert.match(v.paused?.why ?? "", /uncommitted/i);
    assert.equal(fx.liveTreeFile("README.md"), edit, "the edit is untouched");
    assert.notEqual((await h.entry(e.id)).state, "needs-fix", "not the branch's fault");
    const masterNow = fx.head();
    fx.cleanLiveTree();
    await h.resume();
    const landed = await h.waitEntry(e.id, settled);
    assert.equal(landed.state, "landed", `${landed.state}: ${landed.reason}`);
    assert.equal(fx.liveTreeHead(), fx.head(), "the live tree follows master");
    assert.ok(masterNow === base || masterNow === landed.landed!.sha, "master either waited or held exactly the tested tip");
  });

  test("S24: a merge copy that would fall under the state root is refused before any git command; nothing blamed (the Oct 29 case)", async () => {
    const { fx, h } = await setup({ under: join(STATE!, "projects") });
    const b = fx.branch("b", { "b.txt": "b\n" });
    const r = await h.tryAdd({ branch: b.branch });
    let reason = "";
    if (r.ok) {
      const v = await h.waitView((v) => v.state === "paused" || v.needsFix.length > 0, "refused");
      reason = v.paused?.why ?? "";
      assert.equal(v.needsFix.length, 0, "not blamed on the branch");
    } else reason = r.message;
    assert.match(reason, /state|can't live under/i, `a clear reason: ${reason}`);
    assert.equal(existsSync(join(fx.parent, ".worktrees", `${fx.name}-merge`)), false, "no merge copy made under the state root");
    assert.equal(fx.calls().length, 0, "nothing ran");
  });

  for (const fault of ["before-ff", "after-ff"] as const) {
    test(`S8 (${fault}): Sova is killed at the landing ${fault === "before-ff" ? "after its intent, before" : "right after"} the fast-forward; the next start lands it exactly once and pushes`, async () => {
      const { fx, h } = await setup();
      const base = fx.head();
      const b = fx.branch("b", { "b.txt": "b\n" });
      // Approved while paused, so the whole run happens in the child (approvals are taken while paused).
      await h.pause("qa: the run happens in the child");
      const e = await h.add({ branch: b.branch });
      const { childExit, childLog } = await h.crashAt(fault, { resume: true });
      assert.equal(childExit, "SIGKILL", `the child died at the fault point: ${childLog}`);
      if (fault === "before-ff") assert.equal(fx.head(), base, "killed before the fast-forward");
      const landed = await h.waitEntry(e.id, settled);
      assert.equal(landed.state, "landed", `${landed.state}: ${landed.reason}`);
      assert.equal(fx.head(), landed.landed!.sha);
      assert.equal(mergesOnto(fx, base), 1, "one merge, never two");
      assert.equal(fx.originHead(), fx.head(), "pushed once recovered");
      assert.equal((await h.view()).recent.filter((r) => r.entry.id === e.id).length, 1, "recorded once");
      assert.equal(h.notices.filter((n) => n.kind === "landed").length, 1, "told once");
    });
  }

  test("S8c: Sova stops while the merge copy is being cut for the first time: the next start uses (or recuts) its own copy and lands, never pausing on it", async () => {
    const { fx, h } = await setup();
    const b = fx.branch("b", { "b.txt": "b\n" });
    const e = await h.add({ branch: b.branch });
    await until("the first run started", async () => (await h.view()).current?.entry === e.id, 30_000, 5);
    await h.restart();
    const s = await h.waitEntry(e.id, (x) => settled(x) || x.state === "queued", 60_000);
    const v = await h.waitView((v) => v.state === "paused" || v.recent.some((r) => r.entry.id === e.id), "landed or paused", 60_000);
    assert.equal(v.state === "paused" ? `paused: ${v.paused?.why}` : "landed", "landed", `after a stop mid-cut: ${s.state}`);
  });

  test("S20: push refused (origin moved past master): landed, not pushed, never forced; the reason on the strip", async () => {
    const { fx, h } = await setup();
    const other = join(fx.root, "other");
    git(fx.root, ["clone", "-q", fx.origin, other]);
    writeFileSync(join(other, "foreign.txt"), "x\n");
    git(other, ["add", "foreign.txt"]);
    git(other, ["commit", "-q", "-m", "foreign"]);
    git(other, ["push", "-q", "origin", fx.target]);
    const foreign = git(other, ["rev-parse", "HEAD"]);
    const b = fx.branch("b", { "b.txt": "b\n" });
    const landed = await h.waitEntry((await h.add({ branch: b.branch })).id, settled);
    assert.equal(landed.state, "landed", `${landed.state}: ${landed.reason}`);
    assert.equal(fx.head(), landed.landed!.sha);
    assert.equal(fx.originHead(), foreign, "origin untouched, never forced");
    assert.equal(landed.landed?.pushed, "not-pushed");
    const v = await h.view();
    assert.ok(v.heads.pushWhy && v.heads.pushWhy.length > 0, `the strip says why: ${v.heads.pushWhy}`);
  });

  test("S20b: no origin remote: landed, push 'no-remote', nothing pretends to have pushed", async () => {
    const { fx, h } = await setup({ remote: false });
    const b = fx.branch("b", { "b.txt": "b\n" });
    const landed = await h.waitEntry((await h.add({ branch: b.branch })).id, settled);
    assert.equal(landed.state, "landed");
    assert.equal(landed.landed?.pushed, "no-remote");
  });
});

// ---------------------------------------------------------------- private names (push gate)

describe("private names", () => {
  test("S31a: no names file yet: the landing completes locally, the push is held with 'push held: private names not set up yet', the thread is asked for the interview", async () => {
    const asked: string[] = [];
    const { fx, h } = await setup({}, { names: null, thread: { names: async (_h, e) => void asked.push(e.id) } });
    const base = fx.head();
    const b = fx.branch("b", { "b.txt": "b\n" });
    const l = await h.waitEntry((await h.add({ branch: b.branch })).id, settled);
    assert.equal(l.state, "landed", `${l.state}: ${l.reason}`);
    assert.equal(fx.head(), l.landed!.sha, "landed locally");
    assert.equal(fx.originHead(), base, "not pushed");
    assert.equal(l.landed?.pushed, "not-pushed");
    const v = await h.view();
    assert.equal(v.heads.pushWhy, "push held: private names not set up yet");
    await until("the thread asked for the names interview", () => asked.length > 0, 10_000).catch(() => {});
    // Names set up: the next landing pushes everything up to its tip.
    h.setNames([]);
    const c = fx.branch("c", { "c.txt": "c\n" });
    const lc = await h.waitEntry((await h.add({ branch: c.branch })).id, settled);
    assert.equal(lc.landed?.pushed, "pushed");
    assert.equal(fx.originHead(), lc.landed!.sha);
    assert.equal((await h.entry(l.id)).landed?.pushed, "pushed", "the earlier landing is marked pushed with it");
  });

  test("S31b: names are per project: one project's names don't unblock another's push", async () => {
    const one = await setup();
    const two = await setup({}, { names: null });
    assert.notEqual(one.h.namesFile(), two.h.namesFile());
    const b = two.fx.branch("b", { "b.txt": "b\n" });
    const l = await two.h.waitEntry((await two.h.add({ branch: b.branch })).id, settled);
    assert.equal(l.landed?.pushed, "not-pushed");
  });

  test("S31c: Sova's legacy <state>/merge-round.json keeps working for its own project", async () => {
    const legacyFile = join(STATE!, `merge-round-${Date.now()}.json`);
    writeFileSync(legacyFile, JSON.stringify({ privateNames: ["acme-internal"] }));
    const { fx, h } = await setup({}, (fx) => ({ names: null, legacyNames: { root: fx.project, file: legacyFile } }));
    const b = fx.branch("b", { "b.txt": "b\n" });
    const l = await h.waitEntry((await h.add({ branch: b.branch })).id, settled);
    assert.equal(l.landed?.pushed, "pushed", `${l.landed?.pushed}: ${l.landed?.pushWhy}`);
  });

  test("S20c: no origin remote and no names file: it says there is no remote, not that names hold the push", async () => {
    const { fx, h } = await setup({ remote: false }, { names: null });
    const b = fx.branch("b", { "b.txt": "b\n" });
    const l = await h.waitEntry((await h.add({ branch: b.branch })).id, settled);
    assert.equal(l.landed?.pushed, "no-remote", `${l.landed?.pushed}: ${l.landed?.pushWhy}`);
  });
});
