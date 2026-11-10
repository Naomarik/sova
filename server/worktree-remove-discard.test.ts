// Discard Branch… at git level (server/worktree-remove-discard.ts): each refusal leaves everything, before and under the
// lock; a confirm goes folder → branch → chat, deleting only the listing the user saw, with no backup of the branch.
// Real git in a scratch repository; the chats, the queue and the processes are stood in.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { type Git, runGit } from "../pi-config/extensions/worktrees/git.ts";
import { scratchRoot } from "./test-scratch";
import { DISCARD_WORDS, type DiscardDeps, type DiscardOwner, DiscardRefused, discardBranch, previewDiscard, process_words } from "./worktree-remove-discard";
import { leftovers, leftoversDigest, removeAnywayOf, unreadableLeftovers } from "./worktree-leftovers";
import { dropLock, takeLock } from "./worktree-retire";
import type { ChatUse } from "./worktree-cleanup";

const root = scratchRoot("sova-discard-");
const main = join(root, "repo");
const env = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" };
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const folderOf = (name: string) => join(root, ".worktrees", `repo-${name}`);
const write = (path: string, text: string) => {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, text);
};
const exists = (ref: string) => {
  try {
    git(main, "rev-parse", "--verify", "-q", ref);
    return true;
  } catch {
    return false;
  }
};

/** A branch feat/<name> with one commit of its own, in its own folder unless `folder` is false. */
function branch(name: string, o: { folder?: boolean } = {}): { branch: string; commit: string; folder: string } {
  const b = `feat/${name}`;
  const folder = folderOf(name);
  if (o.folder === false) {
    const c1 = git(main, "commit-tree", "-m", `start ${name}`, "-p", "master", "master^{tree}");
    const c = git(main, "commit-tree", "-m", `work on ${name}`, "-p", c1, "master^{tree}");
    git(main, "branch", b, c);
    return { branch: b, commit: c, folder };
  }
  git(main, "worktree", "add", "-q", "-b", b, folder, "master");
  write(join(folder, `${name}.txt`), `${name}\n`);
  git(folder, "add", "-A");
  git(folder, "commit", "-q", "-m", `work on ${name}`);
  return { branch: b, commit: git(folder, "rev-parse", "HEAD"), folder };
}

before(() => {
  mkdirSync(main, { recursive: true });
  git(main, "init", "-q", "-b", "master");
  write(join(main, ".gitignore"), ".sova/spec/drafts/\nnode_modules/\n");
  write(join(main, "a.txt"), "a\n");
  git(main, "add", "-A");
  git(main, "commit", "-q", "-m", "init");
});
after(() => rmSync(root, { recursive: true, force: true }));

const OWNER: DiscardOwner = { id: "s1", title: "Build x", path: "/sessions/s1.jsonl", archived: false, tui: false };

interface World {
  log: string[];
  deps: DiscardDeps;
}

/** The deps over real git, every call logged in order; the rest stood in, quiet by default. */
function world(opts: Partial<DiscardDeps> & { chat?: DiscardOwner | null; failRemove?: boolean } = {}): World {
  const { chat, failRemove, ...o } = opts;
  const log: string[] = [];
  const g: Git = async (args, cwd) => {
    if (args[0] === "update-ref" || args.includes("update-ref") || args.includes("remove")) log.push(`git ${args.filter((a, i) => a !== "-c" && args[i - 1] !== "-c").join(" ")}`);
    if (failRemove && args[0] === "worktree" && args[1] === "remove") return { code: 1, stdout: "", stderr: "fatal: stand-in refusal" };
    return runGit(args, cwd);
  };
  const owner = chat === undefined ? OWNER : chat;
  const deps: DiscardDeps = {
    git: g,
    target: async () => "master",
    openEntry: async () => null,
    owner: async () => owner,
    chatBusy: () => false,
    workingSubagents: () => 0,
    uses: async () => ({ uses: [], unreadable: [] }),
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
    archive: async (path) => {
      log.push(`archive ${path}`);
      return { ok: true };
    },
    close: async (path) => {
      log.push(`close ${path}`);
    },
    now: () => Date.now(),
    ...o,
  };
  return { log, deps };
}

