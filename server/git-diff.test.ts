import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { closeSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, unlinkSync, utimesSync, writeFileSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, before, describe, it } from "node:test";
import type { WorktreeMergeDetails } from "../pi-config/extensions/worktrees/state.ts";
import type { DiffScope } from "../shared/protocol";
import { DiffError, GitDiffs, knownFoldersOf, MAX_UNTRACKED_READ, PATCH_CAP, parseNumstatZ, parseRawZ, quotePath, scopeFromQuery, splitPatch } from "./git-diff";

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8" }).trim();

let root: string;
let repo: string;
let tree: string;
let outside: string;
let firstSha: string;
let secondSha: string;
const SESSION = "/fake/session.jsonl";

function diffs(roots: () => string[], trees: { path: string; baseBranch?: string; base?: string }[] = [], untrackedBudget?: number, merges: WorktreeMergeDetails[] = []) {
  return new GitDiffs({
    untrackedBudget,
    sessionKnown: async (p) =>
      p === SESSION ? { roots: roots(), trees: trees.map((t) => ({ branch: "x", base: "0", status: "active", session: "s", how: "created", at: 0, ...t }) as never), merges } : null,
  });
}

const lines = (n: number, tag = "line") => Array.from({ length: n }, (_, i) => `${tag} ${i + 1}`).join("\n") + "\n";

async function rejects(p: Promise<unknown>, status: number, re?: RegExp) {
  await assert.rejects(p, (err: unknown) => {
    assert.ok(err instanceof DiffError, String(err));
    assert.equal(err.status, status, err.message);
    if (re) assert.match(err.message, re);
    return true;
  });
}

before(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "sova-git-diff-")));
  repo = join(root, "repo");
  outside = join(root, "outside");
  mkdirSync(repo);
  mkdirSync(outside);
  git(repo, "init", "-q", "-b", "master");
  writeFileSync(join(repo, "keep.txt"), lines(20));
  writeFileSync(join(repo, "gone.txt"), "bye\n");
  writeFileSync(join(repo, "moved-from.txt"), lines(30, "stable"));
  writeFileSync(join(repo, "img.bin"), Buffer.from([0, 1, 2, 3, 0, 5]));
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "one");
  firstSha = git(repo, "rev-parse", "HEAD");
  // Second commit: an edit, a delete, a rename with an edit, a binary change, a path with spaces.
  writeFileSync(join(repo, "keep.txt"), lines(20).replace("line 5\n", "line five\n"));
  git(repo, "rm", "-q", "gone.txt");
  git(repo, "mv", "moved-from.txt", "moved to.txt");
  writeFileSync(join(repo, "moved to.txt"), lines(30, "stable").replace("stable 30\n", "stable thirty\n"));
  writeFileSync(join(repo, "img.bin"), Buffer.from([0, 9, 9, 9, 0, 5]));
  mkdirSync(join(repo, "dir with space"));
  writeFileSync(join(repo, "dir with space", "a b.txt"), "hello\nworld\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "two");
  secondSha = git(repo, "rev-parse", "HEAD");
  // A linked worktree on a branch with one commit past master.
  tree = join(root, "tree");
  git(repo, "worktree", "add", "-q", "-b", "feat/x", tree);
  writeFileSync(join(tree, "feature.ts"), "export const x = 1;\n");
  git(tree, "add", "-A");
  git(tree, "commit", "-q", "-m", "feature");
  // master moves on after the branch point: the merge-base keeps it out of the worktree diff.
  writeFileSync(join(repo, "later.txt"), "later\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "later");
});

after(() => rmSync(root, { recursive: true, force: true }));

