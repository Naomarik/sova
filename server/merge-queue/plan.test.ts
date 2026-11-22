import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { RunPlan } from "../../shared/merge-queue";
import type { ProjectDef } from "../../shared/project-contract";
import { canonical, NOT_REACHED_REFUSED, onPath, type PlanFacts, planOf, reuseOf, toolsOf, withLatePicks } from "./plan";
import { ruleTriggers, rulesFromText, rulesRefusal } from "./rules";

const DEF = {
  version: 1,
  setup: [{ id: "deps", run: ["pnpm", "install"], inputs: ["pnpm-lock.yaml"], timeout: 600 }],
  merge: {
    install: { run: ["pnpm", "install", "--offline"], inputs: ["pnpm-lock.yaml"], timeout: 600 },
    review: ".sova/playbook-config/review",
    checks: [
      { id: "unit", label: "Unit tests", run: ["bun", "test"], timeout: 600, rerun: true, requires: [] },
      { id: "e2e", label: "Browser tests", run: ["./scripts/e2e.sh"], timeout: 900, rerun: false, requires: [], optional: true },
      { id: "charts", label: "Statecharts", run: ["node", "x.mjs"], timeout: 60, rerun: false, requires: [], optional: true },
    ],
  },
} as unknown as ProjectDef;

const facts = (over: Partial<PlanFacts> = {}): PlanFacts => ({
  def: DEF,
  target: "main",
  base: "b".repeat(40),
  commit: "c".repeat(40),
  picks: [],
  rules: { hash: "r1", own: false, triggers: [] },
  changed: ["src/a.ts"],
  review: { kit: ".sova/playbook-config/review", hash: "k1" },
  how: "local",
  scan: { run: true },
  push: { will: "run" },
  ...over,
});
const AT = "2026-11-22T10:00:00.000Z";
const step = (p: RunPlan, id: string) => p.steps.find((s) => s.id === id);

describe("a run's plan is a function of its inputs", () => {
  test("the same facts give the same plan, steps and fingerprint, whenever it is worked out", () => {
    const a = planOf(facts(), AT).plan;
    const b = planOf(facts(), "2026-11-23T10:00:00.000Z").plan;
    assert.equal(a.fingerprint, b.fingerprint);
    assert.equal(canonical(a.steps), canonical(b.steps));
    assert.match(a.fingerprint, /^[0-9a-f]{16}$/);
  });

  // Each input the plan depends on, changed alone, gives another fingerprint (and a fact that changes nothing doesn't).
  const changes: [string, Partial<PlanFacts>][] = [
    ["the pinned commit", { commit: "d".repeat(40) }],
    ["the target's head", { base: "e".repeat(40) }],
    ["a conflict resolution", { resolution: "f".repeat(40) }],
    ["the target's setup", { def: { ...DEF, merge: { ...DEF.merge, checks: [...(DEF.merge!.checks as object[]).slice(0, 2)] } } as unknown as ProjectDef }],
    ["the branch's folder rules", { rules: { hash: "r2", own: true, triggers: [] } }],
    ["the review kit", { review: { kit: ".sova/playbook-config/review", hash: "k2" } }],
    ["no review", { review: { hash: null, skip: "landed without review" } }],
    ["the thread's picks", { picks: [{ id: "e2e", label: "Browser tests", source: "picked", why: "ws code" }] }],
    ["a pick's selection", { picks: [{ id: "unit", label: "Unit tests", source: "picked", select: ["a.test.ts"] }] }],
    ["a clean run", { clean: "operator" }],
    ["a release", { release: { id: "rl_1", checks: [] } }],
    ["the changed paths", { changed: ["src/b.ts"] }],
    ["how it lands", { how: "github-pr" }],
    ["no push", { push: { will: "skip", why: "no remote to push to" } }],
    ["the drafts", { drafts: { hash: "d1", names: ["x"] } }],
  ];
  for (const [what, over] of changes)
    test(`changing ${what} alone changes the fingerprint`, () => {
      assert.notEqual(planOf(facts(over), AT).plan.fingerprint, planOf(facts(), AT).plan.fingerprint);
    });
});

