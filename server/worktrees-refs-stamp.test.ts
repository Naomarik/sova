// gitRefsStamp: what an answer about refs rests on, read without Git. Each case a stamp must tell apart.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { gitRefsStamp } from "./worktrees";

function repo() {
  const main = mkdtempSync(join(tmpdir(), "sova-refs-stamp-"));
  const git = join(main, ".git");
  mkdirSync(join(git, "refs/heads/feat"), { recursive: true });
  writeFileSync(join(git, "HEAD"), "ref: refs/heads/master\n");
  writeFileSync(join(git, "index"), "i1");
  writeFileSync(join(git, "refs/heads/master"), "a\n");
  writeFileSync(join(git, "refs/heads/feat/x"), "b\n");
  const gd = join(git, "worktrees/x");
  mkdirSync(gd, { recursive: true });
  writeFileSync(join(gd, "HEAD"), "ref: refs/heads/feat/x\n");
  writeFileSync(join(gd, "commondir"), "../..\n");
  const tree = join(main, "wt");
  mkdirSync(tree);
  writeFileSync(join(tree, ".git"), `gitdir: ${gd}\n`);
  return { main, git, gd, tree };
}
/** A ref written as git writes one: a lock file renamed over it. */
function update(path: string, text: string) {
  writeFileSync(`${path}.lock`, text);
  renameSync(`${path}.lock`, path);
}
const refs = ["refs/heads/master", "refs/heads/feat/x"];

test("the stamp moves with a named ref, packed-refs and HEAD, in a linked worktree and a main checkout", () => {
  const { main, git, gd, tree } = repo();
  for (const dir of [tree, main]) assert.equal(gitRefsStamp(dir, refs), gitRefsStamp(dir, refs), "unmoved refs: the same stamp");
  let was = gitRefsStamp(tree, refs);
  update(join(git, "refs/heads/master"), "c\n");
  assert.notEqual(gitRefsStamp(tree, refs), was, "the base moved");
  was = gitRefsStamp(tree, refs);
  update(join(git, "packed-refs"), "# packed\n");
  assert.notEqual(gitRefsStamp(tree, refs), was, "packed");
  was = gitRefsStamp(tree, refs);
  rmSync(join(git, "refs/heads/feat/x"));
  assert.notEqual(gitRefsStamp(tree, refs), was, "the branch went");
  was = gitRefsStamp(tree, refs);
  update(join(gd, "HEAD"), "ref: refs/heads/other\n");
  assert.notEqual(gitRefsStamp(tree, refs), was, "a checkout");
  was = gitRefsStamp(main, []);
  update(join(git, "refs/heads/master"), "d\n");
  assert.notEqual(gitRefsStamp(main, []), was, "the ref HEAD names counts unasked");
});

test("the index isn't in it: `git status` rewrites that with nothing committed", () => {
  const { git, main } = repo();
  const was = gitRefsStamp(main, refs);
  update(join(git, "index"), "i2");
  assert.equal(gitRefsStamp(main, refs), was);
});

test("null where nothing pins the answer: a reftable repo, a gone folder, a ref path out of the repo", () => {
  const { git, main } = repo();
  assert.equal(gitRefsStamp(join(main, "nope"), refs), null);
  assert.equal(gitRefsStamp(main, ["refs/heads/../../x"]), null);
  assert.equal(gitRefsStamp(main, ["/etc/passwd"]), null);
  mkdirSync(join(git, "reftable"));
  assert.equal(gitRefsStamp(main, refs), null);
});
