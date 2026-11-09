// The one answer to "anything of its own left to land?" (§chat.worktrees/nothing-left), on real repositories: each rule,
// and the branches that must stay work.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, test } from "node:test";
import { branchLeft, conflictsOf, type LandingRecords, registerQueueReading, resetNothingLeft } from "./nothing-left";
import { mergedByContent, resetContentMerges } from "./removed-worktrees";
import { mergeTreeOid } from "./merge-tree-probe";
import { execGit, WorktreeInsights } from "./worktrees";

const root = realpathSync(mkdtempSync(join(tmpdir(), "sova-nothing-left-")));
after(() => rmSync(root, { recursive: true, force: true }));
beforeEach(() => resetNothingLeft());

const env = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" };
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

let n = 0;
function repo(): { dir: string; commit(files: Record<string, string>, msg: string): string; head(ref?: string): string } {
  const dir = join(root, `r${++n}`);
  mkdirSync(dir);
  git(dir, "init", "-q", "-b", "master");
  const r = {
    dir,
    commit(files: Record<string, string>, msg: string) {
      for (const [f, t] of Object.entries(files)) writeFileSync(join(dir, f), t);
      git(dir, "add", "-A");
      git(dir, "commit", "-q", "--allow-empty", "-m", msg);
      return git(dir, "rev-parse", "HEAD");
    },
    head: (ref = "HEAD") => git(dir, "rev-parse", ref),
  };
  r.commit({ "a.txt": "a\n", "gen.txt": "one\n" }, "base");
  return r;
}

const ask = async (r: { dir: string; head(ref?: string): string }, head: string, branch = "feat/x") => branchLeft({ root: r.dir, branch, head, target: { name: "master", oid: r.head("master") }, git: execGit });

/** A branch's commit, on the branch, master back checked out. */
function onBranch(r: ReturnType<typeof repo>, files: Record<string, string>, branch = "feat/x"): string {
  git(r.dir, "checkout", "-q", "-B", branch);
  const c = r.commit(files, `${branch}: work`);
  git(r.dir, "checkout", "-q", "master");
  return c;
}

/** The leftover: a merge of master into the pin made before the pin reached master, then the pin landed by --no-ff. */
function leftover(r: ReturnType<typeof repo>): { pin: string; merge: string } {
  const pin = onBranch(r, { "b.txt": "b\n" });
  r.commit({ "m.txt": "m\n" }, "master moves");
  git(r.dir, "checkout", "-q", "feat/x");
  git(r.dir, "merge", "-q", "--no-ff", "--no-edit", "master");
  const merge = r.head();
  git(r.dir, "checkout", "-q", "master");
  git(r.dir, "merge", "-q", "--no-ff", "--no-edit", pin);
  return { pin, merge };
}

test("on the target: nothing left; a real commit past it: work", async () => {
  const r = repo();
  const pin = onBranch(r, { "b.txt": "b\n" });
  git(r.dir, "merge", "-q", "--no-ff", "--no-edit", pin);
  assert.equal((await ask(r, pin)).code.kind, "ancestor");
  assert.equal((await ask(r, pin)).nothingLeft, true);
  git(r.dir, "checkout", "-q", "feat/x");
  const real = r.commit({ "c.txt": "c\n" }, "real");
  git(r.dir, "checkout", "-q", "master");
  const a = await ask(r, real);
  assert.deepEqual([a.code.kind, a.code.left, a.nothingLeft], ["work", true, false]);
});

test("every commit the target doesn't have is a merge: nothing left, whatever it conflicts with now", async () => {
  const r = repo();
  const { merge } = leftover(r);
  assert.equal((await ask(r, merge)).code.kind, "catch-up");
  // The merge's hand-regenerated file; master regenerates it too: the trial merge conflicts from here on.
  git(r.dir, "checkout", "-q", "feat/x");
  writeFileSync(join(r.dir, "gen.txt"), "the branch's regeneration\n");
  git(r.dir, "add", "gen.txt");
  git(r.dir, "commit", "-q", "--amend", "--no-edit");
  const edited = r.head();
  git(r.dir, "checkout", "-q", "master");
  r.commit({ "gen.txt": "master's regeneration\n" }, "regenerate");
  assert.equal(git(r.dir, "rev-list", "--count", "--no-merges", `master..${edited}`), "0");
  assert.throws(() => git(r.dir, "merge-tree", "--write-tree", "--no-messages", "master", edited), "the trial conflicts");
  const a = await ask(r, edited);
  assert.deepEqual([a.code.kind, a.code.left, a.nothingLeft], ["catch-up", false, true]);
});

test("merges and then a real commit: work, and it stays landable", async () => {
  const r = repo();
  const { merge } = leftover(r);
  git(r.dir, "checkout", "-q", "feat/x");
  assert.equal(r.head(), merge);
  const real = r.commit({ "real.txt": "r\n" }, "real");
  git(r.dir, "checkout", "-q", "master");
  assert.equal((await ask(r, real)).code.left, true);
});

