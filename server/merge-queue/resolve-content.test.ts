// merge.resolve's contents (resolve-content.ts): Sova writes the thread's merged files in the entry's scratch copy and
// commits them there. A branch is untrusted: a symlink it adds never carries a write out of the copy. Real git, temp dirs.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { scratchRoot } from "../test-scratch";
import { realGit } from "./guard";
import { commitResolution, contentPath, ResolveRefused } from "./resolve-content";
import { makeScratchCopy } from "./scratch";

function conflicted(withLink: boolean) {
  const top = scratchRoot("resolve-content-");
  const root = join(top, "proj");
  const outside = join(top, "outside");
  mkdirSync(root, { recursive: true });
  mkdirSync(outside, { recursive: true });
  const git = (...a: string[]) => execFileSync("git", a, { cwd: root, encoding: "utf8" }).trim();
  git("init", "-q", "-b", "master");
  git("config", "user.email", "t@example.invalid");
  git("config", "user.name", "t");
  writeFileSync(join(root, "a.txt"), "one\n");
  git("add", "-A");
  git("commit", "-q", "-m", "base");
  git("checkout", "-q", "-b", "feat");
  writeFileSync(join(root, "a.txt"), "branch\n");
  if (withLink) symlinkSync(outside, join(root, "lnk"));
  git("add", "-A");
  git("commit", "-q", "-m", "branch");
  const commit = git("rev-parse", "HEAD");
  git("checkout", "-q", "master");
  writeFileSync(join(root, "a.txt"), "master\n");
  git("commit", "-q", "-am", "master");
  return { root, outside, commit, base: git("rev-parse", "HEAD"), git };
}

test("contents: a symlink the branch adds is checked after the merge: no write goes through it, and the merge is undone", async () => {
  const r = conflicted(true);
  const copy = await makeScratchCopy(realGit, { root: r.root, entry: "mq_1", base: r.base });
  assert.equal(existsSync(join(copy, "lnk")), false, "not there before the merge: a check made then would pass");
  await assert.rejects(
    commitResolution(realGit, { copy, entry: "mq_1", base: r.base, commit: r.commit, target: "master", branch: "feat", contents: { "a.txt": "both\n", "lnk/AGENTS.md": "written outside\n" } }),
    (err: Error) => err instanceof ResolveRefused && /symlink/.test(err.message),
  );
  assert.equal(existsSync(join(r.outside, "AGENTS.md")), false, "nothing was written outside the copy");
  assert.notEqual(spawnSync("git", ["rev-parse", "-q", "--verify", "MERGE_HEAD"], { cwd: copy }).status, 0, "the merge was aborted");
});

test("contents: the resolution is committed in the detached copy, parents target then approved; master doesn't move", async () => {
  const r = conflicted(false);
  const copy = await makeScratchCopy(realGit, { root: r.root, entry: "mq_2", base: r.base });
  const before = r.git("for-each-ref", "--format=%(refname) %(objectname)", "refs/heads");
  const sha = await commitResolution(realGit, { copy, entry: "mq_2", base: r.base, commit: r.commit, target: "master", branch: "feat", contents: { "a.txt": "both\n" } });
  assert.deepEqual(r.git("rev-list", "--parents", "-n", "1", sha).split(" ").slice(1), [r.base, r.commit]);
  assert.equal(r.git("for-each-ref", "--format=%(refname) %(objectname)", "refs/heads"), before);
  assert.equal(r.git("show", `${sha}:a.txt`), "both");
});

test("contents: paths that leave the copy, or a folder that isn't the entry's scratch copy, are refused", async () => {
  const r = conflicted(false);
  for (const p of ["../x", "/etc/passwd", ".git/config", "a/../../x"]) assert.throws(() => contentPath(r.root, p), ResolveRefused, p);
  await assert.rejects(commitResolution(realGit, { copy: r.root, entry: "mq_3", base: r.base, commit: r.commit, target: "master", branch: "feat", contents: { "a.txt": "x" } }), /no scratch copy of mq_3/);
});
