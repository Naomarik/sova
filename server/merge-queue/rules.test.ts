import { describe, test } from "node:test";
import { expect } from "./testing/expect";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DefinitionError, parseDefinition, type MergeRuleDecl, type ProjectDef } from "../../shared/project-contract";
import { scratchRoot } from "../test-scratch";
import { planChecks } from "./checks";
import { globRe, planRulesFor, ruleTriggers, rulesChange, rulesFromText, withUnknown } from "./rules";

const REPO = join(import.meta.dirname, "..", "..");
const CHECKS = [
  { id: "unit", run: ["node", "t.mjs"] },
  { id: "replay", label: "Spec replay", run: ["node", "replay.mjs"] },
  { id: "e2e", label: "Walkthroughs", run: ["node", "e2e.mjs"], optional: true },
  { id: "group", label: "Slow group", run: ["node", "g.mjs"], optional: true, perSelector: true },
  { id: "tour", label: "Tours", run: ["node", "tours.mjs"], optional: true, needsSelect: true },
];
const text = (rules: unknown, checks: unknown = CHECKS) => JSON.stringify({ version: 1, merge: { checks, rules } }, null, 2);
const def = (rules: unknown, checks: unknown = CHECKS): ProjectDef => parseDefinition(text(rules, checks));
const refusal = (rules: unknown, checks?: unknown): { path: string; message: string } => {
  try {
    def(rules, checks);
  } catch (err) {
    if (err instanceof DefinitionError) return { path: err.path, message: err.message };
    throw err;
  }
  throw new Error("not refused");
};

describe("folder rules in the merge section", () => {
  test("a rule names a declared check, its paths, its reason and maybe a selection", () => {
    const d = def([{ paths: ["src/**"], check: "e2e", select: ["a.mjs"], why: " the UI changed " }]);
    expect(d.merge!.rules).toEqual([{ paths: ["src/**"], check: "e2e", select: ["a.mjs"], why: "the UI changed" }]);
    expect((d.merge!.checks as { id: string; perSelector?: true }[]).find((c) => c.id === "group")!.perSelector).toBe(true);
  });

  test("each malformed rule is refused, naming the rule", () => {
    const cases: [unknown, string, RegExp][] = [
      [[{ paths: ["a/**"], check: "nope", why: "x" }], "$.merge.rules[0].check", /names no merge check "nope"/],
      [[{ paths: ["a/**"], check: "tour", why: "x" }], "$.merge.rules[0].select", /runs with a selection/],
      [[{ paths: ["a/**"], check: "e2e", select: ["--all"], why: "x" }], "$.merge.rules[0].select[0]", /never starts with -/],
      [[{ paths: [], check: "e2e", why: "x" }], "$.merge.rules[0].paths", /non-empty/],
      [[{ paths: ["../x"], check: "e2e", why: "x" }], "$.merge.rules[0].paths[0]", /inside the repository/],
      [[{ paths: ["/abs"], check: "e2e", why: "x" }], "$.merge.rules[0].paths[0]", /relative/],
      [[{ paths: ["a"], check: "e2e" }], "$.merge.rules[0].why", /say why/],
      [[{ paths: ["a"], check: "e2e", why: "x", extra: 1 }], "$.merge.rules[0].extra", /unknown key/],
      ["nope", "$.merge.rules", /must be a list/],
      [Array.from({ length: 101 }, () => ({ paths: ["a"], check: "e2e", why: "x" })), "$.merge.rules", /at most 100/],
    ];
    for (const [rules, path, msg] of cases) {
      const r = refusal(rules);
      expect(r.path).toBe(path);
      expect(r.message).toMatch(msg);
    }
    expect(refusal([{ paths: ["a"], check: "unit", why: "x" }], "none").message).toMatch(/declare merge.checks as a list/);
    expect(refusal([], [{ id: "unit", run: ["t"], perSelector: "yes" }]).path).toBe("$.merge.checks[0].perSelector");
  });
});

