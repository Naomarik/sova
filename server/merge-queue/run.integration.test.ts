// One merge run, alone (no queue), on real throwaway repositories: where the copy goes, what each step does, and
// whose failure a red check is. The queue around it is tested in the scenario suite.
import { after, describe, test } from "node:test";
import { spawnSync } from "node:child_process";
import { expect } from "./testing/expect";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
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

  test("a whole check naming nothing, red on the target too: unattributed (never landed as the target's); red only with the branch: the branch's", async () => {
    const fx = fixture({ files: { "build.conf": "broken\n" } });
    const br = fx.branch("on-red", { "src/app.txt": "x\n" });
    const r = await run(fx, br);
    expect(r.out).toMatchObject({ verdict: "unattributed", why: "can't tell whose failure: Build fails on master too and names no tests", targetRed: ["Build"], unclear: [{ check: "build", label: "Build", step: "rerun-master:build" }] });
    expect(r.out.blame).toBeUndefined();
    // The tested merge is what Land Anyway would land.
    expect(r.out.tip).toBe(r.merged!);
    expect(r.steps.get("rerun-master:build")!.result).toBe("failed");
    const fx2 = fixture();
    const br2 = fx2.branch("breaks-build", { "build.conf": "broken\n" });
    const r2 = await run(fx2, br2);
    expect(r2.out).toMatchObject({ verdict: "failed", blame: "branch", why: "Build failed (passes on master alone)" });
  });

  test("named failures: the target fails as many tests as the merge, other names: the branch's; only the same names: noted", async () => {
    // Names without files (Kaocha): master fails a, the branch fixes a and breaks b. One failure each side.
    const fx = fixture({ files: { "unit.names-only": "1\n", "tests/a.txt": "fail\n", "tests/b.txt": "ok\n" } });
    const br = fx.branch("swap", { "tests/a.txt": "ok\n", "tests/b.txt": "fail\n" });
    const r = await run(fx, br);
    expect(r.out).toMatchObject({ verdict: "failed", blame: "branch" });
    expect(r.out.why).toContain("b.txt");
    expect(r.out.why).not.toContain("a.txt");
    // Named the same on both sides: master's, noted, lands.
    const fx2 = fixture({ files: { "unit.names-only": "1\n", "tests/a.txt": "fail\n" } });
    const r2 = await run(fx2, fx2.branch("same", { "src/app.txt": "x\n" }));
    expect(r2.out.verdict).toBe("passed");
    expect(r2.out.notes.find((n) => n.kind === "master-red")!.text).toContain("a.txt");
  });

  test("D14, Kaocha's names: the target red on test A, the branch breaks B: the branch's, naming B; breaking only A (its lines moved): noted, lands", async () => {
    const fx = fixture({ files: { "unit.kaocha": "1\n", "tests/a.txt": "fail\n", "tests/b.txt": "ok\n" } });
    const br = fx.branch("breaks-b", { "tests/b.txt": "fail\n" });
    const r = await run(fx, br);
    expect(r.out).toMatchObject({ verdict: "failed", blame: "branch" });
    expect(r.out.why).toContain("app.unit-test/b");
    expect(r.out.why).not.toContain("app.unit-test/a");
    expect(r.out.why).not.toContain("unit_test.clj");
    expect(r.out.notes.find((n) => n.kind === "master-red")!.text).toContain("app.unit-test/a");
    // The control: the branch touches only A (still failing, at another line): the same test, master's; it lands.
    const fx2 = fixture({ files: { "unit.kaocha": "1\n", "tests/a.txt": "fail\n", "tests/b.txt": "ok\n" } });
    const r2 = await run(fx2, fx2.branch("moves-a", { "tests/a.txt": "fail\n\n\n" }));
    expect(r2.out.verdict).toBe("passed");
    expect(r2.out.notes.find((n) => n.kind === "master-red")!.text).toContain("app.unit-test/a");
  });

  test("D15, failures reported by a bare file name (no repo path): followed by name, never 'the target hasn't these files'", async () => {
    const files = { "unit.basename": "1\n", "tests/a.txt": "fail\n", "tests/b.txt": "ok\n" };
    const fx = fixture({ files });
    const r = await run(fx, fx.branch("clean", { "doc.txt": "a comment\n" }));
    expect(r.out.verdict).toBe("passed");
    expect(r.out.notes.find((n) => n.kind === "master-red")!.text).toContain("a.txt");
    expect(r.steps.get("rerun-master:unit")!.detail).not.toContain("hasn't these test files");
    const fx2 = fixture({ files });
    const r2 = await run(fx2, fx2.branch("breaks-b", { "tests/b.txt": "fail\n" }));
    expect(r2.out).toMatchObject({ verdict: "failed", blame: "branch" });
    expect(r2.out.why).toContain("b.txt");
    expect(r2.out.why).not.toContain("a.txt");
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

  describe("tracked spec drafts (a project that commits its drafts)", () => {
    /** Draft i's name: letters only (a § id takes no digits). */
    const nm = (i: number) => `stale${String.fromCharCode(97 + Math.floor(i / 26) % 26)}${String.fromCharCode(97 + (i % 26))}`;
    /** A project whose drafts are tracked: `n` stale drafts on the target, each adding its own §b/<name>. */
    async function tracked(n: number) {
      const fx = fixture();
      await fx.withSpec();
      writeFileSync(join(fx.project, ".sova/spec/.gitignore"), "");
      writeFileSync(join(fx.project, ".gitignore"), readFileSync(join(fx.project, ".gitignore"), "utf8").replace(".sova/spec/drafts/\n", ""));
      fx.draft(fx.project, nm(0));
      const src = join(fx.project, ".sova/spec/drafts", nm(0));
      for (let i = 1; i < n; i++) {
        const name = nm(i);
        const dst = join(fx.project, ".sova/spec/drafts", name);
        cpSync(src, dst, { recursive: true });
        // Its own claim, so a stale draft that landed would show.
        for (const ext of ["md", "json"]) {
          const from = join(dst, "spec/claims/b", `${nm(0)}.${ext}`);
          writeFileSync(join(dst, "spec/claims/b", `${name}.${ext}`), readFileSync(from, "utf8").replaceAll(nm(0), name));
          rmSync(from);
        }
        writeFileSync(join(dst, "draft.json"), readFileSync(join(dst, "draft.json"), "utf8").replaceAll(nm(0), name));
      }
      git(fx.project, ["add", "-A", ".sova/spec", ".gitignore"]);
      git(fx.project, ["commit", "-q", "-m", `${n} tracked drafts`]);
      return fx;
    }
    const claimsAt = (fx: Fixture, rev: string) => git(fx.project, ["ls-tree", "-r", "--name-only", rev, ".sova/spec/claims/b"]).split("\n").filter(Boolean);
    const draftsAt = (fx: Fixture, rev: string) => git(fx.project, ["ls-tree", "-r", "--name-only", rev, ".sova/spec/drafts"]);

    test("a comment-only branch on a project with hundreds of stale tracked drafts lands cleanly: no docs commit, drafts untouched", async () => {
      const fx = await tracked(200);
      const before = fx.head();
      const br = fx.branch("comment", { "README.md": "# demo\n<!-- a comment -->\n" });
      const r = await run(fx, br, { drafts: true });
      expect(r.out.verdict).toBe("passed");
      expect(draftsAt(fx, before).split("\n").filter((f) => f.endsWith(".md")).length).toBeTruthy();
      expect(r.steps.get("docs")).toMatchObject({ result: "skipped", detail: "no spec drafts of the branch's own" });
      expect(r.out.tip).toBe(r.merged);
      expect(claimsAt(fx, r.out.tip!)).toEqual([]);
      expect(draftsAt(fx, r.out.tip!)).toBe(draftsAt(fx, before));
      expect(git(r.out.copy!, ["status", "--porcelain"])).toBe("");
    });

    test("a branch that changes one of hundreds of tracked drafts lands exactly that draft; the others stay as they were", async () => {
      const fx = await tracked(200);
      const before = fx.head();
      const br = fx.branch("one", { "src/app.txt": "changed\n" });
      fx.editDraft(br.checkout, nm(7), "Stale seven, now meant.");
      // A changed draft needs its chat's note again (the record's text changed).
      spawnSync(process.execPath, [join(REPO_ROOT, "pi-config/extensions/spec/core/sova-spec-draft.mjs"), "evidence", nm(7), "--id", `§b/${nm(7)}`, "--by", "chat", "--verification", "checked", "--note", "--write", "--root", br.checkout, "--json"], { cwd: br.checkout });
      git(br.checkout, ["add", "-A", `.sova/spec/drafts/${nm(7)}`]);
      git(br.checkout, ["commit", "-q", "-m", "stale-7 meant"]);
      const commit = git(br.checkout, ["rev-parse", "HEAD"]);
      const r = await run(fx, { ...br, commit }, { drafts: true });
      expect(r.out.verdict, r.out.why).toBe("passed");
      expect(r.steps.get("docs")!.result).toBe("passed");
      expect(claimsAt(fx, r.out.tip!).sort()).toEqual([`.sova/spec/claims/b/${nm(7)}.json`, `.sova/spec/claims/b/${nm(7)}.md`]);
      expect(git(fx.project, ["show", `${r.out.tip}:.sova/spec/claims/b/${nm(7)}.md`])).toContain("Stale seven, now meant.");
      // The docs commit touches no draft: the tracked drafts are the merge's, untouched.
      expect(git(fx.project, ["diff", "--name-only", `${r.merged}..${r.out.tip}`, "--", ".sova/spec/drafts"])).toBe("");
      expect(draftsAt(fx, before).length).toBeTruthy();
      expect(git(r.out.copy!, ["status", "--porcelain"])).toBe("");
    });

    test("a branch whose own draft doesn't fit still gets the plain answer", async () => {
      const fx = await tracked(20);
      const br = fx.branch("misfit", { "src/app.txt": "x\n" });
      fx.draft(br.checkout, "mine");
      // Changed after its chat's note: land refuses it.
      fx.editDraft(br.checkout, "mine", "Changed after the note.");
      const r = await run(fx, br, { drafts: true });
      expect(r.out).toMatchObject({ verdict: "failed", blame: "branch" });
      expect(r.out.why).toMatch(/^your spec drafts don't fit/);
      expect(r.out.why).toContain("§b/mine");
      expect(r.out.why).not.toContain("§b/stale");
    });
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

  test("a minimal definition (merge checks only: no setup, no services) runs and lands", async () => {
    const fx = fixture();
    fx.commitIn(fx.project, { ".sova/project.json": JSON.stringify({ version: 1, merge: { checks: [{ id: "tests", label: "Tests", run: ["sh", "-c", "node checks/unit.mjs"] }] } }) }, "minimal definition");
    const r = await run(fx, fx.branch("min", { "src/app.txt": "m\n" }));
    expect(r.out).toMatchObject({ verdict: "passed" });
    expect(r.order).toEqual(["copy", "merge", "docs", "check:tests"]);
    const r2 = await run(fx, fx.branch("min-red", { "tests/a.txt": "fail\n" }));
    expect(r2.out).toMatchObject({ verdict: "failed", blame: "branch" });
  });

  test("every step's log exists from its first line", async () => {
    const fx = fixture();
    const r = await run(fx, fx.branch("logs", { "tests/a.txt": "fail\n" }));
    const files = readdirSync(join(r.runDir, "logs")).filter((f) => f.endsWith(".log"));
    expect(files.length).toBe(r.steps.size);
    for (const s of r.steps.values()) expect(readFileSync(join(r.runDir, s.log), "utf8")).toMatch(/^== /);
  });
});

/**
 * A stand-in for Sova's own runner (scripts/run-tests.mjs) as the target alone may carry it: tests/group-*.txt are a
 * slow group's files, which `--landing` runs only when the change triggers them (SOVA_MERGE_CHANGED names a file),
 * whatever files are named; everyday files always run. With `runner.reports-ran` in the tree it lists the files it ran
 * in SOVA_OUT (`ranFiles`), as the runner does now; without it, it is the old runner, which lists none.
 */
const LANDING_RUNNER = (calls: string) => `
import { appendFileSync, existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
const args = process.argv.slice(2);
const named = args.filter((a) => !a.startsWith("-") && a.startsWith("tests/"));
appendFileSync(${JSON.stringify(calls)}, JSON.stringify({ argv: args, head: process.env.SOVA_MERGE_TIP }) + "\\n");
const all = readdirSync("tests").filter((f) => f.endsWith(".txt")).sort().map((f) => "tests/" + f);
let files = named.length ? all.filter((f) => named.includes(f)) : all;
if (args.includes("--landing")) {
  const changed = process.env.SOVA_MERGE_CHANGED ? readFileSync(process.env.SOVA_MERGE_CHANGED, "utf8").trim() : "";
  // runner.named-filtered: named files are filtered too, on the merge as well (the landing selection never re-triggers
  // a group for a named file), so a rerun of a group file runs nothing anywhere.
  if (!changed || (named.length && existsSync("runner.named-filtered"))) files = files.filter((f) => !f.startsWith("tests/group-"));
}
const failures = files.filter((f) => readFileSync(f, "utf8").trim() === "fail").map((f) => ({ file: f, name: f }));
const out = { passed: files.length - failures.length, failed: failures.length, errors: 0, skipped: 0, failures, failingFiles: failures.map((f) => f.file) };
if (existsSync("runner.reports-ran")) out.ranFiles = files;
if (process.env.SOVA_OUT) writeFileSync(process.env.SOVA_OUT, JSON.stringify(out));
for (const f of failures) console.log("FAIL " + f.file);
process.exit(failures.length ? 1 : 0);
`;

/** A project whose integration check is the landing selection (no `test` command unless `withTest`). */
function landingProject(o: { newRunner: boolean; withTest?: boolean; files: Record<string, string> }) {
  const fx = fixture({ files: o.files });
  const calls = join(fx.state, "lt-calls.jsonl");
  writeFileSync(calls, "");
  const def = fx.definition();
  (def.merge as Record<string, unknown>).checks = [{ id: "integration", label: "Integration", run: ["node", "lt.mjs", "--integration", "--landing"], rerun: true, timeout: 60 }];
  if (o.withTest) def.test = { run: ["node", "lt.mjs"], timeout: 60, smoke: ["tests/every.txt"] };
  fx.commitIn(fx.project, { "lt.mjs": LANDING_RUNNER(calls), ".sova/project.json": JSON.stringify(def), ...(o.newRunner ? { "runner.reports-ran": "1\n" } : {}) }, "landing runner");
  const ltCalls = () => readFileSync(calls, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as { argv: string[] });
  return { fx, ltCalls };
}

describe("whose failure, never on a guess (a file the target's rerun never ran)", () => {
  test("the target's rerun ran only the everyday file (its group file filtered out): unattributed, never the branch's", async () => {
    const { fx } = landingProject({ newRunner: true, files: { "tests/every.txt": "fail\n", "tests/group-slow.txt": "pass\n" } });
    const r = await run(fx, fx.branch("both", { "tests/group-slow.txt": "fail\n" }));
    expect(r.out.verdict).toBe("unattributed");
    expect(r.out.blame).toBeUndefined();
    expect(r.out.unclear?.[0]?.check).toBe("integration");
    expect(r.out.unclear?.[0]?.why).toContain("tests/group-slow.txt");
  });

  test("the target carries the old runner (no ranFiles) and the tip fails a group file: unattributed, not the branch's", async () => {
    const { fx } = landingProject({ newRunner: false, files: { "tests/every.txt": "pass\n", "tests/group-slow.txt": "pass\n" } });
    const r = await run(fx, fx.branch("group", { "tests/group-slow.txt": "fail\n", "runner.reports-ran": "1\n" }));
    expect(r.out.verdict).toBe("unattributed");
    expect(r.out.blame).toBeUndefined();
    expect(r.out.unclear?.[0]?.check).toBe("integration");
  });

  test("a check that is the project's test command with selection flags reruns exactly the failed files with the test command alone", async () => {
    const { fx, ltCalls } = landingProject({ newRunner: false, withTest: true, files: { "tests/every.txt": "pass\n", "tests/group-slow.txt": "pass\n" } });
    const r = await run(fx, fx.branch("group-run", { "tests/group-slow.txt": "fail\n" }));
    // The target alone runs the group file (no landing filter), it passes there: the branch's.
    expect(r.out).toMatchObject({ verdict: "failed", blame: "branch" });
    expect(r.out.why).toContain("tests/group-slow.txt");
    expect(ltCalls().map((c) => c.argv)).toEqual([["--integration", "--landing"], ["tests/group-slow.txt"], ["tests/group-slow.txt"]]);
  });

  test("the rerun on the merge runs none of the failed files (filtered out): not flaky, on to the target alone; with ranFiles or by counts", async () => {
    for (const newRunner of [true, false]) {
      const { fx, ltCalls } = landingProject({ newRunner, files: { "tests/every.txt": "pass\n", "tests/group-slow.txt": "pass\n", "runner.named-filtered": "1\n" } });
      const r = await run(fx, fx.branch(`tip-filter-${newRunner}`, { "tests/group-slow.txt": "fail\n" }));
      // Never "flaky" on a rerun that never ran it: the target's rerun is asked too, and can't tell either.
      expect(r.out.notes.some((x) => x.kind === "flaky")).toBe(false);
      expect(r.out.verdict).toBe("unattributed");
      expect(r.out.unclear?.[0]?.check).toBe("integration");
      expect(r.steps.get("rerun-tip:integration")!.result).toBe("failed");
      expect(ltCalls().length).toBe(3);
    }
  });
});
