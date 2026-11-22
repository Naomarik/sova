// One merge run, alone, on real throwaway repositories: a clean run empties the copy, and a failure is rerun only as
// widely as the check can narrow it (by test name, else by file, else the whole check only when nothing was named).
import { after, describe, test } from "node:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect } from "./testing/expect";
import type { MergeEntry, RunStep } from "../../shared/merge-queue";
import { parseDefinition } from "../../shared/project-contract";
import type { RunInput, RunOutcome } from "./contract";
import { mergeCopyPath } from "./copy";
import { Fixture, REPO_ROOT } from "./testing/repo";
import { makeRunMerge } from "./run";
import { planChecks } from "./checks";

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
async function run(fx: Fixture, br: { branch: string; commit: string }, o: { clean?: RunInput["clean"]; planned?: (def: RunInput["project"]["def"]) => RunInput["planned"] } = {}) {
  const runId = `mr_k${++n}`;
  const runDir = join(fx.root, "runs", runId);
  mkdirSync(runDir, { recursive: true });
  const base = fx.head();
  const def = parseDefinition(fx.fileAt(base, ".sova/project.json")!);
  const entry = { id: `me_${n}`, project: "p1", target: fx.target, branch: br.branch, commit: br.commit, approval: { by: "land-button", at: new Date().toISOString(), commit: br.commit }, state: "checking", runs: [runId], picks: [], notes: [], createdAt: "", updatedAt: "" } as MergeEntry;
  const steps = new Map<string, RunStep>();
  const input: RunInput = { runId, entry, project: { id: "p1", root: fx.project, target: fx.target, def }, base, commit: br.commit, runDir, picks: [], review: false, signal: new AbortController().signal, awaitReview: () => new Promise(() => {}), ...(o.clean ? { clean: o.clean } : {}), ...(o.planned ? { planned: o.planned(def) } : {}) };
  let ranWith: Record<string, unknown> = {};
  const notes: string[] = [];
  const out: RunOutcome = await makeRunMerge({ specCore: join(REPO_ROOT, "pi-config/extensions/spec/core") })(input, { step: (s) => void steps.set(s.id, s), checks: () => {}, ranWith: (p) => void (ranWith = { ...ranWith, ...p }), event: (ev) => void notes.push(`${(ev as { note?: string }).note ?? ev.kind}: ${ev.why}`) });
  return { out, steps, ranWith, notes };
}

const unitCalls = (fx: Fixture, mark: number) => fx.callsSince(mark).filter((c) => c.script === "unit");

describe("a clean run", () => {
  test("empties the copy of ignored files, runs setup from nothing and every check fresh; a later run reuses again", async () => {
    const fx = fixture();
    // The first run cuts the copy new: nothing to reuse, said so.
    const first = await run(fx, fx.branch("one", { "src/app.txt": "1\n" }));
    expect(first.out).toMatchObject({ verdict: "passed", clean: "new" });
    expect(first.ranWith).toMatchObject({ copy: "fresh", clean: "new" });
    const copy = mergeCopyPath(fx.project);
    mkdirSync(join(copy, "node_modules", "pkg"), { recursive: true });
    writeFileSync(join(copy, "node_modules", "pkg", "index.js"), "stale\n");
    // Reused: the ignored files stay, setup is skipped as unchanged, checks may reuse passes.
    const mark = fx.calls().length;
    const reused = await run(fx, fx.branch("two", { "src/app.txt": "2\n" }));
    expect(reused.out.clean).toBeUndefined();
    expect(reused.ranWith.copy).toBe("reused");
    expect(reused.ranWith.clean).toBeUndefined();
    expect(existsSync(join(copy, "node_modules", "pkg", "index.js"))).toBe(true);
    expect(reused.steps.get("setup:prep")!.result).toBe("skipped");
    expect(unitCalls(fx, mark)[0]!.env.SOVA_FRESH).toBeUndefined();
    // Clean: every ignored file gone before setup, setup runs, every check fresh, the outcome says why.
    const mark2 = fx.calls().length;
    const clean = await run(fx, fx.branch("three", { "src/app.txt": "3\n" }), { clean: "operator" });
    expect(clean.out).toMatchObject({ verdict: "passed", clean: "operator" });
    expect(clean.ranWith).toMatchObject({ copy: "fresh", clean: "operator" });
    expect(existsSync(join(copy, "node_modules"))).toBe(false);
    expect(clean.steps.get("copy")!.detail).toContain("clean: nothing reused");
    expect(clean.steps.get("setup:prep")!.result).toBe("passed");
    expect(unitCalls(fx, mark2).every((c) => c.env.SOVA_FRESH === "1")).toBe(true);
    const after = await run(fx, fx.branch("four", { "src/app.txt": "4\n" }));
    expect(after.out.clean).toBeUndefined();
    expect(after.steps.get("setup:prep")!.result).toBe("skipped");
  });
});

