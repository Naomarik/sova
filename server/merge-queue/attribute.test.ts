import { describe, test } from "node:test";
import { expect } from "./testing/expect";
import { blameCheck, blameFile, blameSetup, brokenOnTarget, summarize, type CheckBlame } from "./attribute";

// These rules read the same as the code, so one example per edge.
describe("whose failure is it", () => {
  test("a failing file: passes on a rerun → flaky; fails on the target too → master; passes there or absent → branch", () => {
    expect(blameFile({ passesOnTip: true })).toBe("flaky");
    expect(blameFile({ passesOnTip: false, onTarget: "fails" })).toBe("master");
    expect(blameFile({ passesOnTip: false, onTarget: "passes" })).toBe("branch");
    expect(blameFile({ passesOnTip: false, onTarget: "absent" })).toBe("branch");
  });

  test("a whole check: the same, without files", () => {
    expect(blameCheck({ passesOnTip: true })).toBe("flaky");
    expect(blameCheck({ passesOnTip: false, onTarget: "fails" })).toBe("master");
    expect(blameCheck({ passesOnTip: false, onTarget: "passes" })).toBe("branch");
  });

  test("setup: fails on the target alone too → machine (never a branch's); passes there → branch", () => {
    expect(blameSetup("fails")).toBe("machine");
    expect(blameSetup("passes")).toBe("branch");
  });

  test("broken on the target: a test check red with the same non-zero exit and no test run on the merge, the tip and the target alone", () => {
    const two = { code: 2, noTest: true };
    expect(brokenOnTarget({ testCheck: true, runs: [two, two, two] })).toBe(true);
    expect(brokenOnTarget({ testCheck: false, runs: [two, two, two] })).toBe(false); // a build or typecheck keeps its own rules
    expect(brokenOnTarget({ testCheck: true, runs: [two, two, { code: 1, noTest: true }] })).toBe(false); // another exit
    expect(brokenOnTarget({ testCheck: true, runs: [two, two, { code: 2, noTest: false }] })).toBe(false); // tests ran on the target
    expect(brokenOnTarget({ testCheck: true, runs: [0, 0, 0].map((code) => ({ code, noTest: true })) })).toBe(false);
    expect(brokenOnTarget({ testCheck: true, runs: [null, null, null].map((code) => ({ code, noTest: true })) })).toBe(false); // killed
    expect(brokenOnTarget({ testCheck: true, runs: [two, two] })).toBe(false); // never without the target's run
  });
});

// One red check of each kind summarize reads, with what the promise says it contributes.
type Kind = { make: (id: string) => CheckBlame; branch?: 1; unclear?: 1; notes: string[]; targetRed?: 1; broken?: 1 };
const f = (id: string, blame: "flaky" | "master" | "branch") => [{ file: `${id}.test.ts`, blame }];
const KINDS: Record<string, Kind> = {
  "file flaky": { make: (id) => ({ id, label: id, files: f(id, "flaky") }), notes: ["flaky"] },
  "file master": { make: (id) => ({ id, label: id, files: f(id, "master") }), notes: ["master-red"] },
  "file branch": { make: (id) => ({ id, label: id, files: f(id, "branch") }), branch: 1, notes: [] },
  "file unrun on target": { make: (id) => ({ id, label: id, unclearFiles: [`${id}.u.ts`], files: f(id, "master") }), unclear: 1, notes: ["master-red"] },
  "whole flaky": { make: (id) => ({ id, label: id, whole: "flaky" }), notes: ["flaky"] },
  "whole master": { make: (id) => ({ id, label: id, whole: "master" }), notes: ["master-red"], targetRed: 1 },
  "whole branch": { make: (id) => ({ id, label: id, whole: "branch" }), branch: 1, notes: [] },
  "whole unattributed": { make: (id) => ({ id, label: id, whole: "unattributed" }), unclear: 1, notes: [], targetRed: 1 },
  "whole broken": { make: (id) => ({ id, label: id, whole: "broken", why: `${id} is broken` }), notes: ["master-red"], targetRed: 1, broken: 1 },
};