describe("Discard Branch…: the dry run", () => {
  test("lists the commits the target lacks, the folder's files git doesn't have, the drafts and the chat, with the digest", async () => {
    const b = branch("preview");
    write(join(b.folder, "notes.md"), "mine\n");
    write(join(b.folder, ".sova/spec/drafts/discard/spec/x.md"), "draft\n");
    const w = world({ draftNames: () => ["discard"] });
    const p = await previewDiscard({ root: main, ...b }, w.deps);
    assert.equal(p.refused, null);
    assert.equal(p.target, "master");
    assert.equal(p.commits.count, 1);
    assert.equal(p.commits.shown[0]?.subject, "work on preview");
    assert.equal(p.folder, b.folder);
    assert.deepEqual(p.files?.uncommitted, ["notes.md"]);
    assert.ok(p.files?.ignored.some((f) => f.startsWith(".sova/spec/drafts/")), JSON.stringify(p.files));
    assert.deepEqual(p.drafts, ["discard"]);
    assert.deepEqual(p.chat, { id: "s1", title: "Build x", path: "/sessions/s1.jsonl" });
    assert.equal(p.digest, p.files?.digest);
    assert.deepEqual(w.log, [], "a dry run deletes nothing");
    assert.ok(existsSync(join(b.folder, "notes.md")) && exists(`refs/heads/${b.branch}`));
  });
});

