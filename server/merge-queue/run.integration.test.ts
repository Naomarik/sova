// One merge run, alone (no queue), on real throwaway repositories: where the copy goes, what each step does, and
// whose failure a red check is. The queue around it is tested in the scenario suite.
import { after, describe, test } from "node:test";
import { expect } from "./testing/expect";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { MergeEntry, RunStep } from "../../shared/merge-queue";
import { parseDefinition } from "../../shared/project-contract";
import type { RunInput, RunOutcome } from "./contract";
import { mergeCopyPath } from "./copy";
import { Fixture, git, REPO_ROOT } from "./testing/repo";
import { deliverReview, type StartReviewer } from "./review-step";
import { engineServices, makeRunMerge, type RunDeps } from "./run";

const fixtures: Fixture[] = [];
after(() => {
  for (const f of fixtures) f.dispose();
});
const fixture = (o: ConstructorParameters<typeof Fixture>[0] = {}) => {
  const f = new Fixture(o);
  fixtures.push(f);
  return f;
};

let n = 0;
async function run(fx: Fixture, br: { branch: string; commit: string; checkout?: string }, o: { deps?: RunDeps; resolution?: string; drafts?: boolean; review?: boolean; picks?: RunInput["picks"]; signal?: AbortSignal; awaitReview?: RunInput["awaitReview"]; tryOnly?: boolean } = {}) {
  const runId = `mr_t${++n}`;
  const runDir = join(fx.root, "runs", runId);
  mkdirSync(runDir, { recursive: true });
  const base = fx.head();
  const defText = fx.fileAt(base, ".sova/project.json");
  const entry = { id: `me_${n}`, project: "p1", target: fx.target, branch: br.branch, commit: br.commit, approval: { by: "land-button", at: new Date().toISOString(), commit: br.commit }, state: "checking", runs: [runId], picks: [], notes: [], createdAt: "", updatedAt: "" } as MergeEntry;
  const steps = new Map<string, RunStep>();
  const order: string[] = [];
  let checks: unknown[] = [];
  let merged: string | undefined;
  const input: RunInput = {
    runId,
    entry,
    project: { id: "p1", root: fx.project, target: fx.target, def: defText ? parseDefinition(defText) : null },
    base,
    commit: br.commit,
    ...(o.resolution ? { resolution: o.resolution } : {}),
    runDir,
    ...(o.drafts && br.checkout ? { draftsDir: join(br.checkout, ".sova/spec/drafts") } : {}),
    picks: o.picks ?? [],
    review: !!o.review,
    signal: o.signal ?? new AbortController().signal,
    // The review answers through deliverReview here (review-step.ts), never the queue's own waiter.
    ...(o.tryOnly ? { tryOnly: true as const } : {}),
    awaitReview: o.awaitReview ?? (() => new Promise(() => {})),
  };
  const out: RunOutcome = await makeRunMerge({ specCore: join(REPO_ROOT, "pi-config/extensions/spec/core"), ...o.deps })(input, {
    step: (s) => {
      if (!steps.has(s.id)) order.push(s.id);
      steps.set(s.id, s);
    },
    checks: (l) => (checks = l),
    merged: (sha) => (merged = sha),
  });
  const log = (id: string) => readFileSync(join(runDir, steps.get(id)!.log), "utf8");
  return { out, steps, order, checks, merged, base, runDir, log };
}

const callsAt = (fx: Fixture, script: string) => fx.calls().filter((c) => c.script === script);

