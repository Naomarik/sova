// Discard Branch… at its edges, real git in a scratch repository (server/worktree-remove-discard.ts): what lies outside the
// worktree never goes with it, and a branch git still ties to another folder (a second checkout, a stale registration)
// is settled before anything is deleted, never left as a partial stop that took a folder for nothing.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { runGit } from "../pi-config/extensions/worktrees/git.ts";
import { scratchRoot } from "./test-scratch";
import { type DiscardDeps, DiscardRefused, discardBranch, previewDiscard } from "./worktree-remove-discard";
import { leftovers, leftoversDigest, removeAnywayOf, unreadableLeftovers } from "./worktree-leftovers";
import { dropLock, takeLock } from "./worktree-retire";

const root = scratchRoot("sova-discard-race-");
const main = join(root, "repo");
const outside = join(root, "outside");
const env = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" };
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const write = (path: string, text: string) => {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, text);
};
const branchExists = (b: string) => {
  try {
    git(main, "rev-parse", "--verify", "-q", `refs/heads/${b}`);
    return true;
  } catch {
    return false;
  }
};
const listed = (folder: string) => git(main, "worktree", "list", "--porcelain").split("\n").some((l) => l === `worktree ${folder}`);

function branch(name: string): { branch: string; commit: string; folder: string } {
  const b = `feat/${name}`;
  const folder = join(root, ".worktrees", `repo-${name}`);
  git(main, "worktree", "add", "-q", "-b", b, folder, "master");
  write(join(folder, `${name}.txt`), `${name}\n`);
  git(folder, "add", "-A");
  git(folder, "commit", "-q", "-m", `work on ${name}`);
  return { branch: b, commit: git(folder, "rev-parse", "HEAD"), folder };
}

before(() => {
  mkdirSync(main, { recursive: true });
  git(main, "init", "-q", "-b", "master");
  write(join(main, ".gitignore"), "node_modules/\n*.env\n");
  write(join(main, "a.txt"), "a\n");
  git(main, "add", "-A");
  git(main, "commit", "-q", "-m", "init");
  write(join(outside, "keep.txt"), "outside\n");
  write(join(outside, "dir", "deep.txt"), "deep\n");
});
after(() => rmSync(root, { recursive: true, force: true }));

/** Real git, real listing and digest, real lock; no chat, no queue, no processes. */
function deps(): DiscardDeps {
  return {
    git: runGit,
    target: async () => "master",
    openEntry: async () => null,
    owner: async () => null,
    chatBusy: () => false,
    workingSubagents: () => 0,
    uses: async () => ({ uses: [], unreadable: [] }),
    folderChats: async () => [],
    processes: async () => [],
    alive: () => false,
    leftovers: (folder) => leftovers(folder).catch(unreadableLeftovers),
    digestOf: leftoversDigest,
    listingOf: removeAnywayOf,
    draftNames: () => [],
    withAnyway: async (_f, _d, fn) => fn(),
    lockFile: async () => join(root, "sova-retire.lock"),
    takeLock: (f) => takeLock(f),
    dropLock: (f) => dropLock(f),
    archive: async () => ({ ok: true }),
    close: async () => undefined,
    now: () => Date.now(),
  };
}

/** The dry run, then the confirm with its digest: the result, or the refusal's code and words. */
async function discard(b: { branch: string; commit: string }) {
  const d = deps();
  const req = { root: main, branch: b.branch, commit: b.commit };
  const p = await previewDiscard(req, d);
  try {
    return { preview: p, result: await discardBranch(req, p.digest, d) };
  } catch (err) {
    if (err instanceof DiscardRefused) return { preview: p, refused: err };
    throw err;
  }
}

describe("Discard Branch…: nothing outside the worktree goes with it", () => {
  test("symlinks to a file and a folder outside are removed as links; what they point at stays", async () => {
    const b = branch("links");
    symlinkSync(join(outside, "keep.txt"), join(b.folder, "file-link"));
    symlinkSync(join(outside, "dir"), join(b.folder, "dir-link"));
    // Ignored too, so the forced removal is what deletes them.
    symlinkSync(join(outside, "dir"), join(b.folder, "node_modules"));
    symlinkSync(join(outside, "keep.txt"), join(b.folder, "x.env"));
    const r = await discard(b);
    assert.equal(r.refused, undefined, r.refused?.message);
    assert.equal(r.result?.outcome, "discarded", JSON.stringify(r.result));
    assert.ok(!existsSync(b.folder), "the worktree's folder is gone");
    assert.equal(readFileSync(join(outside, "keep.txt"), "utf8"), "outside\n");
    assert.equal(readFileSync(join(outside, "dir", "deep.txt"), "utf8"), "deep\n");
    assert.ok(!branchExists(b.branch));
  });
});

describe("Discard Branch…: a branch git ties to another folder is settled before anything is deleted", () => {
  test("checked out in a second worktree too: refused up front, both folders and the branch stay", async () => {
    const b = branch("twice");
    const second = join(root, ".worktrees", "repo-twice-2");
    git(main, "worktree", "add", "-q", "-f", second, b.branch);
    write(join(second, "precious.txt"), "mine\n");
    const r = await discard(b);
    assert.ok(r.preview.refused, "the dry run says why it can't run");
    assert.equal(r.refused?.code, "refused", JSON.stringify(r.result ?? r.preview));
    assert.ok(existsSync(b.folder), "the first folder stays");
    assert.ok(existsSync(join(second, "precious.txt")), "the second folder stays");
    assert.ok(branchExists(b.branch));
  });

  test("a registration whose folder is gone: never a partial that blames another folder", async () => {
    const b = branch("stale");
    rmSync(b.folder, { recursive: true, force: true });
    const r = await discard(b);
    if (r.refused) {
      // Refused up front: nothing changed, and the words don't claim another folder holds it.
      assert.ok(!/Another folder/.test(r.refused.message), r.refused.message);
      assert.ok(branchExists(b.branch));
    } else {
      // Or settled: the stale registration dropped, then the branch deleted.
      assert.equal(r.result?.outcome, "discarded", JSON.stringify(r.result));
      assert.ok(!listed(b.folder), "git no longer lists the gone folder");
      assert.ok(!branchExists(b.branch));
    }
  });
});
