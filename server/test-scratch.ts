import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Tests only (nothing in the server imports this). A test's temp root, made in the OS temp dir and
 * proven to be in no git repository, as every git the test starts will see it. A plain folder made
 * under it then stays plain: registered as a project it is that folder (git: false), never the
 * checkout around it, so a promotion or coding session there can't commit, branch or add a worktree
 * in a repository the test didn't make. A test that wants a repository makes one under it (`git
 * init`). Throws when git finds one from here: run through `pnpm test`, whose preload stops git's
 * search at the temp dir.
 */
export function scratchRoot(prefix: string): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  let found: string | null = null;
  try {
    found = execFileSync("git", ["rev-parse", "--absolute-git-dir"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || null;
  } catch {
    /* no repository: as wanted */
  }
  if (found) {
    rmSync(root, { recursive: true, force: true });
    throw new Error(`scratchRoot: ${root} is inside the git repository ${found}; a plain test folder there would be that repository's. Run the tests through pnpm test, or with a TMPDIR outside every repository.`);
  }
  return root;
}