describe("commit scope", () => {
  it("lists edits, deletes, renames, binaries and spaced paths against the first parent", async () => {
    const d = diffs(() => [repo]);
    const s = await d.summary({ kind: "commit", sessionPath: SESSION, repoPath: repo, sha: secondSha.slice(0, 10) });
    const by = new Map(s.files.map((f) => [f.path, f]));
    assert.equal(s.base.oid, firstSha);
    assert.equal(s.head.oid, secondSha);
    assert.equal(s.repo, repo);
    assert.deepEqual(
      s.files.map((f) => [f.path, f.status, f.added, f.removed, f.oldPath ?? null]).sort(),
      [
        ["dir with space/a b.txt", "A", 2, 0, null],
        ["gone.txt", "D", 0, 1, null],
        ["img.bin", "B", 0, 0, null],
        ["keep.txt", "M", 1, 1, null],
        ["moved to.txt", "R", 1, 1, "moved-from.txt"],
      ],
    );
    assert.deepEqual(s.totals, { files: 5, added: 4, removed: 3 });
    assert.ok(by.get("gone.txt")!.oldOid && !by.get("gone.txt")!.newOid);
    assert.ok(by.get("keep.txt")!.oldOid && by.get("keep.txt")!.newOid);
    assert.equal(s.truncated, undefined);
  });

  it("serves one file's patch, a rename's, a spaced path's and marks binaries", async () => {
    const d = diffs(() => [repo]);
    const scope: DiffScope = { kind: "commit", sessionPath: SESSION, repoPath: repo, sha: secondSha };
    const keep = await d.patch(scope, "keep.txt");
    assert.equal(keep.status, "M");
    assert.match(keep.patch!, /^diff --git a\/keep.txt b\/keep.txt\n/);
    assert.match(keep.patch!, /\n-line 5\n\+line five\n/);
    assert.equal(keep.patch!.match(/^diff --git /gm)!.length, 1);
    assert.equal(keep.oldOid!.length, 40);
    const moved = await d.patch(scope, "moved to.txt", "moved-from.txt");
    assert.equal(moved.status, "R");
    assert.equal(moved.oldPath, "moved-from.txt");
    assert.match(moved.patch!, /\+stable thirty/);
    const spaced = await d.patch(scope, "dir with space/a b.txt");
    assert.equal(spaced.status, "A");
    assert.match(spaced.patch!, /\n\+hello\n\+world\n/);
    const bin = await d.patch(scope, "img.bin");
    assert.equal(bin.binary, true);
    assert.equal(bin.patch, undefined);
    const gone = await d.patch(scope, "gone.txt");
    assert.equal(gone.status, "D");
    await rejects(d.patch(scope, "not-there.txt"), 404);
    await rejects(d.patch(scope, "../etc/passwd"), 400);
    await rejects(d.patch(scope, "/etc/passwd"), 400);
  });

  it("sends a file's old side with its patch only when asked, and only for a file in the diff", async () => {
    const d = diffs(() => [repo]);
    const scope: DiffScope = { kind: "commit", sessionPath: SESSION, repoPath: repo, sha: secondSha };
    assert.equal((await d.patch(scope, "keep.txt")).oldText, undefined);
    const keep = await d.patch(scope, "keep.txt", undefined, { context: true });
    assert.equal(keep.oldText, lines(20)); // the parent's, not the commit's ("line five")
    const moved = await d.patch(scope, "moved to.txt", "moved-from.txt", { context: true });
    assert.equal(moved.oldText, lines(30, "stable"));
    // No old side: an added file, a binary one.
    assert.equal((await d.patch(scope, "dir with space/a b.txt", undefined, { context: true })).oldText, undefined);
    assert.equal((await d.patch(scope, "img.bin", undefined, { context: true })).oldText, undefined);
    // A file the diff doesn't hold is refused, context or not.
    await rejects(d.patch(scope, "later.txt", undefined, { context: true }), 404);
    // There is no read by oid or by path any more.
    assert.equal("blobLines" in d, false);
  });

  it("diffs a root commit against the empty tree and refuses unknown shas", async () => {
    const d = diffs(() => [repo]);
    const s = await d.summary({ kind: "commit", sessionPath: SESSION, repoPath: repo, sha: firstSha });
    assert.equal(s.base.label, "Empty tree");
    assert.equal(s.base.oid, undefined);
    assert.equal(s.files.length, 4);
    await rejects(d.summary({ kind: "commit", sessionPath: SESSION, repoPath: repo, sha: "deadbeef" }), 404);
  });
});

