// Removing one worktree forgets only that one (Remove Worktree, a deploy's fresh checkout, a
// conformance run's scratch copies): never a bare `git worktree prune`, which forgets every
// worktree whose folder is missing. Real git in throwaway repositories; each case has two
// worktrees whose folders are gone, removes one, and the other is still in git's list.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
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
