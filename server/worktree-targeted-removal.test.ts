// Removing one worktree forgets only that one (Remove Worktree, a deploy's fresh checkout, a merge scratch copy, a
// conformance run's scratch copies): never a bare `git worktree prune`, which forgets every
// worktree whose folder is missing. Real git in throwaway repositories; each case has two
// worktrees whose folders are gone, removes one, and the other is still in git's list.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";

const tmp = realpathSync(mkdtempSync(join(tmpdir(), "sova-wtrm-")));
const savedAgentDir = process.env.PI_CODING_AGENT_DIR;
before(() => {
  process.env.PI_CODING_AGENT_DIR = join(tmp, "agent");
  mkdirSync(process.env.PI_CODING_AGENT_DIR, { recursive: true });
});
after(() => {
  if (savedAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = savedAgentDir;
  rmSync(tmp, { recursive: true, force: true });
});

const sh = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
let n = 0;
function repo(): string {
  const dir = join(tmp, `r${n++}`, "main");
  mkdirSync(dir, { recursive: true });
  sh(dir, "init", "-q", "-b", "master");
  sh(dir, "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "-c", "maintenance.auto=false", "commit", "-q", "--allow-empty", "-m", "init");
  return dir;
}
/** Every worktree git lists for `root`, the main checkout included. */
const listed = (root: string) => sh(root, "worktree", "list", "--porcelain").split("\n").filter((l) => l.startsWith("worktree ")).map((l) => l.slice(9));

test("Remove Worktree on a missing folder forgets that worktree only", async () => {
  const { removeWorktree } = await import("./project-worktrees");
  const root = repo();
  const a = join(tmp, `wt-a-${n}`);
  const b = join(tmp, `wt-b-${n}`);
  sh(root, "worktree", "add", "-q", "-b", "sova/a", a);
  sh(root, "worktree", "add", "-q", "-b", "sova/b", b);
  rmSync(a, { recursive: true, force: true });
  rmSync(b, { recursive: true, force: true });
  await removeWorktree({ path: a, branch: "sova/a", target: "master" } as Parameters<typeof removeWorktree>[0], root);
  assert.deepEqual(listed(root), [root, b], "the other missing worktree is still listed");
});

test("dropping a deploy's fresh checkout forgets that checkout only", async () => {
  const { cutCheckout, dropCheckout } = await import("./project-services/deploy");
  const { realGit } = await import("./project-services/engine");
  const root = repo();
  const head = sh(root, "rev-parse", "HEAD");
  const one = await cutCheckout(realGit, root, head, `one-${n}`);
  const two = await cutCheckout(realGit, root, head, `two-${n}`);
  const other = join(tmp, `wt-other-${n}`);
  sh(root, "worktree", "add", "-q", "-b", "sova/other", other);
  for (const d of [one, two, other]) rmSync(d, { recursive: true, force: true });
  await dropCheckout(realGit, root, one);
  assert.deepEqual(listed(root), [root, two, other]);
  // And one whose folder is still there goes, folder and record, leaving the missing ones listed.
  const three = await cutCheckout(realGit, root, head, `three-${n}`);
  await dropCheckout(realGit, root, three);
  assert.deepEqual(listed(root), [root, two, other]);
});

test("removing a conformance run's scratch copies forgets those only", async () => {
  const { removeScratch } = await import("./project-services/conform");
  const { realGit } = await import("./project-services/engine");
  const root = repo();
  const paths = ["a", "b", "keep"].map((x) => join(tmp, `scr-${x}-${n}`));
  sh(root, "worktree", "add", "-q", "-b", "sova/conform-r1-a", paths[0]!);
  sh(root, "worktree", "add", "-q", "-b", "sova/conform-r1-b", paths[1]!);
  sh(root, "worktree", "add", "-q", "-b", "sova/someone-else", paths[2]!);
  rmSync(paths[0]!, { recursive: true, force: true });
  rmSync(paths[2]!, { recursive: true, force: true });
  // One git refuses to remove (its .git file is gone): the run deletes the folder itself, then the record.
  rmSync(join(paths[1]!, ".git"));
  await removeScratch(realGit, root, ["sova/conform-r1-a", "sova/conform-r1-b"]);
  assert.deepEqual(listed(root), [root, paths[2]], "someone else's missing worktree is still listed");
  assert.equal(sh(root, "branch", "--list", "sova/conform-r1-*"), "");
});

/** A scratch copy's case: `root`, and another worktree of the repository whose folder is gone. */
function withOtherGone(tag: string): { root: string; other: string; base: string; entry: string } {
  const root = repo();
  const other = join(tmp, `wt-${tag}-${n}`);
  sh(root, "worktree", "add", "-q", "-b", `sova/${tag}`, other);
  rmSync(other, { recursive: true, force: true });
  return { root, other, base: sh(root, "rev-parse", "HEAD"), entry: `mq_${tag}${n}` };
}
const sorted = (paths: string[]) => [...paths].sort();

test("making a merge scratch copy over a stale record of its own path forgets that record only", async () => {
  const { makeScratchCopy, scratchCopyPath, isScratchCopy, scratchCopiesIn } = await import("./merge-queue/scratch");
  const { realGit } = await import("./merge-queue/guard");
  const { root, other, base, entry } = withOtherGone("makestale");
  // An interrupted cut: the copy's record is there, its folder isn't. Its folder is one of the two that are gone.
  const path = scratchCopyPath(root, entry);
  sh(root, "worktree", "add", "-q", "--detach", path);
  rmSync(path, { recursive: true, force: true });
  assert.equal(await makeScratchCopy(realGit, { root, entry, base }), path);
  assert.deepEqual(sorted(listed(root)), sorted([root, other, path]), "one record of the copy, and the other missing worktree is still listed");
  assert.ok(isScratchCopy(path), "the new copy is the queue's");
  assert.deepEqual(scratchCopiesIn(join(root, ".git")).map((c) => c.path), [path]);
});

test("making a merge scratch copy with no record of its own forgets nothing else", async () => {
  const { makeScratchCopy, scratchCopyPath } = await import("./merge-queue/scratch");
  const { realGit } = await import("./merge-queue/guard");
  const { root, other, base, entry } = withOtherGone("makefresh");
  const second = join(tmp, `wt-second-${n}`);
  sh(root, "worktree", "add", "-q", "-b", `sova/second-${n}`, second);
  rmSync(second, { recursive: true, force: true });
  const path = await makeScratchCopy(realGit, { root, entry, base });
  assert.equal(path, scratchCopyPath(root, entry));
  assert.deepEqual(sorted(listed(root)), sorted([root, other, second, path]));
});

test("replacing a merge scratch copy forgets only the copy it replaces", async () => {
  const { makeScratchCopy } = await import("./merge-queue/scratch");
  const { realGit } = await import("./merge-queue/guard");
  const { root, other, base, entry } = withOtherGone("replace");
  const path = await makeScratchCopy(realGit, { root, entry, base });
  await makeScratchCopy(realGit, { root, entry, base });
  assert.deepEqual(sorted(listed(root)), sorted([root, other, path]));
});

for (const [how, gone] of [
  ["its folder is gone", (p: string) => rmSync(p, { recursive: true, force: true })],
  ["git refuses it (its .git file is gone)", (p: string) => rmSync(join(p, ".git"))],
  ["its folder is whole", () => {}],
] as const) {
  test(`dropping a merge scratch copy when ${how} forgets that copy only`, async () => {
    const { dropScratch, makeScratchCopy, scratchCopiesIn } = await import("./merge-queue/scratch");
    const { realGit } = await import("./merge-queue/guard");
    const { root, other, base, entry } = withOtherGone(`drop${how.length}`);
    const path = await makeScratchCopy(realGit, { root, entry, base });
    gone(path);
    assert.equal((await dropScratch(realGit, root, entry)).copy, true, "the copy is cleaned up");
    assert.ok(!existsSync(path), "its folder is gone");
    assert.deepEqual(sorted(listed(root)), sorted([root, other]), "the other missing worktree is still listed");
    assert.deepEqual(scratchCopiesIn(join(root, ".git")), [], "its record went with it");
  });
}
