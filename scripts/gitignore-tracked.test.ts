// No tracked file matches .gitignore: a broad rule (`*secret*`) that catches a source file hides its
// new siblings and confuses tools that copy only unignored files. Reads git's index only.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));

test("no tracked file is ignored by .gitignore", { skip: !existsSync(`${root}/.git`) && "no git repository" }, () => {
  const out = execFileSync("git", ["ls-files", "-ci", "--exclude-standard"], { cwd: root, encoding: "utf8" });
  assert.equal(out.trim(), "", `tracked files that .gitignore matches (add a !negation or narrow the rule):\n${out}`);
});
