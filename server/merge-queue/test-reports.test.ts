import { describe, test } from "node:test";
import { expect } from "./testing/expect";
import { mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { scratchRoot } from "../test-scratch";
import { looksLikeTap, moduleFileOf, parseJUnit, parseTap, readDeclaredReport, reportOfCases, rootPathOf } from "./test-reports";

// pytest --junitxml (xunit2: no file attribute, the module in classname).
const PYTEST = `<?xml version="1.0" encoding="utf-8"?>
<testsuites><testsuite name="pytest" errors="0" failures="1" skipped="1" tests="4">
<testcase classname="tests.test_math" name="test_add" time="0.001" />
<testcase classname="tests.test_math" name="test_sub" time="0.001"><failure message="assert 1 == 2">def test_sub():
&gt;       assert 1 == 2</failure></testcase>
<testcase classname="tests.test_math" name="test_skip"><skipped type="pytest.skip" message="later" /></testcase>
<testcase classname="tests.test_io" name="test_err"><error message="ImportError: no module">trace</error></testcase>
</testsuite></testsuites>`;

// Surefire/Jest style: a file on the suite, a CDATA body, a comment, entities in names.
const SUITE_FILE = `<testsuites>
<!-- <testcase name="commented out"><failure/></testcase> -->
<testsuite name="math" file="src/math.test.js">
  <testcase name="adds &amp; carries" classname="math"><failure><![CDATA[expected 3 <got> 4]]></failure></testcase>
  <testcase name="subtracts" classname="math" file="src/sub.test.js"/>
</testsuite>
</testsuites>`;

describe("JUnit XML", () => {
  test("each case's status, its message, its file from itself or its suite; comments ignored", () => {
    expect(parseJUnit(PYTEST)).toEqual([
      { name: "test_add", classname: "tests.test_math", status: "passed" },
      { name: "test_sub", classname: "tests.test_math", status: "failed", message: "assert 1 == 2" },
      { name: "test_skip", classname: "tests.test_math", status: "skipped" },
      { name: "test_err", classname: "tests.test_io", status: "failed", message: "ImportError: no module" },
    ]);
    expect(parseJUnit(SUITE_FILE)).toEqual([
      { name: "adds & carries", classname: "math", file: "src/math.test.js", status: "failed", message: "expected 3 <got> 4" },
      { name: "subtracts", classname: "math", file: "src/sub.test.js", status: "passed" },
    ]);
  });

  test("not XML at all, or no case: nothing", () => {
    expect(parseJUnit("")).toEqual([]);
    expect(parseJUnit("hello <world>")).toEqual([]);
    expect(parseJUnit("<testsuite name='x' tests='0'/>")).toEqual([]);
  });
});

const NODE_TAP = `TAP version 13
# Subtest: test/a.test.mjs
    # Subtest: adds
    ok 1 - adds
      ---
      duration_ms: 0.4
      ...
    # Subtest: subtracts
    not ok 2 - subtracts
      ---
      duration_ms: 0.5
      location: '/w/copy/pkg/test/a.test.mjs:5:1'
      failureType: 'testCodeFailure'
      error: 'Expected values to be strictly equal'
      ...
    1..2
not ok 1 - test/a.test.mjs
  ---
  duration_ms: 3
  ...
ok 2 - test/b.test.mjs # SKIP not here
not ok 3 - flaky thing # TODO someday
1..3
`;

describe("TAP", () => {
  test("leaves stand for their parent, a file-named parent gives its leaves their file, YAML location and error read, SKIP and TODO", () => {
    expect(parseTap(NODE_TAP)).toEqual([
      { name: "adds", status: "passed", file: "test/a.test.mjs" },
      { name: "subtracts", status: "failed", file: "/w/copy/pkg/test/a.test.mjs", message: "Expected values to be strictly equal" },
      { name: "test/b.test.mjs", status: "skipped", file: "test/b.test.mjs" },
      { name: "flaky thing", status: "passed" },
    ]);
  });

  test("plain TAP 12 with Bail out!", () => {
    expect(parseTap("1..2\nok 1 first\nnot ok 2 - second\nBail out! db gone\n")).toEqual([
      { name: "first", status: "passed" },
      { name: "second", status: "failed", message: "not ok: second" },
      { name: "db gone", status: "failed", message: "Bail out! db gone" },
    ]);
  });

  test("reads as TAP only with a version line, or a plan and a point", () => {
    expect(looksLikeTap("TAP version 14\n")).toBe(true);
    expect(looksLikeTap("1..1\nok 1 - x\n")).toBe(true);
    expect(looksLikeTap("ok, done\n")).toBe(false);
    expect(looksLikeTap("not ok 1 - x\n")).toBe(false);
  });
});

describe("into the queue's report", () => {
  test("files become repository paths under the check's folder; outside the copy dropped", () => {
    expect(rootPathOf("test/a.py", "pkg", "/c")).toBe("pkg/test/a.py");
    expect(rootPathOf("./test/a.py", ".", "/c")).toBe("test/a.py");
    expect(rootPathOf("/c/pkg/x.js", "pkg", "/c")).toBe("pkg/x.js");
    expect(rootPathOf("file:///c/pkg/x.js", "pkg", "/c")).toBe("pkg/x.js");
    expect(rootPathOf("/usr/lib/node/x.js", "pkg", "/c")).toBe(null);
    expect(rootPathOf("../shared/x.js", "pkg", "/c")).toBe("shared/x.js");
    expect(rootPathOf("../../x.js", "pkg", "/c")).toBe(null);
  });

  test("pytest's module classname finds its file when it exists; counts, failing names and files", () => {
    const copy = scratchRoot("mq-reports-");
    mkdirSync(join(copy, "py", "tests"), { recursive: true });
    writeFileSync(join(copy, "py", "tests", "test_math.py"), "");
    expect(moduleFileOf("tests.test_math.TestAdd", join(copy, "py"))).toBe("tests/test_math.py");
    expect(moduleFileOf("tests.nothing", join(copy, "py"))).toBe(null);
    const r = reportOfCases(parseJUnit(PYTEST), { cwd: "py", copy, format: "junit" });
    expect(r).toMatchObject({ passed: 1, failed: 2, skipped: 1, failingFiles: ["py/tests/test_math.py"], failingNames: ["tests.test_math.test_sub", "tests.test_io.test_err"] });
    expect(r.failures[0]).toEqual({ name: "tests.test_math.test_sub", file: "py/tests/test_math.py", message: "assert 1 == 2" });
    // tests.test_io has no file here: not every case names one, so no ranFiles (a rerun's proof stays its counts).
    expect(r.ranFiles).toBeUndefined();
  });

  test("a declared JUnit folder: only reports written since the check started; none = null", () => {
    const copy = scratchRoot("mq-reports-");
    const dir = join(copy, "svc", "target", "reports");
    mkdirSync(join(dir, "nested"), { recursive: true });
    writeFileSync(join(dir, "old.xml"), SUITE_FILE);
    const past = new Date(Date.now() - 60_000);
    utimesSync(join(dir, "old.xml"), past, past);
    const since = Date.now();
    expect(readDeclaredReport({ junit: "target/reports" }, { copy, cwd: "svc", since, output: "" })).toBe(null);
    writeFileSync(join(dir, "nested", "new.xml"), SUITE_FILE);
    const r = readDeclaredReport({ junit: "target/reports" }, { copy, cwd: "svc", since, output: "" })!;
    expect(r).toMatchObject({ passed: 1, failed: 1, failingFiles: ["svc/src/math.test.js"], ranFiles: ["svc/src/math.test.js", "svc/src/sub.test.js"] });
    expect(readDeclaredReport({ junit: "missing.xml" }, { copy, cwd: "svc", since, output: "" })).toBe(null);
  });

  test("TAP on the check's own output", () => {
    const copy = scratchRoot("mq-reports-");
    const r = readDeclaredReport({ tap: "stdout" }, { copy: "/w/copy", cwd: "pkg", since: 0, output: NODE_TAP })!;
    void copy;
    expect(r).toMatchObject({ passed: 2, failed: 1, skipped: 1, failingFiles: ["pkg/test/a.test.mjs"], failingNames: ["subtracts"] });
    expect(readDeclaredReport({ tap: "stdout" }, { copy: "/w/copy", cwd: ".", since: 0, output: "no tests here\n" })).toBe(null);
  });
});
