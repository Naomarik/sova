// Run: pnpm test -- scripts/fixed-wait-scan.test.ts. The fixed-wait scan (scripts/fixed-wait-scan.mjs): it lists
// the setTimeout/sleep/delay literals over 2000 ms a change adds to test files, and nothing else.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { scratchRoot } from "../server/test-scratch";
import { addedLines, isTestFile, scan, waitsIn } from "./fixed-wait-scan.mjs";

describe("the waits on one line", () => {
  test("each call form with a literal over 2000 ms, in order; 2000 itself and shorter are not listed", () => {
    assert.deepEqual(waitsIn("  await new Promise((r) => setTimeout(r, 6000));"), [6000]);
    assert.deepEqual(waitsIn("  setTimeout(() => f.release(), 2_500);"), [2500]);
    assert.deepEqual(waitsIn("  await sleep(15000);"), [15000]);
    assert.deepEqual(waitsIn("  await delay(3000, 'x');"), [3000]);
    assert.deepEqual(waitsIn("  await Bun.sleep(4000);"), [4000]);
    assert.deepEqual(waitsIn("  await setTimeout(5000);"), [5000], "timers/promises' setTimeout, read once");
    assert.deepEqual(waitsIn("  setTimeout(r, 1000); setTimeout(r, 3000); await sleep(2001);"), [3000, 2001]);
    assert.deepEqual(waitsIn("  await sleep(2000); setTimeout(r, 500);"), []);
  });
  test("a comment, a non-literal delay and a look-alike name are not waits", () => {
    assert.deepEqual(waitsIn("  // await sleep(9000) was here"), []);
    assert.deepEqual(waitsIn("   * setTimeout(r, 9000) in a doc comment"), []);
    assert.deepEqual(waitsIn("  await sleep(1000); // not sleep(9000)"), []);
    assert.deepEqual(waitsIn("  await sleep(WAIT_MS);"), []);
    assert.deepEqual(waitsIn("  await deepSleep(9000); clearTimeout(t9000);"), []);
    assert.deepEqual(waitsIn(`  log("await sleep(9000)", 'setTimeout(r, 9000)');`), [], "quoted in a string");
    assert.deepEqual(waitsIn(`  await fetch("http://x/y"); await sleep(3000);`), [3000], "a URL's // is no comment");
  });
});

test("a test file, by name", () => {
  for (const f of ["server/a.test.ts", "server/a.integration.test.ts", "src/lib/x.browser.test.ts", "pi-config/x/y.test.mjs"]) assert.ok(isTestFile(f), f);
  for (const f of ["server/a.ts", "server/a.integration.fixture.ts", "scripts/run-tests.mjs", "server/test-scratch.ts"]) assert.ok(!isTestFile(f), f);
});

test("the added lines of a diff, numbered in the new file; removed and context lines are not", () => {
  const diff = [
    "diff --git a/s/a.test.ts b/s/a.test.ts",
    "--- a/s/a.test.ts",
    "+++ b/s/a.test.ts",
    "@@ -3,0 +4,2 @@ x",
    "+one",
    "+two",
    "@@ -10 +12 @@",
    "-gone(9000)",
    "+three",
    "diff --git a/s/old.test.ts b/s/old.test.ts",
    "--- a/s/old.test.ts",
    "+++ /dev/null",
    "@@ -1 +0,0 @@",
    "-await sleep(9000);",
  ].join("\n");
  assert.deepEqual(addedLines(diff), [
    { file: "s/a.test.ts", line: 4, text: "one" },
    { file: "s/a.test.ts", line: 5, text: "two" },
    { file: "s/a.test.ts", line: 12, text: "three" },
  ]);
});

describe("a change in a repository", () => {
  const root = scratchRoot("fixed-wait-");
  after(() => rmSync(root, { recursive: true, force: true }));
  const git = (...a: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", ...a], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  const write = (f: string, text: string) => (mkdirSync(join(root, f, ".."), { recursive: true }), writeFileSync(join(root, f), text));
  git("init", "-q", "-b", "main");
  write("s/kept.test.ts", "await sleep(9000);\nawait sleep(100);\n");
  write("s/code.ts", "await sleep(1);\n");
  git("add", "-A");
  git("commit", "-q", "-m", "base");
  git("checkout", "-q", "-b", "feature");
  // Committed on the branch: one wait added beside the old one (which is not the change's).
  write("s/kept.test.ts", "await sleep(9000);\nawait sleep(100);\nawait new Promise((r) => setTimeout(r, 6_000));\n");
  // Code that isn't a test: never listed.
  write("s/code.ts", "await sleep(1);\nawait sleep(9000);\n");
  git("add", "-A");
  git("commit", "-q", "-m", "branch");
  // A later commit on the base, after the branch left it: not the change's.
  git("checkout", "-q", "main");
  write("s/base-later.test.ts", "await sleep(7000);\n");
  git("add", "-A");
  git("commit", "-q", "-m", "on main");
  git("checkout", "-q", "feature");
  // Uncommitted: an edit to a tracked test, and a new test file git doesn't track yet.
  write("s/kept.test.ts", "await sleep(9000);\nawait sleep(100);\nawait new Promise((r) => setTimeout(r, 6_000));\nawait sleep(2500);\n");
  write("s/new.integration.test.ts", "// sleep(9000)\nawait sleep(1500);\nawait delay(4000);\n");

  test("lists what the change added to test files since the merge base, committed or not, with file, line and ms", () => {
    assert.deepEqual(scan({ cwd: root, base: "main" }), [
      { file: "s/kept.test.ts", line: 3, ms: 6000 },
      { file: "s/kept.test.ts", line: 4, ms: 2500 },
      { file: "s/new.integration.test.ts", line: 3, ms: 4000 },
    ]);
  });
  test("from the merge base: a later commit on the base doesn't count as the change's", () => {
    assert.ok(!scan({ cwd: root, base: "main" }).some((w) => w.file === "s/base-later.test.ts"));
    assert.ok(scan({ cwd: root, base: "feature" }).every((w) => w.file !== "s/kept.test.ts" || w.line === 4), "against its own tip, only the uncommitted edit is new");
  });
  test("a base git can't resolve throws (the script's exit 2), never an empty list", () => {
    assert.throws(() => scan({ cwd: root, base: "no-such-branch" }));
  });
});