describe("the plan and the run's own reading", () => {
  test("a plan that couldn't read the folder rules runs with what the copy's rules set off too, never the required checks only", async () => {
    const lint = { id: "lint", label: "Lint", run: ["node", "checks/build.mjs"], optional: true };
    const fx = fixture({ moreChecks: [lint], merge: { rules: [{ paths: ["src/**"], check: "lint", why: "src changed" }] } });
    // The plan as worked out when the merged read failed: no triggers, the required checks only.
    const r = await run(fx, fx.branch("ruled", { "src/app.txt": "1\n" }), { planned: (def) => planChecks(def, [], [], []) });
    expect(r.out.verdict).toBe("passed");
    expect(r.out.checks?.map((c) => c.id)).toEqual(["build", "unit", "lint"]);
    expect(r.steps.get("check:lint")?.result).toBe("passed");
    expect(r.notes.find((n) => n.startsWith("plan-differs"))).toMatch(/The plan's run, and the copy's lint with them\./);
  });
});

describe("narrow reruns", () => {
  test("a check that reruns by name reruns only the failing test, and the flaky test is named with its file", async () => {
    const fx = fixture({ unit: { rerun: false, rerunTest: ["--name", "${test}"] } });
    const mark = fx.calls().length;
    const r = await run(fx, fx.branch("flaky-name", { "tests/a.txt": "flaky\n" }));
    expect(r.out.verdict).toBe("passed");
    const calls = unitCalls(fx, mark);
    expect(calls.map((c) => c.argv)).toEqual([[], ["--name", "a.txt"]]);
    expect(r.steps.get("rerun-tip:unit")).toMatchObject({ result: "passed", label: "Unit tests again (1 test)" });
    expect(r.out.flaky).toEqual([{ check: "unit", label: "Unit tests", name: "a.txt", file: "tests/a.txt" }]);
  });

  test("a rerun by name counts a test flaky only when its report shows that test ran and passed: a runner taking only the last name filter never lands the other", async () => {
    // A runner that keeps only the last of its name filters.
    const fx = fixture({ unit: { rerun: false, rerunTest: ["--name", "${test}"] }, files: { "unit.last-name": "1\n" } });
    const r = await run(fx, fx.branch("two-red", { "tests/a.txt": "fail\n", "tests/b.txt": "flaky\n" }));
    expect(r.steps.get("rerun-tip:unit")).toMatchObject({ result: "failed", detail: "1 still failing (1 not shown run by the rerun), 1 passed" });
    expect(r.out.flaky).toEqual([{ check: "unit", label: "Unit tests", name: "b.txt", file: "tests/b.txt" }]);
    expect(r.out.verdict).toBe("failed");
    expect(r.out.blame).toBe("branch");
  });

  test("a check that reruns by file reruns only the failing file; the flaky test is its file", async () => {
    const fx = fixture();
    const mark = fx.calls().length;
    const r = await run(fx, fx.branch("flaky-file", { "tests/a.txt": "flaky\n" }));
    expect(r.out.verdict).toBe("passed");
    expect(unitCalls(fx, mark).map((c) => c.argv)).toEqual([[], ["tests/a.txt"]]);
    expect(r.out.flaky).toEqual([{ check: "unit", label: "Unit tests", file: "tests/a.txt" }]);
  });

  test("a check that names its failures but can't rerun just them is never rerun whole on the merge: on to the target alone", async () => {
    const fx = fixture({ unit: { rerun: false } });
    const mark = fx.calls().length;
    const r = await run(fx, fx.branch("breaks", { "tests/a.txt": "fail\n" }));
    expect(r.steps.get("rerun-tip:unit")).toMatchObject({ result: "skipped", detail: "can't rerun only the failing tests: not rerun" });
    // The merge's run, then the target alone (attribution): no second run on the merge.
    const calls = unitCalls(fx, mark);
    expect(calls.length).toBe(2);
    expect(calls[1]!.head).toBe(fx.head());
    expect(r.out).toMatchObject({ verdict: "failed", blame: "branch" });
    expect(r.out.flaky).toBeUndefined();
    // The same flaky test with no way to narrow it: not rerun, so never counted as flaky; it fails the branch.
    const fx2 = fixture({ unit: { rerun: false } });
    const r2 = await run(fx2, fx2.branch("flaky", { "tests/a.txt": "flaky\n" }));
    expect(r2.out.flaky).toBeUndefined();
  });

  test("a whole check that names nothing is rerun whole: a pass there is flaky, named by its check", async () => {
    const fx = fixture();
    const r = await run(fx, fx.branch("blip", { "build.conf": "broken-once\n" }));
    expect(r.steps.get("rerun-tip:build")).toMatchObject({ result: "passed", label: "Build again" });
    expect(r.out).toMatchObject({ verdict: "passed", flaky: [{ check: "build", label: "Build" }] });
  });
});