describe("Discard Branch…: the refusals, each before anything goes, in the dry run and again on the confirm", () => {
  const ago = Date.now() - 3_600_000;
  const use = (u: Partial<ChatUse>): ChatUse => ({ path: "/sessions/w.jsonl", name: "w", cwd: null, inside: [], tracks: [], archived: false, running: false, tui: false, workers: 0, sandbox: false, lastActiveAt: ago, ...u });
  const cases: { name: string; words: string | ((folder: string) => string); setup: (b: ReturnType<typeof branch>) => { req?: Partial<{ branch: string; commit: string }>; deps?: Partial<DiscardDeps>; owner?: DiscardOwner | null } }[] = [
    { name: "the target branch", words: DISCARD_WORDS.main, setup: () => ({ req: { branch: "master" } }) },
    { name: "the queue's target named apart from the checkout", words: DISCARD_WORDS.main, setup: (b) => ({ deps: { target: async () => b.branch } }) },
    { name: "a queue entry stands for it", words: DISCARD_WORDS.inQueue, setup: () => ({ deps: { openEntry: async () => ({ id: "mq_1", state: "queued" }) } }) },
    { name: "a turn runs in its chat", words: DISCARD_WORDS.chatWorking, setup: () => ({ deps: { chatBusy: (p) => p === OWNER.path } }) },
    { name: "its chat is open in a TUI", words: DISCARD_WORDS.chatTui, setup: () => ({ owner: { ...OWNER, tui: true } }) },
    { name: "its chat's worker is working", words: DISCARD_WORDS.worker, setup: () => ({ deps: { workingSubagents: () => 1 } }) },
    { name: "another chat runs in its folder", words: DISCARD_WORDS.worker, setup: (b) => ({ deps: { uses: async () => ({ uses: [use({ cwd: b.folder, inside: [b.folder], running: true })], unreadable: [] }) } }) },
    { name: "a process runs in its folder", words: () => process_words({ command: "vite", pid: 4242 }), setup: (b) => ({ deps: { processes: async () => [{ pid: 4242, command: "vite", paths: [join(b.folder, "src")] }] } }) },
    { name: "its head moved since the row was read", words: DISCARD_WORDS.moved, setup: () => ({ req: { commit: "0".repeat(40) } }) },
    { name: "the branch is gone", words: DISCARD_WORDS.noBranch, setup: () => ({ req: { branch: "feat/never-was" } }) },
    { name: "the target can't be read", words: DISCARD_WORDS.noTarget, setup: () => ({ deps: { target: async () => null } }) },
  ];
  let n = 0;
  for (const c of cases)
    test(c.name, async () => {
      const b = branch(`refuse-${n++}`);
      const s = c.setup(b);
      const req = { root: main, branch: b.branch, commit: b.commit, ...s.req };
      const w = world({ ...s.deps, ...(s.owner !== undefined ? { chat: s.owner } : {}) });
      const words = typeof c.words === "function" ? c.words(b.folder) : c.words;
      const p = await previewDiscard(req, w.deps);
      assert.equal(p.refused, words);
      await assert.rejects(discardBranch(req, p.digest, w.deps), (err: unknown) => err instanceof DiscardRefused && err.code === "refused" && err.message === words);
      assert.deepEqual(w.log, [], "nothing was run");
      assert.ok(existsSync(b.folder) && exists(`refs/heads/${b.branch}`), "the folder and the branch stay");
    });

  test("a quiet chat elsewhere in the folder, an archived one and the owner's own row don't refuse it", async () => {
    const b = branch("quiet");
    const w = world({ uses: async () => ({ uses: [use({ cwd: b.folder, inside: [b.folder], lastActiveAt: Date.now() - 60_000, name: "quiet" }), use({ cwd: b.folder, inside: [b.folder], running: true, archived: true }), use({ path: OWNER.path, cwd: b.folder, inside: [b.folder], lastActiveAt: Date.now() })], unreadable: [] }) });
    assert.equal((await previewDiscard({ root: main, ...b }, w.deps)).refused, null);
  });

  test("another discard or a cleanup holding the repository's lock refuses it, deleting nothing", async () => {
    const b = branch("locked");
    const w = world();
    const lock = (await w.deps.lockFile(main))!;
    assert.ok(takeLock(lock));
    try {
      const p = await previewDiscard({ root: main, ...b }, w.deps);
      await assert.rejects(discardBranch({ root: main, ...b }, p.digest, w.deps), (err: unknown) => err instanceof DiscardRefused && err.message === DISCARD_WORDS.locked);
    } finally {
      dropLock(lock);
    }
    assert.ok(existsSync(b.folder) && exists(`refs/heads/${b.branch}`));
  });

  test("a file that appeared after the dry run stops it: changed, ask again, nothing deleted", async () => {
    const b = branch("changed");
    write(join(b.folder, "seen.txt"), "seen\n");
    const w = world();
    const p = await previewDiscard({ root: main, ...b }, w.deps);
    write(join(b.folder, "new.txt"), "new\n");
    await assert.rejects(discardBranch({ root: main, ...b }, p.digest, w.deps), (err: unknown) => err instanceof DiscardRefused && err.code === "changed" && err.message === DISCARD_WORDS.changed);
    assert.deepEqual(w.log, []);
    assert.ok(existsSync(join(b.folder, "seen.txt")) && existsSync(join(b.folder, "new.txt")) && exists(`refs/heads/${b.branch}`));
  });
});