describe("a merge run", () => {
  test("clean: merged in the copy beside the project, set up, checked at the merge, logged from the first step; the target unmoved", async () => {
    const fx = fixture();
    const br = fx.branch("ok", { "src/app.txt": "changed\n" });
    const before = fx.head();
    const r = await run(fx, br);
    expect(r.out).toMatchObject({ verdict: "passed", copy: mergeCopyPath(fx.project) });
    expect(r.out.tip).toBe(r.merged!);
    expect(r.out.copy).not.toContain("/.pi/");
    // The tested tip is the merge of exactly the approved commit onto the target's head.
    expect(git(fx.project, ["rev-parse", `${r.out.tip}^1`])).toBe(before);
    expect(git(fx.project, ["rev-parse", `${r.out.tip}^2`])).toBe(br.commit);
    expect(fx.head()).toBe(before);
    expect(r.order.slice(0, 3)).toEqual(["copy", "merge", "setup:prep"]);
    expect(r.order).toContain("check:build");
    expect(r.order).toContain("check:unit");
    expect(r.log("copy")).toMatch(/^== Merge copy/);
    expect(r.log("setup:prep")).toContain("setup: done");
    for (const c of [...callsAt(fx, "build"), ...callsAt(fx, "unit")]) {
      expect(c.cwd).toBe(mergeCopyPath(fx.project));
      expect(c.head).toBe(r.out.tip!);
      expect(c.env.SOVA_VERB).toBe("merge");
      expect(c.env.SOVA_MERGE_BASE).toBe(before);
    }
    expect(r.checks).toEqual([{ id: "build", label: "Build", source: "required" }, { id: "unit", label: "Unit tests", source: "required" }]);
    // A second run reuses the copy and its setup (inputs unchanged): skipped, logged as such.
    const br2 = fx.branch("ok2", { "README.md": "# demo 2\n" });
    const r2 = await run(fx, br2);
    expect(r2.out.verdict).toBe("passed");
    expect(r2.steps.get("setup:prep")).toMatchObject({ result: "skipped", detail: "unchanged since the last run" });
  });

  test("a conflict ends the run at the merge, naming the files; the copy is left clean", async () => {
    const fx = fixture();
    const br = fx.branch("conf", { "src/list.txt": "alpha\nbravo\ncharlie\ndelta\n" });
    fx.commitIn(fx.project, { "src/list.txt": "alpha\nbravo\ncharlie\necho\n" }, "master: echo");
    const r = await run(fx, br);
    expect(r.out).toMatchObject({ verdict: "conflict", conflict: { files: ["src/list.txt"] } });
    expect(r.order).not.toContain("check:unit");
    expect(git(r.out.copy!, ["status", "--porcelain"])).toBe("");
    // The thread's resolution, taken: lands as the tested tip.
    git(fx.project, ["checkout", "-q", "--detach", fx.head()]);
    git(fx.project, ["merge", "--no-ff", "--no-edit", br.commit], { allowFail: true });
    fx.commitIn(fx.project, { "src/list.txt": "alpha\nbravo\ncharlie\necho\ndelta\n" }, "resolve");
    const resolution = git(fx.project, ["rev-parse", "HEAD"]);
    git(fx.project, ["checkout", "-q", fx.target]);
    const r2 = await run(fx, br, { resolution });
    expect(r2.out).toMatchObject({ verdict: "passed", tip: resolution });
  });

  test("a failure of the branch's: the file again on the merge, then on the target alone in the same copy; blamed on the branch", async () => {
    const fx = fixture();
    const br = fx.branch("red", { "tests/a.txt": "fail\n" });
    const r = await run(fx, br);
    expect(r.out).toMatchObject({ verdict: "failed", blame: "branch" });
    expect(r.out.why).toContain("tests/a.txt");
    const units = callsAt(fx, "unit");
    expect(units.map((c) => [c.argv, c.head === r.out.tip ? "tip" : c.head === r.base ? "target" : c.head])).toEqual([
      [[], "tip"],
      [["tests/a.txt"], "tip"],
      [["tests/a.txt"], "target"],
    ]);
    expect(new Set(units.map((c) => c.cwd))).toEqual(new Set([mergeCopyPath(fx.project)]));
    expect(r.order).toEqual(expect.arrayContaining(["rerun-tip:unit", "rerun-master:copy", "rerun-master:unit"]));
    expect(r.steps.get("check:unit")!.failures?.[0]).toMatchObject({ file: "tests/a.txt" });
  });

  test("flaky (passes on a rerun) and failing on the target too are noted, never blocking", async () => {
    const fx = fixture({ files: { "tests/b.txt": "fail\n" } });
    const br = fx.branch("mixed", { "tests/a.txt": "flaky\n" });
    const r = await run(fx, br);
    expect(r.out.verdict).toBe("passed");
    expect(r.out.notes.map((x) => x.kind).sort()).toEqual(["flaky", "master-red"]);
    expect(r.out.notes.find((x) => x.kind === "flaky")!.text).toContain("tests/a.txt");
    expect(r.out.notes.find((x) => x.kind === "master-red")!.text).toContain("tests/b.txt");
  });

  test("a whole check red on the target alone: noted, the target listed red; red only with the branch: the branch's", async () => {
    const fx = fixture({ files: { "build.conf": "broken\n" } });
    const br = fx.branch("on-red", { "src/app.txt": "x\n" });
    const r = await run(fx, br);
    expect(r.out).toMatchObject({ verdict: "passed", targetRed: ["Build"] });
    const fx2 = fixture();
    const br2 = fx2.branch("breaks-build", { "build.conf": "broken\n" });
    const r2 = await run(fx2, br2);
    expect(r2.out).toMatchObject({ verdict: "failed", blame: "branch", why: "Build failed (passes on master alone)" });
  });

  test("setup broken on the target too: machine, nobody blamed; broken only by the branch: the branch's, with the setup log", async () => {
    const fx = fixture({ files: { "setup.conf": "broken\n" } });
    const br = fx.branch("innocent", { "src/app.txt": "x\n" });
    const r = await run(fx, br);
    expect(r.out).toMatchObject({ verdict: "machine", blame: "machine" });
    expect(r.out.why).toContain("on master alone too");
    expect(r.log("setup:prep")).toContain("setup: broken");
    expect(r.order).not.toContain("check:unit");
    const fx2 = fixture();
    const br2 = fx2.branch("breaks-setup", { "setup.conf": "broken\n" });
    const r2 = await run(fx2, br2);
    expect(r2.out).toMatchObject({ verdict: "failed", blame: "branch" });
    expect(r2.out.why).toMatch(/setup \(prep\) fails with your branch and passes on master alone \(log: logs\/\d+-rerun-tip_setup_prep\.log\)/);
  });

  test("setup that fails once (a blip) passes on a rerun on the merge: noted flaky, nobody blamed, the run goes on", async () => {
    const fx = fixture();
    const r = await run(fx, fx.branch("blip", { "setup.conf": "broken-once\n" }));
    expect(r.out.verdict).toBe("passed");
    expect(r.out.notes.find((x) => x.kind === "flaky")!.text).toContain("setup (prep)");
    expect(r.steps.get("rerun-tip:setup:prep")).toMatchObject({ result: "passed" });
    expect(r.order).not.toContain("rerun-master:setup:prep");
  });

  test("a dependency change runs the offline install; one that can't install is the branch's", async () => {
    const fx = fixture();
    const br = fx.branch("deps", { "deps.lock": "v2\n" });
    const r = await run(fx, br);
    expect(r.out.verdict).toBe("passed");
    expect(r.steps.get("install")).toMatchObject({ result: "passed", why: "deps.lock changed" });
    expect(callsAt(fx, "install")).toHaveLength(1);
    const br2 = fx.branch("deps-broken", { "deps.lock": "broken\n" });
    const r2 = await run(fx, br2);
    expect(r2.out).toMatchObject({ verdict: "failed", blame: "branch" });
    expect(r2.out.why).toContain("offline install");
    // A branch that doesn't touch the lockfile installs nothing.
    const br3 = fx.branch("no-deps", { "README.md": "x\n" });
    const r3 = await run(fx, br3);
    expect(r3.steps.has("install")).toBe(false);
  });

  test("the spec drafts become a docs commit on the merge before any check, and the checks run on it", async () => {
    const fx = fixture();
    await fx.withSpec();
    const br = fx.branch("docs", { "src/app.txt": "documented\n" });
    fx.draft(br.checkout, "docs");
    const r = await run(fx, br, { drafts: true });
    expect(r.out.verdict).toBe("passed");
    expect(r.steps.get("docs")!.result).toBe("passed");
    expect(r.out.tip).not.toBe(r.merged);
    expect(git(fx.project, ["rev-parse", `${r.out.tip}^`])).toBe(r.merged!);
    expect(git(fx.project, ["show", `${r.out.tip}:.sova/spec/claims/b/docs.md`])).toContain("The docs feature");
    expect(git(fx.project, ["log", "-1", "--format=%B", r.out.tip!])).toContain("Sova-Spec-Landing: merge-queue");
    expect(r.order.indexOf("docs")).toBeLessThan(r.order.indexOf("check:build"));
    for (const c of callsAt(fx, "unit")) expect(c.head).toBe(r.out.tip!);
    // The drafts never stay in the copy for the next run.
    const r2 = await run(fx, fx.branch("after", { "README.md": "y\n" }));
    expect(r2.out.verdict).toBe("passed");
    expect(existsSync(join(r2.out.copy!, ".sova/spec/drafts/docs"))).toBe(false);
  });

  test("a copy that would be under the state root is refused before any git command (the Oct 29 failure)", async () => {
    const fx = fixture();
    const br = fx.branch("ok", { "src/app.txt": "x\n" });
    // A state root that holds the project's parent: the copy beside the project would be inside it.
    const r = await run(fx, br, { deps: { state: fx.parent } });
    expect(r.out.verdict).toBe("machine");
    expect(r.out.why).toMatch(/^refused: .*state root/);
    expect(existsSync(mergeCopyPath(fx.project))).toBe(false);
    expect(git(fx.project, ["worktree", "list"])).not.toContain("-merge");
    expect(callsAt(fx, "setup")).toHaveLength(0);
  });

  test("a check that times out voids the run; an abort voids it too", async () => {
    const fx = fixture();
    const def = fx.definition();
    (def.merge as { checks: { timeout?: number }[] }).checks[1]!.timeout = 2;
    fx.commitIn(fx.project, { ".sova/project.json": JSON.stringify(def, null, 2) }, "unit times out at 2 s");
    const br = fx.branch("hang", { "tests/a.txt": "hang\n" });
    const r = await run(fx, br);
    expect(r.out).toMatchObject({ verdict: "void" });
    expect(r.out.why).toContain("timed out");
    const ctl = new AbortController();
    const br2 = fx.branch("hang2", { "tests/b.txt": "hang\n" });
    const pending = run(fx, br2, { signal: ctl.signal });
    for (let i = 0; i < 400 && !callsAt(fx, "unit").some((c) => c.argv.length === 0 && (c.result as string) === "hang" && c.head !== r.out.tip); i++) await new Promise((r) => setTimeout(r, 25));
    ctl.abort();
    expect((await pending).out.verdict).toBe("void");
  });

  test("no checks declared: lands after a clean merge, labelled so; one test command: it is the check", async () => {
    const fx = fixture({ checks: "none" });
    const r = await run(fx, fx.branch("x", { "src/app.txt": "x\n" }));
    expect(r.out).toMatchObject({ verdict: "passed", noChecks: true });
    expect(r.out.notes[0]).toMatchObject({ kind: "no-checks" });
    const fx2 = fixture({ checks: "test-command", target: "main" });
    const r2 = await run(fx2, fx2.branch("y", { "tests/a.txt": "fail\n" }));
    expect(r2.checks).toEqual([{ id: "test", label: "Tests", source: "required" }]);
    expect(r2.out).toMatchObject({ verdict: "failed", blame: "branch" });
    expect(r2.out.why).toContain("passes on main alone");
    expect(callsAt(fx2, "runner").map((c) => c.argv)).toEqual([[], ["tests/a.txt"], ["tests/a.txt"]]);
  });

  test("the review runs beside the checks: ok, notes, blocking (waits for the user), and a reviewer that fails twice (never the branch's)", async () => {
    const fx = fixture({ review: true });
    // A stand-in reviewer: reads review.conf at the commit it is given and answers through deliverReview.
    const started: string[] = [];
    const startReviewer: StartReviewer = async (o) => {
      started.push(o.commit);
      const conf = git(fx.project, ["show", `${o.commit}:review.conf`]);
      if (conf === "crash") throw new Error("reviewer crashed");
      setTimeout(() => {
        const [verdict, ...text] = conf.split(":");
        deliverReview(o.runId, { verdict: verdict!.trim() as "ok", ...(text.length ? { text: text.join(":").trim() } : {}) });
      }, 20);
      return { sessionId: `s-${started.length}`, stop: async () => {} };
    };
    const deps = { startReviewer, reviewTimeoutMs: 10_000 };
    const ok = await run(fx, fx.branch("r-ok", { "src/app.txt": "a\n" }), { review: true, deps });
    expect(ok.out).toMatchObject({ verdict: "passed", review: { verdict: "ok" } });
    expect(started[0]).toBe(ok.out.tip!);
    const notes = await run(fx, fx.branch("r-notes", { "review.conf": "notes: a helper is duplicated\n" }), { review: true, deps });
    expect(notes.out.verdict).toBe("passed");
    expect(notes.out.notes.find((x) => x.kind === "review")!.text).toBe("a helper is duplicated");
    const blocking = await run(fx, fx.branch("r-block", { "review.conf": "blocking: leaves a workaround in\n" }), { review: true, deps });
    expect(blocking.out).toMatchObject({ verdict: "review-flagged", tip: blocking.merged });
    const crash = await run(fx, fx.branch("r-crash", { "review.conf": "crash\n" }), { review: true, deps });
    expect(crash.out).toMatchObject({ verdict: "machine", blame: "reviewer" });
    expect(crash.log("review")).toContain("starting reviewer 2 of 2");
    // The queue's own waiter answers too (merge.review when nothing waits in review-step).
    const viaQueue: StartReviewer = async (o) => ({ sessionId: `q-${o.attempt}`, stop: async () => {} });
    const q = await run(fx, fx.branch("r-queue", { "src/app.txt": "q\n" }), { review: true, deps: { startReviewer: viaQueue, reviewTimeoutMs: 10_000 }, awaitReview: async () => ({ verdict: "notes", text: "via the queue", commit: "x", at: "y" }) });
    expect(q.out.notes.find((x) => x.kind === "review")!.text).toBe("via the queue");
    // A branch the checks blame: its own failure wins; the review is never waited on.
    const red = await run(fx, fx.branch("r-red", { "tests/a.txt": "fail\n", "review.conf": "ok\n" }), { review: true, deps });
    expect(red.out).toMatchObject({ verdict: "failed", blame: "branch" });
  });

  test("two projects run at once, each in its own copy (same repo name, different folders): no shared lock, no crossing", async () => {
    const a = fixture({ name: "app" });
    const b = fixture({ name: "app" });
    expect(mergeCopyPath(a.project)).not.toBe(mergeCopyPath(b.project));
    // Each holds its unit check at a gate until both are running: they must overlap to pass.
    const ba = a.branch("x", { "tests/a.txt": "gate a\n" });
    const bb = b.branch("y", { "tests/a.txt": "gate b\n" });
    const ra = run(a, ba);
    const rb = run(b, bb);
    for (let i = 0; i < 400 && !(a.atGate("a") && b.atGate("b")); i++) await new Promise((r) => setTimeout(r, 25));
    expect(a.atGate("a") && b.atGate("b")).toBe(true);
    a.openGate("a");
    b.openGate("b");
    const [oa, ob] = await Promise.all([ra, rb]);
    expect(oa.out).toMatchObject({ verdict: "passed", copy: mergeCopyPath(a.project) });
    expect(ob.out).toMatchObject({ verdict: "passed", copy: mergeCopyPath(b.project) });
    expect(new Set(callsAt(a, "unit").map((c) => c.cwd))).toEqual(new Set([mergeCopyPath(a.project)]));
    expect(new Set(callsAt(b, "unit").map((c) => c.cwd))).toEqual(new Set([mergeCopyPath(b.project)]));
  });

  test("a branch worktree where the copy would go (a branch named merge) is refused, never reset", async () => {
    const fx = fixture();
    git(fx.project, ["worktree", "add", "-q", "-b", "merge", mergeCopyPath(fx.project), fx.target]);
    const mine = join(mergeCopyPath(fx.project), "work-in-progress.txt");
    writeFileSync(mine, "unsaved\n");
    const r = await run(fx, fx.branch("z", { "src/app.txt": "z\n" }));
    expect(r.out.verdict).toBe("machine");
    expect(r.out.why).toMatch(/worktree the queue didn't make \(branch merge\)/);
    expect(readFileSync(mine, "utf8")).toBe("unsaved\n");
  });

  test("one test command that needs a service: the service runs in the copy on its own slot's port, then stops", async () => {
    const { ProjectEngine } = await import("../project-services/engine");
    const { DetachedDriver } = await import("../project-services/drivers");
    const fx = fixture({ checks: "test-command", requireService: { portBase: 47610 } });
    const engine = new ProjectEngine({ driver: new DetachedDriver() });
    const r = await run(fx, fx.branch("svc", { "src/app.txt": "svc\n" }), { deps: { services: engineServices(engine) } });
    expect(r.out.verdict).toBe("passed");
    const runner = callsAt(fx, "runner");
    expect(runner).toHaveLength(1);
    expect(runner[0]!.result).toBe("pass");
    expect(runner[0]!.cwd).toBe(mergeCopyPath(fx.project));
    expect(r.steps.get("services")).toMatchObject({ result: "passed" });
    expect(r.log("services")).toMatch(/down .*: stopped/);
    // Without anything that can start services, it's the machine's problem, never the branch's.
    const r2 = await run(fx, fx.branch("svc2", { "src/app.txt": "svc2\n" }), { deps: { services: undefined } });
    expect(r2.out).toMatchObject({ verdict: "machine" });
    expect(r2.out.why).toMatch(/need svc running/);
  });

  test("a cut a stop interrupted is recovered: a detached worktree with no mark, or a locked record with no folder", async () => {
    const fx = fixture();
    const copy = mergeCopyPath(fx.project);
    git(fx.project, ["worktree", "add", "-q", "--detach", copy, fx.target]);
    const r = await run(fx, fx.branch("after-stop", { "src/app.txt": "a\n" }));
    expect(r.out.verdict).toBe("passed");
    const fx2 = fixture();
    const copy2 = mergeCopyPath(fx2.project);
    git(fx2.project, ["worktree", "add", "-q", "--detach", copy2, fx2.target]);
    git(fx2.project, ["worktree", "lock", copy2]);
    rmSync(copy2, { recursive: true, force: true });
    const r2 = await run(fx2, fx2.branch("after-stop2", { "src/app.txt": "b\n" }));
    expect(r2.out.verdict).toBe("passed");
  });

  test("Try It on Main: the declared checks on the target itself, nothing merged; red is the project's own", async () => {
    const fx = fixture();
    const before = fx.head();
    const ok = await run(fx, { branch: fx.target, commit: before }, { tryOnly: true });
    expect(ok.out).toMatchObject({ verdict: "passed" });
    expect(ok.out.tip).toBeUndefined();
    expect(ok.order).not.toContain("merge");
    for (const c of callsAt(fx, "unit")) expect(c.head).toBe(before);
    const red = fixture({ files: { "tests/b.txt": "fail\n" } });
    const r = await run(red, { branch: red.target, commit: red.head() }, { tryOnly: true });
    expect(r.out.verdict).toBe("failed");
    expect(r.out.blame).toBeUndefined();
    expect(r.out.why).toBe("Unit tests fails on master itself");
    const none = fixture({ checks: "none" });
    expect((await run(none, { branch: none.target, commit: none.head() }, { tryOnly: true })).out).toMatchObject({ verdict: "passed", noChecks: true });
  });

  test("every step's log exists from its first line", async () => {
    const fx = fixture();
    const r = await run(fx, fx.branch("logs", { "tests/a.txt": "fail\n" }));
    const files = readdirSync(join(r.runDir, "logs")).filter((f) => f.endsWith(".log"));
    expect(files.length).toBe(r.steps.size);
    for (const s of r.steps.values()) expect(readFileSync(join(r.runDir, s.log), "utf8")).toMatch(/^== /);
  });
});
