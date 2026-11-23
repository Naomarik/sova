import { describe, test } from "node:test";
import { expect } from "./testing/expect";
import { mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseDefinition } from "../../shared/project-contract";
import { scratchRoot } from "../test-scratch";
import { type CopyScope, planChecks, runCheck } from "./checks";

describe("a check in a folder of its own, with its own variables and report", () => {
  const svcs = { web: { cmd: ["node", "web.js"], ports: { http: { base: 5100 } } } };
  /** A copy with pkg/ holding a runner script. */
  function copyWith(script: string): { copy: string; scope: CopyScope } {
    const copy = scratchRoot("mq-cwd-");
    mkdirSync(join(copy, "pkg", "test"), { recursive: true });
    writeFileSync(join(copy, "pkg", "run.mjs"), script);
    writeFileSync(join(copy, "pkg", "test", "a_test.py"), "");
    const data = join(copy, ".data");
    mkdirSync(data, { recursive: true });
    return { copy, scope: { project: copy, projectId: "p", copy, slot: 20, data, target: "main", base: "b".repeat(40), tip: "c".repeat(40) } };
  }
  const plan = (check: Record<string, unknown>) => {
    const d = parseDefinition(JSON.stringify({ version: 1, services: svcs, merge: { checks: [{ id: "unit", run: ["node", "run.mjs"], rerun: true, ...check }] } }));
    return { d, c: planChecks(d)[0]! };
  };

  test("runs in its folder with its env rendered; a JUnit report names failing files from the root; a rerun gets them back from its folder", async () => {
    const { copy, scope } = copyWith(`
import { writeFileSync, mkdirSync } from "node:fs";
console.log("cwd=" + process.cwd() + " MODE=" + process.env.MODE + " ARGS=" + process.argv.slice(2).join(","));
mkdirSync("reports", { recursive: true });
writeFileSync("reports/junit.xml", '<testsuite><testcase classname="test.a_test" name="test_one"><failure message="nope"/></testcase><testcase classname="test.a_test" name="test_two"/></testsuite>');
process.exit(1);
`);
    const { d, c } = plan({ cwd: "pkg", env: { MODE: "slot-${slot}" }, report: { junit: "reports" }, rerunTest: ["-k", "${test}"] });
    expect(c.cwd).toBe("pkg");
    const r = await runCheck({ def: d, scope, check: c, stepId: "unit", logFile: join(copy, ".data", "unit.log"), fresh: true });
    expect(r.proc.code, r.proc.out).toBe(1);
    expect(r.proc.out).toMatch(`cwd=${join(copy, "pkg")} MODE=slot-20 ARGS=`);
    expect(r.failingFiles).toEqual(["pkg/test/a_test.py"]);
    expect(r.report).toMatchObject({ passed: 1, failed: 1, failingNames: ["test.a_test.test_one"], failingTests: [{ test: "test_one", file: "pkg/test/a_test.py" }], ranFiles: ["pkg/test/a_test.py"] });
    const again = await runCheck({ def: d, scope, check: c, stepId: "unit", logFile: join(copy, ".data", "unit2.log"), files: r.failingFiles, tests: ["test_one"], fresh: true });
    expect(again.proc.out).toMatch("ARGS=-k,test_one,test/a_test.py");
  });

  test("a report written by an earlier run never counts; TAP on its output is read when it says so; a missing folder fails saying so", async () => {
    const { copy, scope } = copyWith(`console.log("TAP version 13\\nnot ok 1 - test/a.test.mjs\\n1..1"); process.exit(1);`);
    mkdirSync(join(copy, "pkg", "reports"), { recursive: true });
    writeFileSync(join(copy, "pkg", "reports", "old.xml"), '<testsuite><testcase name="stale"><failure/></testcase></testsuite>');
    const past = new Date(Date.now() - 120_000);
    utimesSync(join(copy, "pkg", "reports", "old.xml"), past, past);
    const { d, c } = plan({ cwd: "pkg", report: { junit: "reports" } });
    const r = await runCheck({ def: d, scope, check: c, stepId: "unit", logFile: join(copy, ".data", "u.log"), fresh: true });
    expect(r.report).toMatchObject({ failed: 1, failingFiles: ["pkg/test/a.test.mjs"] });
    expect(r.report!.failingNames).not.toContain("stale");
    const gone = plan({ cwd: "nowhere" });
    const m = await runCheck({ def: gone.d, scope, check: gone.c, stepId: "unit", logFile: join(copy, ".data", "m.log"), fresh: true });
    expect(m.proc.code).toBe(127);
    expect(m.proc.out).toMatch("folder nowhere/ isn't in the merged tree");
  });

});