describe("a removed merged worktree", () => {
  it("reads its commit from another known folder of the same repository", async () => {
    const gone = join(root, "gone-tree");
    git(repo, "worktree", "add", "-q", "-b", "feat/gone", gone);
    writeFileSync(join(gone, "merged.txt"), "m\n");
    git(gone, "add", "-A");
    git(gone, "commit", "-q", "-m", "merged");
    const sha = git(gone, "rev-parse", "HEAD");
    git(repo, "worktree", "remove", "--force", gone);
    const d = diffs(() => [outside, repo, gone]);
    const s = await d.summary({ kind: "commit", sessionPath: SESSION, repoPath: gone, sha });
    assert.equal(s.repo, repo);
    assert.deepEqual(s.files.map((f) => f.path), ["merged.txt"]);
    // Only a commit scope falls back, and only to a folder that has the commit.
    await rejects(d.summary({ kind: "dirty", sessionPath: SESSION, cwd: gone }), 404);
    await rejects(diffs(() => [outside, gone]).summary({ kind: "commit", sessionPath: SESSION, repoPath: gone, sha }), 404);
    // Still no folder outside what the session knows.
    await rejects(diffs(() => [repo]).summary({ kind: "commit", sessionPath: SESSION, repoPath: gone, sha }), 400);
  });
});

describe("worktree scope", () => {
  it("compares the branch with its merge-base, not with master's tip", async () => {
    const d = diffs(() => [repo, tree]);
    const s = await d.summary({ kind: "worktree", sessionPath: SESSION, worktreePath: tree });
    assert.deepEqual(s.files.map((f) => f.path), ["feature.ts"]);
    assert.equal(s.base.label, "master (merge-base)");
    assert.equal(s.base.oid, secondSha);
    assert.equal(s.head.label, "feat/x");
  });

  it("uses the tracked worktree's baseBranch when it exists", async () => {
    git(repo, "branch", "-f", "release", firstSha);
    const d = diffs(() => [tree], [{ path: tree, baseBranch: "release" }]);
    const s = await d.summary({ kind: "worktree", sessionPath: SESSION, worktreePath: tree });
    assert.equal(s.base.label, "release (merge-base)");
    assert.equal(s.base.oid, firstSha);
    assert.ok(s.files.some((f) => f.path === "feature.ts") && s.files.some((f) => f.path === "keep.txt"));
  });
});

describe("worktree scope once merged", () => {
  let n = 0;
  /** A fresh repository with master at one commit, and a tracked worktree on feat/m with one commit of its own. */
  function setup() {
    const dir = join(root, `merged-${++n}`);
    const main = join(dir, "main");
    const wt = join(dir, "wt");
    mkdirSync(main, { recursive: true });
    git(main, "init", "-q", "-b", "master");
    writeFileSync(join(main, "a.txt"), "a\n");
    git(main, "add", "-A");
    git(main, "commit", "-q", "-m", "c0");
    const c0 = git(main, "rev-parse", "HEAD");
    git(main, "worktree", "add", "-q", "-b", "feat/m", wt);
    const commit = (cwd: string, file: string) => {
      writeFileSync(join(cwd, file), `${file}\n`);
      git(cwd, "add", "-A");
      git(cwd, "commit", "-q", "-m", file);
      return git(cwd, "rev-parse", "HEAD");
    };
    commit(wt, "f1.txt");
    const d = (base = c0) => diffs(() => [wt], [{ path: wt, baseBranch: "master", base }]);
    const scope: DiffScope = { kind: "worktree", sessionPath: SESSION, worktreePath: wt };
    return { main, wt, c0, commit, d, scope };
  }
  const names = (cwd: string, a: string, b: string) => git(cwd, "diff", "--name-only", a, b).split("\n").filter(Boolean);

  it("shows what the merge commit brought in, named by that commit", async () => {
    const { main, commit, d, scope } = setup();
    commit(main, "m1.txt");
    git(main, "merge", "-q", "--no-ff", "--no-edit", "feat/m");
    const landing = git(main, "rev-parse", "HEAD");
    const s = await d().summary(scope);
    assert.deepEqual(s.files.map((f) => f.path), ["f1.txt"]);
    assert.deepEqual(s.files.map((f) => f.path), names(main, `${landing}^1`, landing));
    assert.equal(s.base.label, `master before ${landing.slice(0, 7)}`);
    assert.equal(s.head.label, "feat/m");
  });

  it("leaves out master's work merged into the branch before it landed", async () => {
    const { main, wt, commit, d, scope } = setup();
    commit(main, "m1.txt");
    git(wt, "merge", "-q", "--no-edit", "master");
    commit(main, "m2.txt");
    git(main, "merge", "-q", "--no-ff", "--no-edit", "feat/m");
    const landing = git(main, "rev-parse", "HEAD");
    const s = await d().summary(scope);
    assert.deepEqual(s.files.map((f) => f.path), ["f1.txt"]);
    assert.equal(s.base.label, `master before ${landing.slice(0, 7)}`);
  });

  it("after a fast-forward, compares against the tracked base when it is an ancestor, else stays empty", async () => {
    const { main, wt, c0, d, scope } = setup();
    git(main, "merge", "-q", "--ff-only", "feat/m");
    const s = await d().summary(scope);
    assert.deepEqual(s.files.map((f) => f.path), ["f1.txt"]);
    assert.equal(s.base.label, `${c0.slice(0, 7)} (created from)`);
    assert.equal(s.base.oid, c0);
    // No usable tracked base: today's empty comparison.
    const none = await d("0").summary(scope);
    assert.deepEqual(none.files, []);
    assert.equal(none.base.label, "master (merge-base)");
    // No commits beyond the tracked base: empty.
    const head = git(wt, "rev-parse", "HEAD");
    const own = await d(head).summary(scope);
    assert.deepEqual(own.files, []);
    assert.equal(own.base.label, "master (merge-base)");
  });

  it("with new commits after the merge, shows only those", async () => {
    const { main, wt, commit, d, scope } = setup();
    commit(main, "m1.txt");
    git(main, "merge", "-q", "--no-ff", "--no-edit", "feat/m");
    const landing = git(main, "rev-parse", "HEAD");
    git(wt, "merge", "-q", "--ff-only", "master");
    commit(wt, "f2.txt");
    const s = await d().summary(scope);
    assert.deepEqual(s.files.map((f) => f.path), ["f2.txt"]);
    assert.equal(s.base.label, "master (merge-base)");
    assert.equal(s.base.oid, landing);
  });
});