describe("Sova's own rules (.sova/project.json)", () => {
  const own = parseDefinition(readFileSync(join(REPO, ".sova", "project.json"), "utf8"));
  const rules = own.merge!.rules!;
  const checks = own.merge!.checks as { id: string; label: string; perSelector?: true }[];
  const hit = (paths: string[]) => ruleTriggers(rules, paths, checks).picks;
  const by = (paths: string[]) => Object.fromEntries(hit(paths).map((p) => [p.id, p]));

  test("its definition carries the rules (no separate map); the slow group takes one selection per run", () => {
    expect(rules.length).toBe(10);
    expect(checks.find((c) => c.id === "integration-group")!.perSelector).toBe(true);
  });

  test("each area sets off its check with its reason; docs alone set off nothing", () => {
    expect(hit(["docs/a.md", "README.md", ".sova/spec/drafts/x/spec/a.md"])).toEqual([]);
    const charts = by(["statecharts/src/org.cljs"]);
    expect(Object.keys(charts)).toEqual(["statecharts"]);
    expect(charts.statecharts!.why).toMatch(/^statecharts changed.*\(statecharts\/src\/org\.cljs\)$/);
    expect(Object.keys(by(["pi-config/extensions/spec/core/sova-spec.mjs"]))).toEqual(["spec-replay"]);
    const composer = by(["src/components/Composer.tsx"]);
    expect(composer.e2e?.select).toEqual(["scripts/e2e/focus-view.mjs", "scripts/e2e/instant-open.mjs", "scripts/e2e/type-anywhere.mjs"]);
    expect(composer.e2e!.why).toMatch(/composer changed/);
    expect(by(["src/commands/keys.ts"]).e2e?.select).toEqual(["scripts/e2e/type-anywhere.mjs"]);
    expect(by(["server/tours/browser.ts"])["integration-group"]?.select).toEqual(["tours"]);
    expect(by(["server/chat-runtime/host.ts"])["integration-group"]?.select).toEqual(["trial"]);
    expect(by(["server/chat-hostess/x.ts"])["integration-group"]).toBe(undefined);
  });

  test("several rules on one check are one run; the slow group runs once per group", () => {
    const e2e = hit(["src/components/Composer.tsx", "src/components/TranscriptView.tsx", "src/lib/focus-view.ts"]);
    expect(e2e.map((p) => [p.id, p.select])).toEqual([["e2e", ["scripts/e2e/focus-view.mjs", "scripts/e2e/instant-open.mjs", "scripts/e2e/type-anywhere.mjs", "scripts/e2e/transcript-follow.mjs", "scripts/e2e/transcript-drift.mjs", "scripts/e2e/jump-settle.mjs"]]]);
    expect(e2e[0]!.why).toMatch(/composer changed.*; the transcript view changed/);
    const groups = hit(["server/tours/browser.ts", "server/chat-runtime/host.ts", "server/tours/checks.ts"]);
    expect(groups.map((x) => [x.id, x.select])).toEqual([["integration-group", ["tours"]], ["integration-group", ["trial"]]]);
    expect(groups[0]!.why).toMatch(/\(server\/tours\/browser\.ts, server\/tours\/checks\.ts\)$/);
  });

  test("its rules name only walkthroughs and slow groups that exist", () => {
    for (const r of rules) if (r.check === "e2e") for (const s of r.select ?? []) expect(existsSync(join(REPO, s))).toBe(true);
    const groups = readFileSync(join(REPO, "scripts", "test-groups.mjs"), "utf8");
    for (const r of rules) if (r.check === "integration-group") for (const g of r.select ?? []) if (g !== "merge-queue") expect(groups).toMatch(new RegExp(`name: "${g}"`));
  });
});

