// Run: pnpm test -- server/project-services/copy-tree.test.ts
// A data `from` copy with the host's own cp (§app.project-services/contract): GNU cp on Linux,
// BSD cp's clone flag on macOS (which rejects --reflink), and a real copy on this host.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { copyContentsArgv } from "./copy-tree";

const tmp = mkdtempSync(join(tmpdir(), "sova-copy-tree-test-"));
after(() => rmSync(tmp, { recursive: true, force: true }));

// The cases here run real programs or read git behaviour; copy-tree.test.ts holds the in-process ones.
test("this host's cp copies the contents, symlinks as symlinks, into an existing folder, twice", () => {
  const src = join(tmp, "src");
  const dst = join(tmp, "dst");
  mkdirSync(join(src, "sub"), { recursive: true });
  writeFileSync(join(src, "sub", "f.txt"), "hello");
  symlinkSync("sub/f.txt", join(src, "link"));
  mkdirSync(dst);
  for (let i = 0; i < 2; i++) execFileSync("cp", copyContentsArgv(src, dst));
  assert.equal(readFileSync(join(dst, "sub", "f.txt"), "utf8"), "hello");
  assert.equal(readlinkSync(join(dst, "link")), "sub/f.txt");
});

test("scripts/copy-tree.mjs makes the folder and copies into it", () => {
  const src = join(tmp, "src2");
  mkdirSync(src);
  writeFileSync(join(src, "a"), "1");
  const dst = join(tmp, "made", "here");
  execFileSync(process.execPath, [join(import.meta.dirname, "..", "..", "scripts", "copy-tree.mjs"), src, dst]);
  assert.equal(readFileSync(join(dst, "a"), "utf8"), "1");
});
