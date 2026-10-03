// Run: pnpm exec tsx --test server/project-worktrees.test.ts. Real git in throwaway repositories under
// the OS temp dir (deleted after): a coding session's worktree (cut, read, merged back, removed) and
// the promotion commit (only the spec files the promotion changed, skipped with the reason otherwise).
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { LOCAL_ONLY_IGNORE } from "./project-worktrees";
import { commitSpec, cutWorktree, DETACHED, gitRootOf, mergeBack, NO_COMMITS, NOT_GIT, readWorktree, removeWorktree, specSnapshot, worktreeSlug, type GitRoot } from "./project-worktrees";

const tmp = realpathSync(mkdtempSync(join(tmpdir(), "sova-pwt-")));
after(() => rmSync(tmp, { recursive: true, force: true }));

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
let n = 0;
/** A repository at <tmp>/r<n>/client with one commit on master (spec manifest included). */
function repo(): string {
  const dir = join(tmp, `r${n++}`, "client");
  mkdirSync(join(dir, ".sova", "spec"), { recursive: true });
  git(dir, "init", "-q", "-b", "master");
  git(dir, "config", "user.email", "t@example.invalid");
  git(dir, "config", "user.name", "T");
  git(dir, "config", "commit.gpgsign", "false");
  writeFileSync(join(dir, ".sova", "spec", "manifest.json"), "{}\n");
  writeFileSync(join(dir, "README.md"), "hi\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "init");
  return dir;
}
async function rootOf(dir: string): Promise<GitRoot> {
  const r = await gitRootOf(dir);
  if ("reason" in r) throw new Error(r.reason);
  return r;
}
const commitIn = (dir: string, file: string, text: string) => {
  writeFileSync(join(dir, file), text);
  git(dir, "add", "--", file);
  git(dir, "commit", "-q", "-m", file);
};

describe("a coding session's worktree", () => {
  test("slugs are branch-safe, at most 40, never empty", () => {
    assert.equal(worktreeSlug("Build the Invoice approval flow, with the payroll export!"), "build-the-invoice-approval-flow-with-the");
    assert.equal(worktreeSlug("¿¿"), "coding");
  });

  test("not in git, no commits, or a detached checkout: the root itself, with the reason", async () => {
    const plain = join(tmp, "plain");
    mkdirSync(plain);
    assert.deepEqual(await gitRootOf(plain), { reason: NOT_GIT });
    const empty = join(tmp, "empty");
    mkdirSync(empty);
    git(empty, "init", "-q");
    assert.deepEqual(await gitRootOf(empty), { reason: NO_COMMITS });
    const det = repo();
    git(det, "checkout", "-q", "--detach");
    assert.deepEqual(await gitRootOf(det), { reason: DETACHED });
  });

  test("cut from the root's HEAD as sova/<name> beside the repo; a subfolder maps into it", async () => {
    const root = repo();
    mkdirSync(join(root, "app"));
    commitIn(root, "app/x.txt", "x\n");
    const cut = await cutWorktree(await rootOf(root), join(root, "app"), "Fix it", undefined, "abc123");
    assert.deepEqual(cut.worktree, { path: join(tmp, `r${n - 1}`, ".worktrees", "client-fix-it-abc123"), branch: "sova/fix-it-abc123", base: git(root, "rev-parse", "HEAD"), target: "master" });
    assert.equal(cut.cwd, join(cut.worktree.path, "app"));
    assert.equal(git(root, "symbolic-ref", "--short", "HEAD"), "master", "the root checkout never switches");
    assert.deepEqual(await readWorktree(cut.worktree, root), { state: "open", merged: false, branch: true, ahead: 0, unmerged: 0, dirty: false, worktree: cut.worktree.path });
    // git refuses (the branch exists): the reason is git's.
    await assert.rejects(cutWorktree(await rootOf(root), root, "Fix it", undefined, "abc123"), /already exists/);
  });

  test("Merge Branch: only into the root's checked-out target, clean and idle; fast-forward, else a merge commit", async () => {
    const root = repo();
    const cut = await cutWorktree(await rootOf(root), root, "Login", undefined, "000001");
    await assert.rejects(mergeBack(cut.worktree, root, "Login"), /has nothing to merge into master/);
    commitIn(cut.worktree.path, "login.txt", "login\n");
    git(root, "checkout", "-q", "-b", "other");
    await assert.rejects(mergeBack(cut.worktree, root, "Login"), /The project root has other checked out, not master\. Check out master there, then merge\./);
    git(root, "checkout", "-q", "master");
    writeFileSync(join(root, "README.md"), "dirty\n");
    await assert.rejects(mergeBack(cut.worktree, root, "Login"), /The project root has uncommitted changes to tracked files\. Commit or stash them, then merge\./);
    git(root, "checkout", "--", "README.md");
    // A partial build: refused, naming the files; committed, it merges.
    writeFileSync(join(cut.worktree.path, "half.txt"), "wip\n");
    await assert.rejects(mergeBack(cut.worktree, root, "Login"), { message: "The worktree has uncommitted changes in 1 file (half.txt). Commit them in the session first, then merge." });
    rmSync(join(cut.worktree.path, "half.txt"));
    git(root, "checkout", "-q", "--detach");
    await assert.rejects(mergeBack(cut.worktree, root, "Login"), /The project root's checkout is on a detached HEAD, not master\. Check out master there, then merge\./);
    git(root, "checkout", "-q", "master");
    const ff = await mergeBack(cut.worktree, root, "Login");
    assert.equal(ff.sha, git(root, "rev-parse", "HEAD"));
    assert.equal(git(root, "log", "-1", "--format=%s"), "login.txt", "a fast-forward adds no commit");
    assert.deepEqual((await readWorktree(cut.worktree, root)).state, "merged");

    // Diverged: a merge commit named after the branch and the session.
    const two = await cutWorktree(await rootOf(root), root, "Two", undefined, "000002");
    commitIn(two.worktree.path, "two.txt", "2\n");
    commitIn(root, "main.txt", "m\n");
    await mergeBack(two.worktree, root, "The second one");
    assert.equal(git(root, "log", "-1", "--format=%s"), "Merge sova/two-000002: The second one");
  });

  test("a conflict is aborted and counted, changing nothing; a merge in progress refuses", async () => {
    const root = repo();
    const cut = await cutWorktree(await rootOf(root), root, "Clash", undefined, "000003");
    commitIn(cut.worktree.path, "README.md", "theirs\n");
    commitIn(root, "README.md", "ours\n");
    const head = git(root, "rev-parse", "HEAD");
    await assert.rejects(mergeBack(cut.worktree, root, "Clash"), /sova\/clash-000003 conflicts with master in 1 file\. Nothing was merged\. Resolve it in the worktree, then merge again\./);
    assert.equal(git(root, "rev-parse", "HEAD"), head);
    assert.equal(git(root, "status", "--porcelain"), "");
    try {
      git(root, "merge", "--no-edit", "sova/clash-000003");
    } catch {
      // the conflict is the point
    }
    await assert.rejects(mergeBack(cut.worktree, root, "Clash"), /The project root is in the middle of a merge\. Finish it, then merge\./);
    git(root, "merge", "--abort");
  });

  test("Remove Worktree: refused with uncommitted changes (named); an unmerged branch keeps its commits, a merged one goes", async () => {
    const root = repo();
    const cut = await cutWorktree(await rootOf(root), root, "Keep", undefined, "000004");
    commitIn(cut.worktree.path, "k.txt", "k\n");
    writeFileSync(join(cut.worktree.path, "wip.txt"), "wip\n");
    await assert.rejects(removeWorktree(cut.worktree, root), /The worktree has uncommitted changes in 1 file \(wip\.txt\)\. Nothing was removed\. Commit or discard them first\./);
    rmSync(join(cut.worktree.path, "wip.txt"));
    assert.deepEqual(await removeWorktree(cut.worktree, root), { branchDeleted: false });
    assert.equal(existsSync(cut.worktree.path), false);
    assert.notEqual(git(root, "branch", "--list", cut.worktree.branch), "", "the unmerged branch stays");
    // Its folder gone, the branch still merges from the root; its reading comes from the root.
    assert.deepEqual(await readWorktree(cut.worktree, root), { state: "missing", merged: false, branch: true, ahead: 1, unmerged: 1, dirty: false, worktree: null });
    await mergeBack(cut.worktree, root, "Keep");
    assert.equal(readFileSync(join(root, "k.txt"), "utf8"), "k\n");

    const merged = await cutWorktree(await rootOf(root), root, "Done", undefined, "000005");
    commitIn(merged.worktree.path, "d.txt", "d\n");
    await mergeBack(merged.worktree, root, "Done");
    assert.deepEqual(await removeWorktree(merged.worktree, root), { branchDeleted: true });
    assert.equal(git(root, "branch", "--list", merged.worktree.branch), "");
    assert.equal((await readWorktree(merged.worktree, root)).branch, false, "a deleted branch reads as gone");
  });
});

describe("the promotion commit", () => {
  const promote = (root: string) => {
    // What a promotion writes: the manifest, a claim file, the local-only ignore; a draft stays ignored.
    writeFileSync(join(root, ".sova", "spec", "manifest.json"), '{"claims":1}\n');
    mkdirSync(join(root, ".sova", "spec", "claims", "requirements"), { recursive: true });
    writeFileSync(join(root, ".sova", "spec", "claims", "requirements", "invoicing.md"), "# Invoicing\n");
    writeFileSync(join(root, ".sova", "spec", ".gitignore"), "drafts/\n");
    mkdirSync(join(root, ".sova", "spec", "drafts", "d"), { recursive: true });
    writeFileSync(join(root, ".sova", "spec", "drafts", "d", "draft.json"), "{}\n");
  };

  test("commits exactly the spec files the promotion changed, by path, on the root's branch", async () => {
    const root = repo();
    writeFileSync(join(root, "README.md"), "someone's work\n");
    writeFileSync(join(root, "notes.txt"), "staged\n");
    git(root, "add", "notes.txt"); // staged, not the promotion's: stays staged, uncommitted
    const snap = await specSnapshot(root);
    assert.ok(snap);
    promote(root);
    const c = await commitSpec(snap, "Promote 1 decision: invoicing — Tony approves.");
    assert.ok(c && "sha" in c, JSON.stringify(c));
    assert.equal(c.branch, "master");
    assert.deepEqual(c.files, [".sova/spec/.gitignore", ".sova/spec/claims/requirements/invoicing.md", ".sova/spec/manifest.json"]);
    assert.equal(git(root, "rev-parse", "HEAD"), c.sha);
    assert.deepEqual(git(root, "show", "--name-only", "--format=", "HEAD").split("\n").sort(), c.files);
    assert.equal(git(root, "log", "-1", "--format=%s"), "Promote 1 decision: invoicing — Tony approves.");
    // Sova's identity, never the repo's configured one (t@example.invalid here).
    assert.equal(git(root, "log", "-1", "--format=%an <%ae> / %cn <%ce>"), "Sova <sova@localhost> / Sova <sova@localhost>");
    // (trimmed: README.md's leading status space goes)
    assert.equal(git(root, "status", "--porcelain"), "M README.md\nA  notes.txt");
  });

  test("Sova's own .gitignore, added before the promotion by drafting, is committed with it; someone else's is not", async () => {
    const root = repo();
    writeFileSync(join(root, ".sova", "spec", ".gitignore"), LOCAL_ONLY_IGNORE);
    const snap = await specSnapshot(root);
    writeFileSync(join(root, ".sova", "spec", "manifest.json"), '{"claims":1}\n');
    const c = await commitSpec(snap!, "m");
    assert.ok(c && "sha" in c);
    assert.deepEqual(c.files, [".sova/spec/.gitignore", ".sova/spec/manifest.json"]);

    const other = repo();
    writeFileSync(join(other, ".sova", "spec", ".gitignore"), "mine/\n");
    const snap2 = await specSnapshot(other);
    writeFileSync(join(other, ".sova", "spec", "manifest.json"), '{"claims":1}\n');
    const c2 = await commitSpec(snap2!, "m");
    assert.ok(c2 && "sha" in c2);
    assert.deepEqual(c2.files, [".sova/spec/manifest.json"]);
  });

  test("a file the promotion changed that already had changes: skipped, nothing committed", async () => {
    const root = repo();
    writeFileSync(join(root, ".sova", "spec", "manifest.json"), '{"mine":true}\n');
    const snap = await specSnapshot(root);
    promote(root);
    const head = git(root, "rev-parse", "HEAD");
    assert.deepEqual(await commitSpec(snap!, "m"), {
      skipped: "Not committed: .sova/spec/manifest.json had changes Sova didn't make. Commit or discard them, and later promotions are committed again.",
    });
    assert.equal(git(root, "rev-parse", "HEAD"), head);
  });

  test("an earlier change the promotion left alone is not committed with it", async () => {
    const root = repo();
    mkdirSync(join(root, ".sova", "spec", "claims", "app"), { recursive: true });
    writeFileSync(join(root, ".sova", "spec", "claims", "app", "theirs.md"), "wip\n");
    const snap = await specSnapshot(root);
    promote(root);
    const c = await commitSpec(snap!, "m");
    assert.ok(c && "sha" in c);
    assert.ok(!c.files.includes(".sova/spec/claims/app/theirs.md"));
    assert.match(git(root, "status", "--porcelain"), /\?\? \.sova\/spec\/claims\/app\//);
  });

  test("a hook that refuses: skipped with git's first line; the files stay written", async () => {
    const root = repo();
    writeFileSync(join(root, ".git", "hooks", "pre-commit"), "#!/bin/sh\necho 'no commits today' >&2\nexit 1\n", { mode: 0o755 });
    const snap = await specSnapshot(root);
    promote(root);
    assert.deepEqual(await commitSpec(snap!, "m"), { skipped: "Not committed: no commits today" });
    assert.equal(readFileSync(join(root, ".sova", "spec", "manifest.json"), "utf8"), '{"claims":1}\n');
  });

  test("mid-merge or detached: skipped with the reason; not in git: no commit at all", async () => {
    const root = repo();
    git(root, "checkout", "-q", "-b", "side");
    commitIn(root, "README.md", "side\n");
    git(root, "checkout", "-q", "master");
    commitIn(root, "README.md", "master\n");
    try {
      git(root, "merge", "side");
    } catch {
      // the conflict is the point
    }
    const mid = await specSnapshot(root);
    promote(root);
    assert.deepEqual(await commitSpec(mid!, "m"), { skipped: "Not committed: the project root is in the middle of a merge." });
    git(root, "merge", "--abort");

    const det = repo();
    git(det, "checkout", "-q", "--detach");
    assert.deepEqual(await commitSpec((await specSnapshot(det))!, "m"), { skipped: "Not committed: the project root's checkout is on a detached HEAD." });

    const plain = join(tmp, "plain2");
    mkdirSync(plain);
    assert.equal(await specSnapshot(plain), null);
  });
});