describe("Discard Branch…: the confirm", () => {
  test("folder, then the branch at exactly its tip with no pin, then the chat archived; the files seen go with the folder", async () => {
    const b = branch("whole");
    write(join(b.folder, "notes.md"), "mine\n");
    write(join(b.folder, "node_modules/x/index.js"), "x\n");
    const w = world();
    const p = await previewDiscard({ root: main, ...b }, w.deps);
    const r = await discardBranch({ root: main, ...b }, p.digest, w.deps);
    assert.equal(r.outcome, "discarded", r.message);
    assert.deepEqual(r.steps.map((s) => `${s.step}:${s.state}`), ["folder:done", "branch:done", "chat:done"]);
    assert.equal(r.message, `Discarded ${b.branch}: its folder, its branch and its chat are gone.`);
    assert.deepEqual(w.log, [`git worktree remove --force -- ${b.folder}`, `git update-ref -d refs/heads/${b.branch} ${b.commit}`, `archive ${OWNER.path}`]);
    assert.ok(!existsSync(b.folder), "the folder is gone");
    assert.ok(!exists(`refs/heads/${b.branch}`), "the branch is gone");
    assert.equal(git(main, "for-each-ref", "refs/sova/"), "", "no backup pin");
  });

  test("a clean folder goes without --force", async () => {
    const b = branch("clean");
    const w = world({ chat: null });
    const p = await previewDiscard({ root: main, ...b }, w.deps);
    assert.equal(p.chat, null);
    const r = await discardBranch({ root: main, ...b }, p.digest, w.deps);
    assert.deepEqual(r.steps.map((s) => `${s.step}:${s.state}`), ["folder:done", "branch:done", "chat:skipped"]);
    assert.equal(w.log[0], `git worktree remove -- ${b.folder}`);
  });

  test("a branch with no folder skips that step; an archived chat skips its own", async () => {
    const b = branch("nofolder", { folder: false });
    const w = world({ chat: { ...OWNER, archived: true } });
    const p = await previewDiscard({ root: main, ...b }, w.deps);
    assert.equal(p.folder, null);
    assert.equal(p.files, null);
    assert.equal(p.digest, "");
    assert.equal(p.chat, null);
    assert.equal(p.commits.count, 2);
    const r = await discardBranch({ root: main, ...b }, "", w.deps);
    assert.deepEqual(r.steps.map((s) => `${s.step}:${s.state}`), ["folder:skipped", "branch:done", "chat:skipped"]);
    assert.ok(!exists(`refs/heads/${b.branch}`));
    assert.deepEqual(w.log, [`git update-ref -d refs/heads/${b.branch} ${b.commit}`]);
  });

  test("a folder git won't remove stops it there: the branch and the chat stay, and it says so", async () => {
    const b = branch("stuck");
    const w = world({ failRemove: true });
    const p = await previewDiscard({ root: main, ...b }, w.deps);
    const r = await discardBranch({ root: main, ...b }, p.digest, w.deps);
    assert.equal(r.outcome, "partial");
    assert.deepEqual(r.steps.map((s) => `${s.step}:${s.state}`), ["folder:failed", "branch:not-run", "chat:not-run"]);
    assert.match(r.message, /^Nothing was deleted; its folder, its branch and its chat stayed\. Its folder: Git refused: fatal: stand-in refusal/);
    assert.ok(existsSync(b.folder) && exists(`refs/heads/${b.branch}`));
    assert.ok(!w.log.some((l) => l.startsWith("archive")));
  });

  test("a chat archive refuses: folder and branch are gone, the chat is closed and the answer names what stayed", async () => {
    const b = branch("archive-fails");
    const w = world({ archive: async () => ({ ok: false, error: "Only sessions started in Sova can be archived." }) });
    const p = await previewDiscard({ root: main, ...b }, w.deps);
    const r = await discardBranch({ root: main, ...b }, p.digest, w.deps);
    assert.equal(r.outcome, "partial");
    assert.deepEqual(r.steps.map((s) => `${s.step}:${s.state}`), ["folder:done", "branch:done", "chat:failed"]);
    assert.equal(r.message, "Its folder and its branch are gone; its chat stayed. Its chat: Only sessions started in Sova can be archived.");
    assert.ok(w.log.includes(`close ${OWNER.path}`));
    assert.ok(!existsSync(b.folder) && !exists(`refs/heads/${b.branch}`));
  });

  test("the lock is dropped after it, so the next one may run", async () => {
    const b = branch("after");
    const w = world({ chat: null });
    await discardBranch({ root: main, ...b }, (await previewDiscard({ root: main, ...b }, w.deps)).digest, w.deps);
    const lock = (await w.deps.lockFile(main))!;
    assert.ok(takeLock(lock), "the lock is free again");
    dropLock(lock);
  });
});