describe("what a plan says", () => {
  test("every step with will run, skip or if; optional checks not run each say why; picked and triggered checks say theirs", () => {
    const triggers = [{ id: "charts", label: "Statecharts", source: "trigger" as const, why: "statecharts/** changed" }];
    const picks = [{ id: "e2e", label: "Browser tests", source: "picked" as const, why: "touches the socket code" }];
    const { plan, planned } = planOf(facts({ rules: { hash: "r1", own: false, triggers } }), AT);
    assert.deepEqual(
      plan.steps.map((s) => [s.id, s.will]),
      [
        ["copy", "run"],
        ["merge", "run"],
        ["setup:deps", "if"],
        ["install", "skip"],
        ["docs", "skip"],
        ["check:unit", "run"],
        ["check:charts", "run"],
        ["check:e2e", "skip"],
        ["review", "run"],
        ["scan", "run"],
        ["land", "run"],
        ["main-checkout", "run"],
        ["push", "run"],
      ],
    );
    assert.match(step(plan, "check:e2e")!.why!, /optional: the merge thread didn't pick it, and no folder rule set it off/);
    assert.equal(step(plan, "check:charts")!.why, "Triggered: statecharts/** changed");
    assert.deepEqual(planned.map((c) => c.id), ["unit", "charts"], "the run's list is exactly the plan's checks");
    const withPick = planOf(facts({ picks }), AT).plan;
    assert.equal(step(withPick, "check:e2e")!.will, "run");
    assert.equal(step(withPick, "check:e2e")!.why, "touches the socket code");
  });

  test("the steps left out say why: no review, no scan, no push, no drafts; an install the branch's change needs runs", () => {
    const p = planOf(facts({ review: { hash: null, skip: "landed without review" }, scan: { run: false, why: "no remote to push to" }, push: { will: "skip", why: "no remote to push to" }, changed: ["pnpm-lock.yaml"], withoutSpecs: true }), AT).plan;
    assert.deepEqual(step(p, "review"), { id: "review", kind: "review", label: "Review", will: "skip", why: "landed without review" });
    assert.equal(step(p, "scan")!.why, "no remote to push to");
    assert.equal(step(p, "push")!.will, "skip");
    assert.equal(step(p, "docs")!.why, "landed without its specs");
    assert.deepEqual([step(p, "install")!.will, step(p, "install")!.why], ["run", "pnpm-lock.yaml changed"]);
  });

  test("a project that declares no tests says so as a step; a request landing has no main-folder or push step", () => {
    const none = planOf(facts({ def: { version: 1, merge: { checks: "none" } } as unknown as ProjectDef }), AT).plan;
    assert.equal(step(none, "checks")!.will, "skip");
    const pr = planOf(facts({ how: "github-pr", scan: { run: false, why: "lands by request" } }), AT).plan;
    assert.equal(step(pr, "main-checkout"), undefined);
    assert.equal(step(pr, "push"), undefined);
    assert.equal(step(pr, "land")!.label, "Open the request");
  });
});

describe("a plan whose branch's folder rules are refused", () => {
  // The run fails at the refusal (run.ts, rulesRefusal); the plan says so in its words and never plans the check.
  const branchText = (rules: unknown) => JSON.stringify({ version: 1, merge: { checks: [{ id: "unit", run: ["bun", "test"] }, { id: "e2e", run: ["./e2e.sh"], optional: true }], rules } });
  const planWith = (def: ProjectDef, text: string) => {
    const r = rulesFromText(text, def);
    const t = ruleTriggers(r.rules, ["src/a.ts"], def.merge!.checks as never);
    const refused = rulesRefusal(r, t, "main");
    return planOf(facts({ def, rules: { hash: "r1", own: false, triggers: t.picks, ...(refused ? { refused } : {}) } }), AT).plan;
  };
  for (const optional of [true, false])
    test(`a rule naming ${optional ? "an optional" : "a required"} check the target runs only with a selection, with none: Folder rules refused, that check not planned`, () => {
      const checks = (DEF.merge!.checks as { id: string }[]).map((c) => (c.id === "e2e" ? { ...c, needsSelect: true, ...(optional ? { optional: true } : { optional: undefined }) } : c));
      const def = { ...DEF, merge: { ...DEF.merge, checks } } as unknown as ProjectDef;
      const p = planWith(def, branchText([{ paths: ["src/**"], check: "e2e", why: "the UI changed" }]));
      const why = `your branch's folder rules are refused: src/** → e2e: "e2e" runs with a selection on main and this rule names none`;
      assert.deepEqual(step(p, "rules"), { id: "rules", kind: "check", label: "Folder rules", will: "refused", why });
      assert.deepEqual([step(p, "check:e2e")!.will, step(p, "check:e2e")!.why], ["skip", why]);
      assert.equal(planWith(def, branchText([{ paths: ["src/**"], check: "e2e", select: ["list"], why: "the UI changed" }])).steps.find((s) => s.will === "refused"), undefined, "with a selection nothing is refused");
    });
  test("a branch definition that doesn't read: Folder rules refused with the run's words", () => {
    const p = planWith(DEF, "{ not json");
    assert.equal(step(p, "rules")!.will, "refused");
    assert.match(step(p, "rules")!.why!, /^your branch's \.sova\/project\.json is refused: /);
  });
  test("the run stops at the refusal: every step after Folder rules is skipped, not reached; the steps before it stand", () => {
    // Facts that put every kind of step in the plan: submodules, LFS, setup and install that run, drafts, a pick.
    const busy: Partial<PlanFacts> = { clean: "operator", submodules: true, lfs: true, changed: ["pnpm-lock.yaml"], drafts: { hash: "d1", names: ["x"] }, picks: [{ id: "charts", label: "Statecharts", source: "picked", why: "charts" }] };
    const refusals = [{ why: "your branch's folder rules are refused: src/** → e2e: …", checks: ["e2e"] }, { why: "your branch's .sova/project.json is refused: …", checks: [] }];
    for (const how of ["local", "github-pr"] as const)
      for (const refused of refusals) {
        const plain = planOf(facts({ ...busy, how }), AT).plan.steps;
        const p = planOf(facts({ ...busy, how, rules: { hash: "r1", own: false, triggers: [], refused } }), AT).plan;
        assert.equal(p.fingerprint, planOf(facts({ ...busy, how, rules: { hash: "r1", own: false, triggers: [], refused } }), "2026-11-23T00:00:00.000Z").plan.fingerprint, "the same facts, the same plan");
        const at = p.steps.findIndex((s) => s.id === "rules");
        assert.deepEqual(p.steps.slice(0, at), plain.slice(0, at), "copy, merge, submodules and LFS run before the rules are read");
        const after = p.steps.slice(at + 1);
        const ids = after.map((s) => s.id);
        for (const id of ["setup:deps", "install", "docs", "check:unit", "check:charts", "review", "scan", "land", ...(how === "local" ? ["main-checkout", "push"] : [])]) assert.ok(ids.includes(id), `${id} comes after the rules`);
        assert.deepEqual(after.filter((s) => s.will !== "skip").map((s) => s.id), [], "nothing after the refusal runs");
        for (const s of after) {
          const was = plain.find((x) => x.id === s.id)!;
          if (was.will !== "skip" && !refused.checks.includes(s.id.slice("check:".length))) assert.equal(s.why, NOT_REACHED_REFUSED, s.id);
        }
      }
  });
});

describe("late picks (q9)", () => {
  test("a pick after the start joins the plan with its arrival time; the start's fingerprint stays, the grown one is beside it", () => {
    const { plan } = planOf(facts(), AT);
    const late = { id: "e2e", label: "Browser tests", source: "picked" as const, why: "late", addedAt: "2026-11-22T10:05:00.000Z" };
    const grown = withLatePicks(plan, [{ id: "unit", label: "Unit tests", source: "required" }, late], [late])!;
    assert.equal(grown.fingerprint, plan.fingerprint);
    assert.equal(step(grown, "check:e2e")!.late, late.addedAt);
    assert.equal(step(grown, "check:e2e")!.will, "run");
    assert.notEqual(grown.late!.fingerprint, plan.fingerprint);
    assert.equal(withLatePicks(grown, [late], [late]), null, "nothing new: no change");
    const order = grown.steps.map((s) => s.id);
    assert.ok(order.indexOf("check:e2e") < order.indexOf("review"), "it runs before the review, scan and push steps");
  });
});

describe("what a run ran with", () => {
  test("versions are read only for known tools named bare, never a project's own script", () => {
    const { planned } = planOf(facts(), AT);
    assert.deepEqual(toolsOf(DEF, planned), ["git", "bun", "pnpm"]);
    assert.equal(onPath("sh", "relative/bin:./x"), null, "relative PATH entries are never looked in");
  });

  test("reuse comes from the steps: setup skipped as unchanged, test files whose passes stood", () => {
    assert.deepEqual(
      reuseOf([
        { id: "setup:deps", kind: "setup", label: "", result: "skipped", ms: 0, log: "" },
        { id: "setup:build", kind: "setup", label: "", result: "passed", ms: 0, log: "" },
        { id: "check:unit", kind: "check", label: "", result: "passed", ms: 0, log: "", reused: 12 },
      ]),
      { setup: [{ id: "deps", reused: true }, { id: "build", reused: false }], checksReused: [{ id: "unit", files: 12 }] },
    );
  });
});