describe("merge scope", () => {
  let n = 0;
  /** A fresh repository with master at one commit, and a worktree on feat/m with `files` committed one by one. */
  function setup(files: string[]) {
    const dir = join(root, `merge-scope-${++n}`);
    const main = join(dir, "main");
    const wt = join(dir, "wt");
    mkdirSync(main, { recursive: true });
    git(main, "init", "-q", "-b", "master");
    writeFileSync(join(main, "a.txt"), "a\n");
    git(main, "add", "-A");
    git(main, "commit", "-q", "-m", "c0");
    const c0 = git(main, "rev-parse", "HEAD");
    git(main, "worktree", "add", "-q", "-b", "feat/m", wt);
    const commit = (cwd: string, file: string) => {
      writeFileSync(join(cwd, file), `${file}\n`);
      git(cwd, "add", "-A");
      git(cwd, "commit", "-q", "-m", file);
      return git(cwd, "rev-parse", "HEAD");
    };
    for (const f of files) commit(wt, f);
    const card = (sha: string, fastForward: boolean, path = wt): WorktreeMergeDetails => ({ version: 1, path, branch: "feat/m", target: "master", sha, commits: files.length, added: 0, removed: 0, fastForward, how: "tool" });
    const scope = (sha: string, repoPath = wt): DiffScope => ({ kind: "merge", sessionPath: SESSION, repoPath, sha });
    return { main, wt, c0, commit, card, scope };
  }

  it("shows a merge commit against its first parent, headed by the branch", async () => {
    const { main, wt, commit, card, scope } = setup(["f1.txt", "f2.txt"]);
    commit(main, "m1.txt");
    git(main, "merge", "-q", "--no-ff", "--no-edit", "feat/m");
    const landing = git(main, "rev-parse", "HEAD");
    const s = await diffs(() => [main, wt], [], undefined, [card(landing, false)]).summary(scope(landing));
    assert.deepEqual(s.files.map((f) => f.path), ["f1.txt", "f2.txt"]);
    assert.equal(s.base.oid, git(main, "rev-parse", `${landing}^1`));
    assert.equal(s.base.label, `master before ${landing.slice(0, 7)}`);
    assert.equal(s.head.label, "feat/m");
    assert.equal(s.head.oid, landing);
  });

  it("shows every commit a fast-forward brought, from the tracked base", async () => {
    const { main, wt, c0, card, scope } = setup(["f1.txt", "f2.txt", "f3.txt"]);
    git(main, "merge", "-q", "--ff-only", "feat/m");
    const tip = git(main, "rev-parse", "HEAD");
    const tracked = [{ path: wt, baseBranch: "master", base: c0 }];
    const s = await diffs(() => [main, wt], tracked, undefined, [card(tip, true)]).summary(scope(tip));
    assert.deepEqual(s.files.map((f) => f.path), ["f1.txt", "f2.txt", "f3.txt"]);
    assert.equal(s.totals.added, 3);
    assert.equal(s.base.oid, c0);
    assert.equal(s.base.label, `${c0.slice(0, 7)} (created from)`);
    assert.equal(s.head.label, "feat/m");
    // The commit scope on the same sha is only the tip commit: the case this scope exists for.
    const c = await diffs(() => [main, wt]).summary({ kind: "commit", sessionPath: SESSION, repoPath: wt, sha: tip });
    assert.deepEqual(c.files.map((f) => f.path), ["f3.txt"]);
    // No usable tracked base (none, not an ancestor, or the tip itself): the tip's first parent.
    for (const t of [[], [{ path: wt, base: "0".repeat(40) }], [{ path: wt, base: tip }]]) {
      const f = await diffs(() => [main, wt], t, undefined, [card(tip, true)]).summary(scope(tip));
      assert.deepEqual(f.files.map((x) => x.path), ["f3.txt"]);
      assert.equal(f.base.label, `${tip.slice(0, 7)}^1`);
    }
  });

  it("reads a removed worktree's merge from another known folder", async () => {
    const { main, wt, c0, card, scope } = setup(["f1.txt", "f2.txt", "f3.txt"]);
    git(main, "merge", "-q", "--ff-only", "feat/m");
    const tip = git(main, "rev-parse", "HEAD");
    git(main, "worktree", "remove", "--force", wt);
    const s = await diffs(() => [main, wt], [{ path: wt, base: c0 }], undefined, [card(tip, true)]).summary(scope(tip));
    assert.equal(s.repo, main);
    assert.deepEqual(s.files.map((f) => f.path), ["f1.txt", "f2.txt", "f3.txt"]);
    const p = await diffs(() => [main, wt], [{ path: wt, base: c0 }], undefined, [card(tip, true)]).patch(scope(tip), "f2.txt");
    assert.match(p.patch ?? "", /\+f2\.txt/);
  });

  it("refuses a sha that is not a merge card in the session, before any git runs", async () => {
    const { main, wt, c0, card, scope } = setup(["f1.txt"]);
    git(main, "merge", "-q", "--ff-only", "feat/m");
    const tip = git(main, "rev-parse", "HEAD");
    let ran = 0;
    const counting = (merges: WorktreeMergeDetails[]) =>
      new GitDiffs({
        run: async () => {
          ran++;
          return { code: 0, stdout: Buffer.alloc(0), stderr: "", cut: false };
        },
        sessionKnown: async () => ({ roots: [main, wt], trees: [], merges }),
      });
    // A real commit, but no card names it.
    await rejects(counting([card(tip, true)]).summary(scope(c0)), 400, /not a merge this session recorded/);
    // The card's sha, but another folder.
    await rejects(counting([card(tip, true)]).summary(scope(tip, main)), 400, /not a merge this session recorded/);
    // No cards at all.
    await rejects(counting([]).summary(scope(tip)), 400, /not a merge this session recorded/);
    // An abbreviated sha is not the card's sha.
    await rejects(counting([card(tip, true)]).summary(scope(tip.slice(0, 10))), 400, /not a merge this session recorded/);
    assert.equal(ran, 0);
    // Still no folder outside what the session knows, card or not.
    await rejects(diffs(() => [main], [], undefined, [card(tip, true)]).summary(scope(tip)), 400, /not one this session knows/);
  });

  it("reads merge cards and their folders from the session file", () => {
    const details = { version: 1, path: "/w/wt", branch: "feat/m", target: "master", sha: "a".repeat(40), commits: 3, added: 1, removed: 0, fastForward: true, how: "tool" };
    const text = [
      JSON.stringify({ type: "session", version: 3, id: "s", timestamp: "t", cwd: "/w/main" }),
      JSON.stringify({ type: "custom_message", customType: "worktree-merge", content: "Merged", display: true, details }),
      JSON.stringify({ type: "custom_message", customType: "worktree-merge", content: "Merged", display: true, details: { ...details, sha: 1 } }),
    ].join("\n");
    const k = knownFoldersOf(text);
    assert.deepEqual(k.merges, [details]);
    assert.ok(k.roots.includes("/w/wt"));
  });
});