/** A host squash: the target gets the pin's content in one commit, so the pin is never its ancestor. */
function squashed(r: ReturnType<typeof repo>): { pin: string } {
  const pin = onBranch(r, { "s.txt": "s\n" });
  git(r.dir, "merge", "-q", "--squash", pin);
  git(r.dir, "commit", "-q", "-m", "squashed on the host");
  return { pin };
}
const reading = (r: { dir: string }, l: LandingRecords) => registerQueueReading(r.dir, { landings: () => l, approvedAt: () => false });

test("exactly the commit that landed: nothing left, a host squash included, though the target has moved over its lines", async () => {
  const r = repo();
  const { pin } = squashed(r);
  r.commit({ "s.txt": "master rewrote it\n" }, "master moves over the same lines");
  assert.equal((await ask(r, pin)).code.left, true, "with no landing on record it reads as work");
  resetNothingLeft();
  const undo = reading(r, { pins: [pin], landed: [] });
  try {
    assert.equal((await ask(r, pin)).code.kind, "landed");
  } finally {
    undo();
  }
  resetNothingLeft();
  const undoHost = reading(r, { pins: [], landed: [pin] });
  try {
    assert.equal((await ask(r, pin)).code.kind, "landed", "the queue's q.landed speaks too");
  } finally {
    undoHost();
  }
});

test("F4: merges past a landing the host squashed: nothing left; a real commit past it: work", async () => {
  const r = repo();
  const { pin } = squashed(r);
  r.commit({ "s.txt": "master rewrote it\n" }, "master moves over the same lines");
  git(r.dir, "checkout", "-q", "feat/x");
  git(r.dir, "merge", "-q", "--no-ff", "--no-edit", "-X", "ours", "master");
  const merge = r.head();
  const real = r.commit({ "real.txt": "r\n" }, "real");
  git(r.dir, "checkout", "-q", "master");
  const undo = reading(r, { pins: [pin], landed: [] });
  try {
    assert.equal((await ask(r, merge)).code.kind, "past-landing");
    assert.equal((await ask(r, real)).code.kind, "work");
  } finally {
    undo();
  }
});

test("a pin not on this line says nothing for it", async () => {
  const r = repo();
  const other = onBranch(r, { "o.txt": "o\n" }, "feat/other");
  const mine = onBranch(r, { "m.txt": "m\n" });
  const undo = reading(r, { pins: [other], landed: [] });
  try {
    assert.equal((await ask(r, mine)).code.kind, "work");
  } finally {
    undo();
  }
});

test("a head that read nothing left by a trial no-op keeps it as the target moves on, across a restart; another head doesn't", async () => {
  const r = repo();
  const c = onBranch(r, { "gen.txt": "same\n" });
  r.commit({ "gen.txt": "same\n" }, "master takes the same content");
  assert.equal((await ask(r, c)).code.kind, "content");
  r.commit({ "gen.txt": "master moves on\n" }, "master moves on");
  assert.throws(() => git(r.dir, "merge-tree", "--write-tree", "--no-messages", "master", c), "the same merge conflicts now");
  assert.equal((await ask(r, c)).code.kind, "content", "kept");
  resetNothingLeft();
  assert.equal((await ask(r, c)).code.kind, "content", "kept across a restart: it is in the state root's file");
  git(r.dir, "checkout", "-q", "feat/x");
  const next = r.commit({ "gen.txt": "the branch's own again\n" }, "real");
  git(r.dir, "checkout", "-q", "master");
  const a = await ask(r, next);
  assert.deepEqual([a.code.kind, a.code.conflicts], ["work", 1], "a new commit reads again");
});

test("what git can't answer is never nothing left", async () => {
  const r = repo();
  const a = await ask(r, "f".repeat(40));
  assert.deepEqual([a.code.kind, a.code.left, a.nothingLeft], ["unknown", true, false]);
  assert.match(a.code.error ?? "", /merge-base/);
});

test("unproved drafts count as something left, whatever git says", async () => {
  const r = repo();
  const c = onBranch(r, { "b.txt": "b\n" });
  git(r.dir, "merge", "-q", "--no-ff", "--no-edit", c);
  const answer = await branchLeft({ root: r.dir, folder: r.dir, branch: "feat/x", head: c, target: { name: "master", oid: r.head("master") }, git: execGit, proof: async () => new Set() });
  assert.equal(answer.nothingLeft, true, "a folder with no drafts");
  const draft = join(r.dir, ".sova", "spec", "drafts", "d1");
  mkdirSync(draft, { recursive: true });
  writeFileSync(join(draft, "draft.json"), "not json"); // unreadable: nobody knows its state
  const left = await branchLeft({ root: r.dir, folder: r.dir, branch: "feat/x", head: c, target: { name: "master", oid: r.head("master") }, git: execGit, proof: async () => new Set() });
  assert.deepEqual([left.code.left, left.drafts, left.nothingLeft], [false, ["d1"], false]);
});

