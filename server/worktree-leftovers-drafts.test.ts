// §chat.worktrees/leftovers: "a spec draft proved landed lets a tree go; one not proved landed always keeps it". The list
// of unproved names only speaks for the drafts it could have named: a folder the draft tools never read (a dot-folder) is
// proved by nothing, so being absent from that list says nothing about it. Each case is real git in a throwaway repository.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import type { GitRunner } from "./worktrees";
import { draftNamesIn } from "./spec-drafts-state";
import { scratchRoot } from "./test-scratch";
import { holdsWork, leftovers, leftoversReason } from "./worktree-leftovers";
import { execGit } from "./worktrees";

const root = realpathSync(scratchRoot("sova-leftovers-drafts-"));
after(() => rmSync(root, { recursive: true, force: true }));
let n = 0;

function repoWith(files: readonly string[]): string {
  const dir = join(root, `r${++n}`);
  mkdirSync(dir);
  const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: dir, stdio: "ignore" });
  git("init", "-q");
  writeFileSync(join(dir, ".gitignore"), ".sova/spec/drafts/\n");
  writeFileSync(join(dir, "a.txt"), "a\n");
  git("add", "-A");
  git("commit", "-q", "-m", "base");
  for (const f of files) {
    mkdirSync(dirname(join(dir, f)), { recursive: true });
    writeFileSync(join(dir, f), "only here\n");
  }
  return dir;
}

const NOTE = ".sova/spec/drafts/.old/note.md";
const PROVED = ".sova/spec/drafts/feature-x/draft.json";

test("a dot-folder under drafts, whatever else is proved: no proof names it, so it stays ignored and the tree holds", async () => {
  const l = await leftovers(repoWith([NOTE]), undefined, { provedDrafts: ["feature-x"] });
  assert.deepEqual(l.ignored, [NOTE]);
  assert.equal(holdsWork(l), true);
  assert.notEqual(leftoversReason(l), null);
  assert.ok(!l.rebuildable.includes(NOTE), "and it isn't among what goes with the folder");
});

test("a draft positively proved landed is let go: the case above isn't holding everything", async () => {
  const l = await leftovers(repoWith([PROVED]), undefined, { provedDrafts: ["feature-x"] });
  assert.deepEqual(l.ignored, []);
  assert.equal(holdsWork(l), false);
  assert.ok(l.rebuildable.includes(PROVED), JSON.stringify(l));
});

test("the same draft not named as proved holds: only a name proved lets one go", async () => {
  const l = await leftovers(repoWith([PROVED]), undefined, { provedDrafts: [] });
  assert.deepEqual(l.ignored, [PROVED]);
  assert.equal(holdsWork(l), true);
});

test("the dot-folder held beside a proved draft: the proved one is let go and only the other holds", async () => {
  const l = await leftovers(repoWith([PROVED, NOTE]), undefined, { provedDrafts: ["feature-x"] });
  assert.deepEqual(l.ignored, [NOTE]);
  assert.ok(l.rebuildable.includes(PROVED));
});

test("a caller asking which names to prove never gets a dot-folder: the name a proof could vouch for is a real draft's", () => {
  const dir = repoWith([PROVED, NOTE]);
  assert.deepEqual(draftNamesIn(dir), ["feature-x"]);
});

test("the read of skip-worktree and assume-unchanged files failing keeps the tree: what it would have shown can't be known", async () => {
  const dir = repoWith([]);
  const failing: GitRunner = async (args, opts) => (args.includes("-v") ? { code: 128, stdout: "", stderr: "fatal: can't read the index" } : execGit(args, opts));
  const control = await leftovers(dir, execGit, { provedDrafts: [] });
  assert.equal(control.unreadable, undefined, "the control: the same tree reads fine with git working");
  const l = await leftovers(dir, failing, { provedDrafts: [] });
  assert.match(l.unreadable ?? "", /can't read the index/);
  assert.equal(holdsWork(l), true);
});