describe("dirty scope", () => {
  it("shows staged, unstaged and untracked changes against HEAD, and drops stat-only changes", async () => {
    const d = diffs(() => [tree]);
    const scope: DiffScope = { kind: "dirty", sessionPath: SESSION, cwd: join(tree, "dir with space") };
    const clean = await d.summary(scope);
    assert.deepEqual(clean.files, []);
    assert.equal(clean.head.label, "Working tree");
    // Touch without changing content: stat-dirty, not a change.
    const t = statSync(join(tree, "keep.txt"));
    writeFileSync(join(tree, "keep.txt"), readFileSync(join(tree, "keep.txt")));
    utimesSync(join(tree, "keep.txt"), t.atime, new Date(t.mtimeMs + 5000));
    writeFileSync(join(tree, "feature.ts"), "export const x = 2;\n");
    writeFileSync(join(tree, "staged.txt"), "s\n");
    git(tree, "add", "staged.txt");
    writeFileSync(join(tree, "new file.txt"), "a\nb\nc");
    writeFileSync(join(tree, "blob.dat"), Buffer.from([1, 0, 2]));
    symlinkSync("keep.txt", join(tree, "link"));
    const indexFile = git(tree, "rev-parse", "--git-path", "index");
    const indexBefore = readFileSync(resolve(tree, indexFile));
    const s = await d.summary(scope);
    await d.patch(scope, "feature.ts");
    // Read-only: the stat-dirty keep.txt would make any index refresh rewrite the index.
    assert.ok(readFileSync(resolve(tree, indexFile)).equals(indexBefore), "the index was rewritten");
    assert.equal(s.repo, tree);
    assert.deepEqual(
      s.files.map((f) => [f.path, f.status, f.added, f.removed, f.untracked ?? false]),
      [
        ["blob.dat", "B", 0, 0, true],
        ["feature.ts", "M", 1, 1, false],
        ["link", "A", 1, 0, true],
        ["new file.txt", "A", 3, 0, true],
        ["staged.txt", "A", 1, 0, false],
      ],
    );
    const unt = await d.patch(scope, "new file.txt");
    assert.equal(unt.status, "A");
    assert.equal(unt.patch, 'diff --git a/new file.txt b/new file.txt\nnew file mode 100644\n--- /dev/null\n+++ b/new file.txt\n@@ -0,0 +1,3 @@\n+a\n+b\n+c\n\\ No newline at end of file\n');
    assert.equal((await d.patch(scope, "blob.dat")).binary, true);
    const feat = await d.patch(scope, "feature.ts");
    assert.match(feat.patch!, /\n-export const x = 1;\n\+export const x = 2;\n/);
    assert.ok(feat.oldOid && !feat.newOid); // the working-tree side is not hashed
    // The old side is HEAD's blob, never the working tree.
    assert.equal((await d.patch(scope, "feature.ts", undefined, { context: true })).oldText, "export const x = 1;\n");
    // A gitignored file (a secret, say) is not in the diff, so nothing of it is sent.
    writeFileSync(join(tree, ".gitignore"), ".env\n");
    writeFileSync(join(tree, ".env"), "TOKEN=secret\n");
    await rejects(d.patch(scope, ".env", undefined, { context: true }), 404);
    assert.ok(!(await d.summary(scope)).files.some((f) => f.path === ".env"));
    unlinkSync(join(tree, ".env"));
    unlinkSync(join(tree, ".gitignore"));
    await rejects(d.patch(scope, "keep.txt"), 404);
  });

  it("marks a huge file's patch tooLarge instead of sending it", async () => {
    const d = diffs(() => [tree]);
    const scope: DiffScope = { kind: "dirty", sessionPath: SESSION, cwd: tree };
    writeFileSync(join(tree, "keep.txt"), lines(Math.ceil((PATCH_CAP * 1.5) / 10), "xxxxxx"));
    const s = await d.summary(scope);
    assert.ok(s.files.find((f) => f.path === "keep.txt")!.added > 100_000);
    const p = await d.patch(scope, "keep.txt");
    assert.equal(p.patch, undefined);
    assert.equal(p.tooLarge!.cap, PATCH_CAP);
    assert.equal(p.status, "M");
    writeFileSync(join(tree, "huge-new.txt"), lines(Math.ceil((PATCH_CAP * 1.5) / 10), "yyyyyy"));
    const u = await d.patch(scope, "huge-new.txt");
    assert.ok(u.tooLarge && u.patch === undefined);
    unlinkSync(join(tree, "huge-new.txt"));
    git(tree, "checkout", "-q", "--", "keep.txt");
  });

  it("reads an untracked file only up to its cap, and stops reading at the summary's budget", async () => {
    // A repository of its own: no other untracked file shares the budget.
    const own = join(root, "bounds");
    mkdirSync(own);
    git(own, "init", "-q", "-b", "master");
    writeFileSync(join(own, "x"), "x\n");
    git(own, "add", "-A");
    git(own, "commit", "-q", "-m", "x");
    const scope: DiffScope = { kind: "dirty", sessionPath: SESSION, cwd: own };
    const dir = join(own, "untracked-bounds");
    mkdirSync(dir);
    try {
      // Text lines at the head, a sparse hole, and more lines far past the cap: a full read
      // would count the tail too.
      const head = lines(1000, "head");
      const big = join(dir, "big.log");
      const fd = openSync(big, "w");
      writeSync(fd, head, 0);
      writeSync(fd, lines(50, "tail"), 64 * 1024 * 1024);
      closeSync(fd);
      const s = await diffs(() => [own]).summary(scope);
      const row = s.files.find((f) => f.path === "untracked-bounds/big.log")!;
      assert.equal(row.tooLarge, true);
      assert.equal(row.status, "A");
      assert.equal(row.added, 1001); // head's lines, plus the zeros read up to the cap as one line
      assert.ok(statSync(big).size > MAX_UNTRACKED_READ);
      unlinkSync(big);

      // A budget of 25 bytes: a.txt (10 bytes) and b.txt (10) fit, c.txt gets 5 bytes, d.txt none.
      for (const n of ["a", "b", "c", "d"]) writeFileSync(join(dir, `${n}.txt`), "1234\n6789\n");
      const t = await diffs(() => [own], [], 25).summary(scope);
      const got = Object.fromEntries(t.files.filter((f) => f.path.startsWith("untracked-bounds/")).map((f) => [f.path.slice(17), [f.added, f.tooLarge ?? false]]));
      assert.deepEqual(got, { "a.txt": [2, false], "b.txt": [2, false], "c.txt": [1, true], "d.txt": [0, true] });
      // The patch reads the file on its own, not under the summary's budget.
      assert.match((await diffs(() => [own], [], 25).patch(scope, "untracked-bounds/d.txt")).patch!, /\+1234\n\+6789\n$/);
    } finally {
      rmSync(own, { recursive: true, force: true });
    }
  });
});