describe("matching", () => {
  test("globs: ** any depth (none too), * within a folder, ? one character, the rest literal", () => {
    const m = (g: string, p: string) => globRe(g).test(p);
    expect(m("src/**", "src/a/b.ts")).toBe(true);
    expect(m("src/**/x.ts", "src/x.ts")).toBe(true);
    expect(m("src/*.ts", "src/a/b.ts")).toBe(false);
    expect(m("src/*.ts", "src/b.ts")).toBe(true);
    expect(m("a?.md", "ab.md")).toBe(true);
    expect(m("a?.md", "a/.md")).toBe(false);
    expect(m("a.b", "aXb")).toBe(false);
    expect(m(".sova/project.json", ".sova/project.json")).toBe(true);
  });

  const decls = CHECKS.map((c) => ({ id: c.id, label: c.label ?? c.id, ...(c.perSelector ? { perSelector: true as const } : {}), ...(c.needsSelect ? { needsSelect: true as const } : {}) }));
  const R = (paths: string[], check: string, why: string, select?: string[]): MergeRuleDecl => ({ paths, check, why, ...(select ? { select } : {}) });

  test("rules hitting one check join reasons and selections; a bare rule runs it whole", () => {
    const rules = [R(["a/**"], "e2e", "A", ["x"]), R(["b/**"], "e2e", "B", ["y", "x"])];
    const t = ruleTriggers(rules, ["a/1", "b/2"], decls);
    expect(t.picks).toEqual([{ id: "e2e", label: "Walkthroughs", source: "trigger", why: "A (a/1); B (b/2)", select: ["x", "y"] }]);
    const whole = ruleTriggers([...rules, R(["c/**"], "e2e", "C")], ["a/1", "c/3"], decls);
    expect(whole.picks.map((p) => [p.id, p.select])).toEqual([["e2e", undefined]]);
    // Order doesn't matter: a bare rule first stays bare.
    expect(ruleTriggers([R(["c/**"], "e2e", "C"), ...rules], ["a/1", "c/3"], decls).picks[0]!.select).toBe(undefined);
  });

  test("a perSelector check runs once per selection; a rule for an undeclared check sets nothing off", () => {
    const t = ruleTriggers([R(["a/**"], "group", "A", ["tours"]), R(["b/**"], "group", "B", ["trial"]), R(["c/**"], "group", "C", ["tours"]), R(["a/**"], "ghost", "G")], ["a/1", "b/1", "c/1"], decls);
    expect(t.picks.map((p) => [p.select, p.why])).toEqual([
      [["tours"], "A (a/1); C (c/1)"],
      [["trial"], "B (b/1)"],
    ]);
    expect(t.unknown.map((u) => u.check)).toEqual(["ghost"]);
  });

  test("the target's check decides needsSelect: a branch rule with no selection for it sets nothing off, and says why", () => {
    // The branch's own copy of `tour` may have dropped needsSelect (its file parses); the target's still says it.
    const t = ruleTriggers([R(["a/**"], "tour", "T"), R(["a/**"], "tour", "T2", ["x"])], ["a/1"], decls);
    expect(t.picks.map((p) => [p.id, p.select])).toEqual([["tour", ["x"]]]);
    expect(t.refused.map((r) => r.why)).toEqual(["T"]);
    expect(withUnknown({ from: "branch", count: 2 }, t, "master").unknown).toEqual(["tour runs with a selection on master and this rule names none (a/** → tour)"]);
  });

  test("a reason lists at most 3 of the matched paths", () => {
    const t = ruleTriggers([R(["a/**"], "e2e", "A")], ["a/1", "a/2", "a/3", "a/4", "a/5"], decls);
    expect(t.picks[0]!.why).toBe("A (a/1, a/2, a/3, +2 more)");
  });
});

describe("planning with triggers", () => {
  const d = def([]);
  test("a trigger of a required check marks it (it runs even if its script would skip); of an optional one adds it", () => {
    const list = planChecks(d, [], [], [
      { id: "replay", label: "Spec replay", source: "trigger", why: "engine changed (x)" },
      { id: "e2e", label: "Walkthroughs", source: "trigger", why: "UI (y)", select: ["a.mjs"] },
    ]);
    expect(list.map((c) => [c.id, c.source, !!c.picked, c.select ?? null])).toEqual([
      ["unit", "required", false, null],
      ["replay", "trigger", true, null],
      ["e2e", "trigger", true, ["a.mjs"]],
    ]);
  });

  test("a pick asking for exactly what a trigger runs adds its reason, not a second run; a different selection is a second run", () => {
    const trig = [{ id: "e2e", label: "Walkthroughs", source: "trigger" as const, why: "UI (y)", select: ["a.mjs"] }];
    const same = planChecks(d, [{ id: "e2e", label: "Walkthroughs", source: "picked", why: "thread: risky", select: ["a.mjs"] }], [], trig);
    expect(same.filter((c) => c.id.startsWith("e2e")).map((c) => [c.id, c.source, c.why])).toEqual([["e2e", "trigger", "UI (y); thread: risky"]]);
    const other = planChecks(d, [{ id: "e2e", label: "Walkthroughs", source: "picked", why: "thread", select: ["b.mjs"] }], [], trig);
    expect(other.filter((c) => c.id.startsWith("e2e")).map((c) => [c.id, c.source])).toEqual([
      ["e2e", "trigger"],
      ["e2e+1", "picked"],
    ]);
  });
});

