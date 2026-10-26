// The session's repository summary carries its git folder's reading (integration: the summary
// runs its script through `sh`). Real git in throwaway repositories.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { measureGitFolder } from "./git-folder";
import { clearGitCache, execGroup, getGitSummary } from "./git-summary";
import { targetsRoot } from "./targets";

const tmp = realpathSync(mkdtempSync(join(tmpdir(), "sova-gitfolder-int-")));
after(() => rmSync(tmp, { recursive: true, force: true }));

test("a local repository's summary carries its git folder (the common one, for a linked worktree too); a target's never", async () => {
  clearGitCache();
  const root = join(tmp, "repo");
  mkdirSync(root);
  const git = (cwd: string, ...a: string[]) => execFileSync("git", a, { cwd, stdio: "pipe" });
  git(root, "init", "-q", "-b", "main");
  git(root, "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "-c", "maintenance.auto=false", "commit", "-q", "--allow-empty", "-m", "init");
  const wt = join(tmp, "wt");
  git(root, "worktree", "add", "-q", "-b", "w", wt);
  const seen: string[] = [];
  const gitFolder = async (d: string) => {
    seen.push(d);
    return measureGitFolder(d, Date.now());
  };
  const s = await getGitSummary("/unused.jsonl", {}, { storedCwd: async () => wt, gitFolder });
  assert.equal(s.state, "repo");
  const common = join(realpathSync(root), ".git");
  assert.deepEqual(seen, [common]);
  assert.ok(s.state === "repo" && s.gitFolder && s.gitFolder.path === common && s.gitFolder.bytes > 0 && s.gitFolder.warning === null);
  // Without the default reader's cache in the way, the real one answers the same folder.
  clearGitCache();
  const real = await getGitSummary("/unused.jsonl", { fresh: true }, { storedCwd: async () => root });
  assert.equal(real.state === "repo" && real.gitFolder?.path, common);
  // A session on a target: its script runs there (a stand-in target that answers from this same
  // repository), it is a whole repo summary, and no git folder is read here.
  const onTarget = await getGitSummary("/unused2.jsonl", {}, {
    storedCwd: async () => join(targetsRoot(), "box", "srv", "app"),
    runRemote: async (_target, script) => ({ ok: true, run: await execGroup(["sh", "-c", `cd -- "$1" || exit 1\n${script}`, "sh", root], { timeoutMs: 12_000, byteCap: 900 * 1024 }) }) as never,
    gitFolder,
  });
  assert.equal(onTarget.state, "repo");
  assert.equal(onTarget.state === "repo" && onTarget.where.kind, "remote");
  assert.equal(onTarget.state === "repo" && onTarget.gitFolder, undefined);
  assert.equal(seen.length, 1);
});