describe("trust", () => {
  it("refuses folders the session does not know, unknown sessions and bad scopes", async () => {
    const d = diffs(() => [tree]);
    await rejects(d.summary({ kind: "dirty", sessionPath: SESSION, cwd: repo }), 400, /not one this session knows/);
    await rejects(d.summary({ kind: "dirty", sessionPath: SESSION, cwd: outside }), 400);
    await rejects(d.summary({ kind: "dirty", sessionPath: SESSION, cwd: `${tree}/../repo` }), 400);
    await rejects(d.summary({ kind: "dirty", sessionPath: SESSION, cwd: "relative/path" }), 400);
    await rejects(d.summary({ kind: "dirty", sessionPath: "/other.jsonl", cwd: tree }), 400, /Unknown session/);
    // A symlink inside a known folder that leads out of it is judged by where it leads.
    symlinkSync(repo, join(tree, "escape"));
    await rejects(d.summary({ kind: "dirty", sessionPath: SESSION, cwd: join(tree, "escape") }), 400);
    unlinkSync(join(tree, "escape"));
    // A known folder that is not a repository.
    await rejects(diffs(() => [outside]).summary({ kind: "dirty", sessionPath: SESSION, cwd: outside }), 400, /not in a git work tree/);
  });

  it("parses scopes from a query and never accepts a free-form ref", () => {
    const q = (o: Record<string, string>) => (n: string) => o[n];
    assert.deepEqual(scopeFromQuery(q({ kind: "commit", session: "s", path: "/p", sha: "ABCDEF1" })), { kind: "commit", sessionPath: "s", repoPath: "/p", sha: "abcdef1" });
    for (const sha of ["HEAD", "master", "abc", "--output=x", "abcdef1^"]) assert.throws(() => scopeFromQuery(q({ kind: "commit", session: "s", path: "/p", sha })), DiffError);
    assert.deepEqual(scopeFromQuery(q({ kind: "merge", session: "s", path: "/p", sha: "ABCDEF1" })), { kind: "merge", sessionPath: "s", repoPath: "/p", sha: "abcdef1" });
    for (const sha of ["HEAD", "master", "abcdef1^"]) assert.throws(() => scopeFromQuery(q({ kind: "merge", session: "s", path: "/p", sha })), DiffError);
    assert.throws(() => scopeFromQuery(q({ kind: "tree", session: "s", path: "/p" })), DiffError);
    assert.throws(() => scopeFromQuery(q({ kind: "dirty", path: "/p" })), DiffError);
  });
});