describe("the branch's own rules", () => {
  const target = def([{ paths: ["a/**"], check: "e2e", why: "A" }]);
  test("what the branch changed in its rules, one line each; the same rules say nothing", () => {
    expect(rulesChange(target.merge!.rules!, target.merge!.rules!)).toEqual([]);
    expect(rulesChange(target.merge!.rules!, [{ paths: ["b/**"], check: "e2e", why: "B" }])).toEqual(["added: b/** → e2e: B", "removed: a/** → e2e: A"]);
  });

  test("a branch definition that doesn't read is refused; no file means no rules", () => {
    expect(rulesFromText("{", target).refused).toBeTruthy();
    const bad = rulesFromText(text([{ paths: ["a"], check: "tour", why: "x" }]), target);
    expect(bad.refused).toMatch(/\$\.merge\.rules\[0\]\.select/);
    const none = rulesFromText(null, target);
    expect([none.rules.length, none.info.changed]).toEqual([0, ["removed: a/** → e2e: A"]]);
    const own = rulesFromText(text([{ paths: ["a/**"], check: "e2e", why: "A" }]), target);
    expect([own.info.from, own.info.count, own.info.changed]).toEqual(["branch", 1, undefined]);
  });

  test("before the run: the rules as they read after the merge, and what the branch's changes set off", async () => {
    const root = scratchRoot("sova-rules-");
    const git = (...a: string[]) => execFileSync("git", ["-C", root, "-c", "user.name=t", "-c", "user.email=t@t", ...a], { encoding: "utf8" }).trim();
    git("init", "-q", "-b", "master");
    mkdirSync(join(root, ".sova"), { recursive: true });
    const write = (rules: unknown) => writeFileSync(join(root, ".sova", "project.json"), `${text(rules)}\n`);
    write([{ paths: ["a/**"], check: "e2e", why: "A" }]);
    git("add", "-A");
    git("commit", "-qm", "base");
    // A branch that leaves the rules alone, while the target adds one: the merged rules are the target's.
    git("checkout", "-qb", "plain");
    mkdirSync(join(root, "a"));
    writeFileSync(join(root, "a", "x.ts"), "x");
    git("add", "-A");
    git("commit", "-qm", "plain");
    git("checkout", "-q", "master");
    write([
      { paths: ["a/**"], check: "e2e", why: "A" },
      { paths: ["a/**"], check: "replay", why: "R" },
    ]);
    git("commit", "-qam", "target rule");
    const tdef = parseDefinition(readFileSync(join(root, ".sova", "project.json"), "utf8"));
    const plain = await planRulesFor({ root, base: git("rev-parse", "master"), commit: git("rev-parse", "plain"), target: "master", targetDef: tdef });
    expect([plain.error, plain.info.from, plain.info.count, plain.info.changed, plain.changed, plain.triggers.map((t) => t.id)]).toEqual([undefined, "branch", 2, undefined, ["a/x.ts"], ["e2e", "replay"]]);
    // A branch that changes its own rules: they apply on its own landing, and the run says what changed.
    git("checkout", "-qb", "own");
    write([{ paths: ["a/**"], check: "e2e", why: "A" }, { paths: ["a/**"], check: "replay", why: "R" }, { paths: [".sova/**"], check: "group", select: ["tours"], why: "G" }]);
    git("commit", "-qam", "own rule");
    const own = await planRulesFor({ root, base: git("rev-parse", "master"), commit: git("rev-parse", "own"), target: "master", targetDef: tdef });
    expect([own.info.changed, own.triggers.map((t) => [t.id, t.select ?? []])]).toEqual([["added: .sova/** → group (tours): G"], [["group", ["tours"]]]]);
    expect(own.hash).not.toBe(plain.hash);
    // A branch that conflicts with the target has no merged rules to read: said plainly, nothing set off.
    git("checkout", "-qb", "clash", "plain");
    write([{ paths: ["z/**"], check: "e2e", why: "Z" }]);
    git("commit", "-qam", "clash");
    const clash = await planRulesFor({ root, base: git("rev-parse", "master"), commit: git("rev-parse", "clash"), target: "master", targetDef: tdef });
    expect([clash.triggers, clash.info.why]).toEqual([[], "couldn't read the branch's rules before the run (the branch conflicts with the target): the run reads them from its merge copy"]);
  });
});