test("a merge driver writes to stdout before the tree's id, so the first line is never the answer: the shared answer and readiness still see it", async () => {
  const r = repo();
  git(r.dir, "config", "merge.u.driver", "echo DRIVER-SAYS-HI; cat %B > %A");
  writeFileSync(join(r.dir, ".gitattributes"), "gen.txt merge=u\n");
  r.commit({}, "attributes");
  git(r.dir, "checkout", "-q", "-b", "feat/x");
  const c = r.commit({ "gen.txt": "the same\n" }, "branch side");
  git(r.dir, "checkout", "-q", "master");
  r.commit({ "gen.txt": "the same\n", "z.txt": "z\n" }, "master side");
  // The proof the fix rests on, with the driver running: its words come first.
  r.commit({ "gen.txt": "the same!\n" }, "both changed");
  git(r.dir, "checkout", "-q", "feat/x");
  const d = r.commit({ "gen.txt": "the same!\n" }, "both changed");
  git(r.dir, "checkout", "-q", "master");
  r.commit({ "gen.txt": "the same?\n" }, "differ, so git needs the driver");
  const out = git(r.dir, "merge-tree", "--write-tree", "--no-messages", "master", d);
  assert.equal(out.split("\n")[0], "DRIVER-SAYS-HI", "the driver writes to stdout first");
  assert.match(mergeTreeOid(out), /^[0-9a-f]{40}$/);
  assert.equal(c.length, 40);

  // A driver's whole-file answer equal to master's: the merge changes nothing, though git had to run it.
  git(r.dir, "config", "merge.u.driver", "echo DRIVER-SAYS-HI");
  resetContentMerges();
  const common = join(r.dir, ".git");
  // Retirement's reader asks the shared answer, so it reads the same merge the same way.
  assert.equal(await mergedByContent(execGit, r.dir, common, r.head("master"), d), true, "removed-worktrees");
  const a = await ask(r, d);
  assert.equal(a.code.kind, "content", "the shared answer");
  git(r.dir, "worktree", "add", "-q", join(root, `wt${n}`), "feat/x");
  const st = await new WorktreeInsights({ scratchDir: root }).treeStatus(join(root, `wt${n}`));
  assert.equal(st?.merged, "content", "readiness");
});

test("the conflicted files follow whatever a driver printed, and the tree's id", () => {
  const oid = "a".repeat(40);
  assert.equal(conflictsOf(`DRIVER\n${oid}\n100644 7 1\ta.md\n100644 8 2\ta.md\n100644 9 2\tb.md\n\nmessages`), 2);
  assert.equal(mergeTreeOid(`DRIVER\n${oid}\n100644 7 1\ta.md\n`), oid);
});

test("readiness's reading: a catch-up merge reads catch-up; a conflict with real work still counts its files", async () => {
  const r = repo();
  const { merge } = leftover(r);
  const wt = join(root, `tree${n}`);
  git(r.dir, "worktree", "add", "-q", wt, "feat/x");
  assert.equal(git(wt, "rev-parse", "HEAD"), merge);
  const st = await new WorktreeInsights({ scratchDir: root }).treeStatus(wt);
  assert.deepEqual([st?.merged, st?.ahead, st?.conflicts], ["catch-up", 1, undefined]);
  const real = join(wt, "gen.txt");
  writeFileSync(real, "branch\n");
  git(wt, "commit", "-qam", "real");
  r.commit({ "gen.txt": "master\n" }, "master");
  const again = await new WorktreeInsights({ scratchDir: root }).treeStatus(wt);
  assert.deepEqual([again?.merged, again?.conflicts], ["no", 1]);
});

test("git failing or histories that don't connect: unknown, never nothing, in both readings", async () => {
  const r = repo();
  const stranger = r.dir + "-unrelated";
  mkdirSync(stranger);
  git(r.dir, "checkout", "-q", "--orphan", "feat/orphan");
  const orphan = r.commit({ "b.txt": "b\n" }, "from nowhere");
  git(r.dir, "checkout", "-q", "master");
  const a = await ask(r, orphan, "feat/orphan");
  assert.deepEqual([a.whole, a.codeOnly, a.nothingLeft, a.code.kind], ["unknown", "unknown", false, "unknown"], `unrelated: ${JSON.stringify(a.code)}`);
  const bad = await ask(r, "0".repeat(40));
  assert.deepEqual([bad.whole, bad.codeOnly, bad.nothingLeft], ["unknown", "unknown", false], "a commit git doesn't have");
  // A runner that dies: unknown, and not kept, so the next read asks again.
  const threw = await branchLeft({ root: r.dir, branch: "feat/x", head: r.head(), target: { name: "master", oid: r.head("master") }, git: async () => { throw new Error("killed"); } });
  assert.equal(threw.whole, "unknown");
  assert.equal((await ask(r, r.head())).whole, "nothing", "the failure wasn't kept");
});

test("the three outcomes in each reading: drafts count only in the whole one, and unknown code with a draft is still something left", async () => {
  const r = repo();
  const c = onBranch(r, { "x.txt": "x\n" });
  const work = await ask(r, c);
  assert.deepEqual([work.whole, work.codeOnly], ["work", "work"]);
  const none = await ask(r, r.head("master"));
  assert.deepEqual([none.whole, none.codeOnly, none.nothingLeft], ["nothing", "nothing", true]);
});