describe("session folders", () => {
  it("reads the header cwd, worker cwds, tracked worktrees and merge card paths", () => {
    const text = [
      JSON.stringify({ type: "session", version: 3, id: "s", cwd: "/w/main" }),
      JSON.stringify({ type: "custom", customType: "worktrees", data: { version: 1, trees: [{ path: "/w/t1", branch: "feat/a", base: "abc", baseBranch: "master", status: "active", session: "s", how: "created", at: 1 }] } }),
      JSON.stringify({ type: "custom_message", customType: "worktree-merge", display: true, content: "m", details: { version: 1, path: "/w/t0", branch: "feat/z", target: "master", sha: "a".repeat(40), commits: 1, added: 1, removed: 0, fastForward: true, how: "tool" } }),
      JSON.stringify({ type: "message", message: { role: "user", content: "about /w/nope worktree" } }),
    ].join("\n");
    const k = knownFoldersOf(text);
    assert.deepEqual(k.roots.sort(), ["/w/main", "/w/t0", "/w/t1"]);
    assert.equal(k.trees[0]!.baseBranch, "master");
  });
});

describe("parsers", () => {
  it("parses -z raw and numstat output, renames included", () => {
    const raw = `:100644 100644 ${"a".repeat(40)} ${"b".repeat(40)} R090\0old name\0new name\0:000000 100644 ${"0".repeat(40)} ${"c".repeat(40)} A\0x\0`;
    assert.deepEqual(parseRawZ(raw).map((e) => [e.status, e.path, e.oldPath]), [["R", "new name", "old name"], ["A", "x", undefined]]);
    const num = parseNumstatZ("1\t2\t\0old name\0new name\0-\t-\timg\0");
    assert.deepEqual([...num], [["new name", { added: 1, removed: 2, binary: false }], ["img", { added: 0, removed: 0, binary: true }]]);
  });

  it("names patch sections by their ---/+++ and rename lines, quoted paths included", () => {
    const p = quotePath('a/q"t\tx');
    assert.equal(p, '"a/q\\"t\\tx"');
    const text = `diff --git ${p} ${quotePath('b/q"t\tx')}\nindex ${"1".repeat(40)}..${"2".repeat(40)} 100644\n--- ${p}\n+++ ${quotePath('b/q"t\tx')}\n@@ -1 +1 @@\n-a\n+b\ndiff --git a/same same b/same same\nnew file mode 100644\nindex ${"0".repeat(40)}..${"3".repeat(40)}\n`;
    const s = splitPatch(text);
    assert.deepEqual(s.map((x) => [x.path, x.oldPath, x.status]), [['q"t\tx', 'q"t\tx', "M"], ["same same", "same same", "A"]]);
    assert.equal(s[1]!.oldOid, undefined);
  });
});
