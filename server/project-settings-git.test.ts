import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { dirtyPaths, git, repoOf, worktreeDiff } from "./project-settings-git";

const root = mkdtempSync(join(tmpdir(), "settings-git-"));
after(() => rmSync(root, { recursive: true, force: true }));

function staleIndex(name: string) {
  const dir = join(root, name);
  mkdirSync(join(dir, ".sova"), { recursive: true });
  const sh = (...a: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t.invalid", "-c", "commit.gpgsign=false", ...a], { cwd: dir, encoding: "utf8" });
  sh("init", "-q", "-b", "master");
  const file = join(dir, ".sova", "a.json");
  writeFileSync(file, "{}\n");
  sh("add", ".");
  sh("commit", "-qm", "base");
  // Same bytes, a new mtime: what makes git refresh the index on a read that may.
  const later = new Date(Date.now() + 60_000);
  utimesSync(file, later, later);
  const index = join(dir, ".git", "index");
  return { dir, index, written: () => [statSync(index).ino, statSync(index).mtimeMs, readFileSync(index).toString("hex")].join(" ") };
}

test("the control: a plain git status does rewrite an index with a stale entry", async () => {
  const c = staleIndex("control");
  const before = c.written();
  await git(["status", "--porcelain=v1"], c.dir);
  assert.notEqual(c.written(), before);
});

test("reading a checkout's settings leaves its index alone, so a landing's fast-forward never meets our lock", async () => {
  const c = staleIndex("reads");
  const before = c.written();
  const repo = (await repoOf(c.dir))!;
  assert.deepEqual(await dirtyPaths(repo, [".sova/a.json"]), []);
  assert.equal(c.written(), before, "dirtyPaths");
  await worktreeDiff(repo, [".sova/a.json"]);
  assert.equal(c.written(), before, "worktreeDiff");
});

test("worktreeDiff is the patch git diff shows for an edited file", async () => {
  const c = staleIndex("patch");
  writeFileSync(join(c.dir, ".sova", "a.json"), '{"a":1}\n');
  const repo = (await repoOf(c.dir))!;
  const plain = await git(["diff", "--no-color", "--no-ext-diff", "HEAD", "--", ".sova/a.json"], repo.top);
  assert.ok(plain.stdout.includes('+{"a":1}'), plain.stdout);
  assert.equal(await worktreeDiff(repo, [".sova/a.json"]), plain.stdout);
});
