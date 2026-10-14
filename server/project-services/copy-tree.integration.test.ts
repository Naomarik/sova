// Run: pnpm test -- server/project-services/copy-tree.test.ts
// A data `from` copy with the host's own cp (§app.project-services/contract): GNU cp on Linux,
// BSD cp's clone flag on macOS (which rejects --reflink), and a real copy on this host.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, linkSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
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

const script = join(import.meta.dirname, "..", "..", "scripts", "copy-tree.mjs");

test("scripts/copy-tree.mjs makes the folder and copies into it", () => {
  const src = join(tmp, "src2");
  mkdirSync(src);
  writeFileSync(join(src, "a"), "1");
  const dst = join(tmp, "made", "here");
  execFileSync(process.execPath, [script, src, dst]);
  assert.equal(readFileSync(join(dst, "a"), "utf8"), "1");
});

// Two pnpm node_modules from one store hold hardlinks of the same files: cp onto them refuses ("are
// the same file"). The script replaces the destination instead, so it ends an exact copy.
test("scripts/copy-tree.mjs replaces a destination holding hardlinks of the source and files it lacks", () => {
  const src = join(tmp, "src3");
  const dst = join(tmp, "dst3");
  mkdirSync(join(src, "pkg"), { recursive: true });
  writeFileSync(join(src, "pkg", "index.js"), "new");
  writeFileSync(join(src, "top"), "top");
  mkdirSync(join(dst, "pkg"), { recursive: true });
  linkSync(join(src, "pkg", "index.js"), join(dst, "pkg", "index.js"));
  linkSync(join(src, "top"), join(dst, "top"));
  writeFileSync(join(dst, "extra"), "stale");
  assert.equal(statSync(join(dst, "top")).ino, statSync(join(src, "top")).ino, "the destination starts as hardlinks of the source");
  execFileSync(process.execPath, [script, src, dst], { stdio: "pipe" });
  assert.deepEqual(readdirSync(dst).sort(), ["pkg", "top"]);
  assert.equal(readFileSync(join(dst, "pkg", "index.js"), "utf8"), "new");
  assert.equal(readFileSync(join(dst, "top"), "utf8"), "top");
  assert.deepEqual(readdirSync(tmp).filter((f) => f.startsWith("dst3.")), [], "no temporary sibling left behind");
});

test("scripts/copy-tree.mjs leaves the destination as it was when the copy fails", () => {
  const dst = join(tmp, "dst4");
  mkdirSync(dst);
  writeFileSync(join(dst, "keep"), "kept");
  assert.throws(() => execFileSync(process.execPath, [script, join(tmp, "no-such-src"), dst], { stdio: "pipe" }));
  assert.equal(readFileSync(join(dst, "keep"), "utf8"), "kept");
  assert.equal(existsSync(join(dst, "no-such-src")), false);
  assert.deepEqual(readdirSync(tmp).filter((f) => f.startsWith("dst4.")), [], "no temporary sibling left behind");
});