/** Anything of the branch's fails the run (the resolution's when the merge was one); else anything whose owner can't
 *  be told waits for the user; else it passes, flaky and the target's red only noted. Returns what it found wrong. */
function summaryLaw(sum: typeof summarize): string[] {
  const names = Object.keys(KINDS);
  const lists = [[], ...names.map((a) => [a]), ...names.flatMap((a) => names.map((b) => [a, b]))];
  const bad: string[] = [];
  for (const resolution of [false, true])
    for (const ns of lists) {
      const ks = ns.map((n) => KINDS[n]!), ids = ks.map((_, i) => `c${i}`), reds = ks.map((k, i) => k.make(ids[i]!));
      const a = sum(reds, { resolution });
      const at = `${ns.join(" + ") || "nothing"}${resolution ? " (resolution)" : ""}`;
      const verdict = ks.some((k) => k.branch) ? "failed" : ks.some((k) => k.unclear) ? "unattributed" : "passed";
      const pick = (p: (k: Kind) => unknown) => JSON.stringify(ks.flatMap((k, i) => (p(k) ? [ids[i]] : [])));
      const why = (u: { why: string }) => verdict === "unattributed" && !a.why?.includes(u.why);
      const fileNoted = reds.flatMap((r) => r.files ?? []).filter((x) => x.blame !== "branch").every((x) => a.notes.some((n) => n.text.includes(x.file)));
      if (a.verdict !== verdict || a.blame !== (verdict === "failed" ? (resolution ? "resolution" : "branch") : undefined)) bad.push(`${at}: ${a.verdict}/${a.blame}`);
      if (JSON.stringify(a.notes.map((n) => n.kind).sort()) !== JSON.stringify(ks.flatMap((k) => k.notes).sort()) || !fileNoted) bad.push(`${at}: notes`);
      if (JSON.stringify(a.targetRed) !== pick((k) => k.targetRed)) bad.push(`${at}: targetRed`);
      if (JSON.stringify(a.broken.map((x) => x.id)) !== pick((k) => k.broken) || a.broken.some((b) => !a.notes.some((n) => n.text === b.why))) bad.push(`${at}: broken`);
      if (JSON.stringify(a.unclear.map((x) => x.id)) !== pick((k) => k.unclear) || a.unclear.some(why)) bad.push(`${at}: unclear`);
    }
  return bad;
}

test("the run's verdict over every pair of red checks, either order: the branch's wins, then can't tell, else passes with notes", () => {
  expect(summaryLaw(summarize)).toEqual([]);
  // Broken the way the promise forbids: a check nobody can be blamed for hides the branch's own failure.
  const unclearFirst: typeof summarize = (reds, o) => {
    const a = summarize(reds, o);
    return a.unclear.length ? { ...a, verdict: "unattributed", blame: undefined } : a;
  };
  expect(summaryLaw(unclearFirst).length > 0).toBe(true);
});

test("the words on the entry's row: the branch's failure, can't tell whose (a whole check, a file the target never ran), the resolution's", () => {
  expect(summarize([{ id: "unit", label: "Unit tests", files: [{ file: "a.test.ts", blame: "branch" }] }], { target: "main" }).why).toBe("Unit tests failed: a.test.ts (passes on main alone)");
  expect(summarize([{ id: "build", label: "Build", whole: "unattributed" }], { target: "main" }).why).toBe("can't tell whose failure: Build fails on main too and names no tests");
  expect(summarize([{ id: "integration", label: "Integration", unclearFiles: ["g.integration.test.ts"] }]).why).toBe("can't tell whose failure: Integration's g.integration.test.ts didn't run on master alone");
  expect(summarize([{ id: "build", label: "Build", whole: "branch" }], { resolution: true }).why).toBe("Build failed (with the conflict resolution; passes on master alone)");
});
