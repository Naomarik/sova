import { describe, test } from "node:test";
import { expect } from "./testing/expect";
import { blameCheck, blameFile, blameSetup, summarize } from "./attribute";

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

  test("flaky and master-red are noted and never block; the target red as a whole is listed for the strip", () => {
    const a = summarize([
      { id: "unit", label: "Unit tests", files: [{ file: "a.test.ts", blame: "flaky" }, { file: "b.test.ts", blame: "master" }] },
      { id: "build", label: "Build", whole: "master" },
    ]);
    expect(a.verdict).toBe("passed");
    expect(a.blame).toBeUndefined();
    expect(a.notes.map((n) => n.kind)).toEqual(["flaky", "master-red", "master-red"]);
    expect(a.notes[0]!.text).toContain("a.test.ts");
    expect(a.notes[1]!.text).toContain("b.test.ts");
    expect(a.targetRed).toEqual(["Build"]);
  });

  test("anything of the branch's fails the run, naming check and files, with the other notes kept", () => {
    const a = summarize([{ id: "unit", label: "Unit tests", files: [{ file: "a.test.ts", blame: "branch" }, { file: "c.test.ts", blame: "flaky" }] }], { target: "main" });
    expect(a).toMatchObject({ verdict: "failed", blame: "branch" });
    expect(a.why).toBe("Unit tests failed: a.test.ts (passes on main alone)");
    expect(a.notes).toHaveLength(1);
  });

  test("with the thread's conflict resolution, the failure is the resolution's, not the branch's", () => {
    const a = summarize([{ id: "build", label: "Build", whole: "branch" }], { resolution: true });
    expect(a.blame).toBe("resolution");
    expect(a.why).toContain("conflict resolution");
  });

  test("nothing red: passed, no notes", () => {
    expect(summarize([])).toEqual({ verdict: "passed", notes: [], targetRed: [] });
  });
});
