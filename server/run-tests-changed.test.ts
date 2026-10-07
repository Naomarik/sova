// Run: pnpm test -- server/run-tests-changed.test.ts. `pnpm test:int --changed` (§app.server-runtime/test-tiers)
// keeps the test files a change may break: those whose relative-import closure holds a changed file, and
// those in a changed file's folder; the changed files are everything since the merge base, committed or not.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { after, describe, test } from "node:test";
import { affected, changedSince, resolveImport } from "../scripts/test-changed.mjs";
import { scratchRoot } from "./test-scratch";

const base = scratchRoot("sova-changed-");
after(() => rmSync(base, { recursive: true, force: true }));
const root = join(base, "repo");
const put = (file: string, text: string) => {
  mkdirSync(dirname(join(root, file)), { recursive: true });
  writeFileSync(join(root, file), text);
};
put("a/x.integration.test.ts", `import { y } from "../lib/y";\n`);
put("lib/y.ts", `export * from "./deep/z.js";\nexport const y = 1;\n`);
put("lib/deep/z.ts", `export const z = 1;\n`);
put("b/w.integration.test.ts", `import fs from "node:fs";\nimport { describe } from "node:test";\n`);
put("c/v.integration.test.ts", `const m = await import("../lib/other.ts");\nimport "../lib/p";\n`);
put("lib/other.ts", `export {};\n`);
put("lib/p.ts", `import { q } from "./q";\nexport const p = 1;\n`);
put("lib/q.ts", `import { p } from "./p";\nexport const q = 1;\n`);
put("d/index-user.integration.test.ts", `import { i } from "../lib/pkg";\n`);
put("lib/pkg/index.ts", `export const i = 1;\n`);
const tests = ["a/x.integration.test.ts", "b/w.integration.test.ts", "c/v.integration.test.ts", "d/index-user.integration.test.ts"];

describe("which test files --changed keeps", () => {
  test("a file reached through imports and a re-export, a .js specifier naming its .ts", () => {
    assert.deepEqual(affected(root, tests, ["lib/deep/z.ts"]), ["a/x.integration.test.ts"]);
  });
  test("a dynamic import, and a folder's index file", () => {
    assert.deepEqual(affected(root, tests, ["lib/other.ts"]), ["c/v.integration.test.ts"]);
    assert.deepEqual(affected(root, tests, ["lib/pkg/index.ts"]), ["d/index-user.integration.test.ts"]);
  });
  test("an import cycle ends, and still finds the change", () => {
    assert.deepEqual(affected(root, tests, ["lib/q.ts"]), ["c/v.integration.test.ts"]);
  });
  test("a file in a changed file's folder, whatever it imports; a changed test file itself", () => {
    assert.deepEqual(affected(root, tests, ["b/README.md"]), ["b/w.integration.test.ts"]);
    assert.deepEqual(affected(root, tests, ["a/x.integration.test.ts"]), ["a/x.integration.test.ts"]);
  });
  test("nothing for a change no test reaches, or no change; a deleted changed file is fine", () => {
    assert.deepEqual(affected(root, tests, ["docs/notes.md", "lib/gone.ts"]), []);
    assert.deepEqual(affected(root, tests, []), []);
  });
  test("an import that names a package, or nothing in the tree, resolves to nothing", () => {
    assert.equal(resolveImport(root, "a/x.integration.test.ts", "./missing"), null);
    assert.equal(resolveImport(root, "a/x.integration.test.ts", "../../outside"), null);
    assert.equal(resolveImport(root, "a/x.integration.test.ts", "../lib/y"), "lib/y.ts");
  });
});

describe("the changed files", () => {
  test("since the merge base: committed on the branch, uncommitted and untracked; not master's own later commits", () => {
    const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=T", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", ...args], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    git("init", "-q", "-b", "master");
    git("add", "-A");
    git("commit", "-q", "-m", "root");
    git("checkout", "-q", "-b", "feat");
    put("lib/deep/z.ts", `export const z = 2;\n`);
    git("commit", "-q", "-am", "branch");
    git("checkout", "-q", "master");
    put("lib/other.ts", `export const later = 1;\n`);
    git("commit", "-q", "-am", "master moves on");
    git("checkout", "-q", "feat");
    put("lib/p.ts", `import { q } from "./q";\nexport const p = 2;\n`);
    put("e/new.ts", `export {};\n`);
    assert.deepEqual(changedSince(root, "master").sort(), ["e/new.ts", "lib/deep/z.ts", "lib/p.ts"]);
    assert.throws(() => changedSince(root, "no-such-branch"));
  });
});
