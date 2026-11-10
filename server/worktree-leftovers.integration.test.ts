// §chat.worktrees/cleanup at git level, the loss t3code shipped (#30998, #23866) reproduced: a merged
// worktree that `git status` calls clean, holding an ignored local.env, a hermetic .agent with a
// session and an auth.json, and a worktree of another repository nested under an ignored folder with
// an uncommitted file. Plain `git worktree remove` deletes all of it without a word; the cleanup keeps
// it and says why, and Remove Anyway deletes exactly what it listed, only while that is unchanged. A
// tree holding only rebuildable folders (node_modules, dist, a generated .agent) still goes.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { removeWorktree, withRemoveAnyway, WorktreeRefusal, type WorktreeRecord } from "./project-worktrees";
import { leftovers, leftoversDigest, leftoversReason, removeAnywayOf } from "./worktree-leftovers";

const root = realpathSync(mkdtempSync(join(tmpdir(), "sova-leftovers-int-")));
const main = join(root, "umb");
const be = join(root, "be");
const wt = (name: string) => join(root, `wt-${name}`);
const env = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" };
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const write = (path: string, text: string) => {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, text);
};
/** A linked worktree on feat/<name> with no commit of its own: an empty one, removable as far as git's history goes. */
const add = (name: string) => git(main, "worktree", "add", "-q", "-b", `feat/${name}`, wt(name));
/** The one removal a user's page can ask for by name (§app.project-overseer/coding-worktrees): the tree as Remove Worktree sees it. */
const record = (name: string): WorktreeRecord => ({ path: wt(name), branch: `feat/${name}`, target: "master", base: git(main, "rev-parse", "master") }) as unknown as WorktreeRecord;
const remove = (name: string) => removeWorktree(record(name), main);
const removeAnyway = (name: string, digest: string) => withRemoveAnyway(wt(name), digest, () => remove(name));

before(() => {
  mkdirSync(main, { recursive: true });
  git(main, "init", "-q", "-b", "master");
  write(join(main, ".gitignore"), "local.env\n.agent/\nbackend/\nnode_modules\ndist/\n");
  write(join(main, "a.txt"), "a\n");
  git(main, "add", "-A");
  git(main, "commit", "-q", "-m", "init");
  mkdirSync(be);
  git(be, "init", "-q", "-b", "master");
  write(join(be, "canary.txt"), "be\n");
  git(be, "add", "-A");
  git(be, "commit", "-q", "-m", "be");
});

after(() => {
  const locked = join(wt("unreadable"), "backend", "private");
  if (existsSync(locked)) chmodSync(locked, 0o700);
  rmSync(root, { recursive: true, force: true });
});

/** The old loss's fixture: clean to `git status`, full of work git doesn't track. */
function lossy(name: string): void {
  add(name);
  write(join(wt(name), "local.env"), "TOKEN=x\n");
  write(join(wt(name), ".agent", "settings.json"), "{}\n");
  write(join(wt(name), ".agent", "auth.json"), "{}\n");
  write(join(wt(name), ".agent", "sessions", "--x--", "s1.jsonl"), "{}\n");
  git(be, "worktree", "add", "-q", "-b", `wip-${name}`, join(wt(name), "backend"));
  write(join(wt(name), "backend", "wip.txt"), "uncommitted work\n");
}

test("the old blind spot: git calls the tree clean, and its own remove would take the ignored work with it", () => {
  lossy("probe");
  assert.equal(git(wt("probe"), "status", "--porcelain"), "", "git status sees nothing, as the old check did");
  // What the old cleanup ran: plain `git worktree remove` succeeds and deletes it all.
  git(main, "worktree", "remove", "--", wt("probe"));
  assert.equal(existsSync(join(wt("probe"), "local.env")), false);
  assert.equal(existsSync(join(wt("probe"), "backend", "wip.txt")), false, "the nested worktree's uncommitted file is gone");
  assert.equal(readFileSync(join(be, "canary.txt"), "utf8"), "be\n");
});

test("the keep rule keeps such a tree, names what it holds, and lists exactly what Remove Anyway would delete", async () => {
  lossy("lossy");
  const held = await leftovers(wt("lossy"));
  const why = leftoversReason(held) ?? "";
  assert.match(why, /^Holds what can't be rebuilt: /);
  assert.match(why, /local\.env/);
  assert.match(why, /\.agent \(sessions\)/);
  assert.match(why, /1 nested repository: backend/);
  const a = removeAnywayOf(held);
  assert.deepEqual(a.uncommitted, []);
  assert.deepEqual(a.ignored, [".agent/auth.json", ".agent/sessions/--x--/s1.jsonl", ".agent/settings.json", "local.env"]);
  assert.deepEqual(a.nested, [{ path: "backend", kind: "worktree", of: be }]);
  assert.deepEqual(a.counts, { uncommitted: 0, ignored: 4, nested: 1, rebuildable: 0 });
  // A removal re-checks and still keeps it: nothing on disk changes.
  await assert.rejects(remove("lossy"), /Holds what can't be rebuilt/);
  for (const f of ["local.env", ".agent/auth.json", ".agent/sessions/--x--/s1.jsonl", "backend/wip.txt"]) assert.ok(existsSync(join(wt("lossy"), f)), `${f} kept`);
});

test("Remove Anyway with a listing that no longer matches deletes nothing; with the current one it removes the tree", async () => {
  const digest = leftoversDigest(await leftovers(wt("lossy")));
  write(join(wt("lossy"), "local2.env"), "new\n");
  await assert.rejects(removeAnyway("lossy", digest), (err: Error) => err instanceof WorktreeRefusal && /^Changed since the list, nothing was deleted: /.test(err.message) && /local2\.env/.test(err.message));
  assert.ok(existsSync(join(wt("lossy"), "backend", "wip.txt")));
  const now = await leftovers(wt("lossy"));
  assert.deepEqual(removeAnywayOf(now).uncommitted, ["local2.env"]);
  await removeAnyway("lossy", leftoversDigest(now));
  assert.equal(existsSync(wt("lossy")), false, "the folder is gone");
  assert.equal(readFileSync(join(be, "canary.txt"), "utf8"), "be\n", "the nested worktree's repository is untouched");
  assert.equal(git(be, "worktree", "list", "--porcelain").includes(join(wt("lossy"), "backend")), false, "and no longer lists the nested worktree that went");
  assert.match(git(be, "branch", "--list", "wip-lossy"), /wip-lossy/, "its branch, and so its commits, stay");
});

test("a tree holding only rebuildable folders and a generated .agent is removed", async () => {
  add("rebuild");
  write(join(wt("rebuild"), "node_modules", "pkg", "index.js"), "x\n");
  write(join(wt("rebuild"), "dist", "app.js"), "x\n");
  write(join(wt("rebuild"), ".agent", "settings.json"), "{}\n");
  write(join(wt("rebuild"), ".agent", "sova", "auth-token"), "t\n");
  mkdirSync(join(wt("rebuild"), ".agent", "extensions"), { recursive: true });
  symlinkSync(join(main, "a.txt"), join(wt("rebuild"), ".agent", "extensions", "link"));
  const l = await leftovers(wt("rebuild"));
  assert.deepEqual([l.dirty, l.ignored, l.nested, l.unreadable], [[], [], [], undefined]);
  assert.deepEqual(l.rebuildable, [".agent/", "dist/", "node_modules/"]);
  await remove("rebuild");
  assert.equal(existsSync(wt("rebuild")), false);
  assert.equal(readFileSync(join(main, "a.txt"), "utf8"), "a\n", "a symlink's target stays");
});

test("a nested repository inside a rebuildable folder still keeps the tree; a .agent with server state does too", async () => {
  add("nested-dist");
  mkdirSync(join(wt("nested-dist"), "dist", "vendor"), { recursive: true });
  git(join(wt("nested-dist"), "dist", "vendor"), "init", "-q");
  const l = await leftovers(wt("nested-dist"));
  assert.deepEqual(l.nested, [{ path: "dist/vendor", kind: "repository" }]);
  add("agent-state");
  write(join(wt("agent-state"), ".agent", "sova", "chats", "c.json"), "{}\n");
  const s = await leftovers(wt("agent-state"));
  assert.equal(s.agent, "server state");
  assert.deepEqual(s.ignored, [".agent/sova/chats/c.json"]);
  assert.match(leftoversReason(l) ?? "", /nested repository: dist\/vendor/);
  assert.match(leftoversReason(s) ?? "", /\.agent \(server state\)/);
});

test("a folder that can't be read keeps the tree, with no Remove Anyway", { skip: process.getuid?.() === 0 && "root reads everything" }, async () => {
  add("unreadable");
  write(join(wt("unreadable"), "local.env"), "x\n");
  write(join(wt("unreadable"), ".agent", "sessions", "s.jsonl"), "{}\n");
  mkdirSync(join(wt("unreadable"), "backend", "private"), { recursive: true });
  chmodSync(join(wt("unreadable"), "backend", "private"), 0o000);
  try {
    const held = await leftovers(wt("unreadable"));
    assert.match(leftoversReason(held) ?? "", /^Its files couldn't be read: /);
    await assert.rejects(remove("unreadable"), /couldn't be read/);
    assert.ok(existsSync(join(wt("unreadable"), "local.env")));
  } finally {
    chmodSync(join(wt("unreadable"), "backend", "private"), 0o700);
  }
});

test("a locked tree: git refuses even Remove Anyway's one force, and nothing goes", async () => {
  add("locked");
  write(join(wt("locked"), "local.env"), "x\n");
  git(main, "worktree", "lock", wt("locked"));
  await assert.rejects(removeAnyway("locked", leftoversDigest(await leftovers(wt("locked")))), /Nothing was removed/);
  assert.ok(existsSync(join(wt("locked"), "local.env")));
});

test("judged by what git lists: an ignored file in a tracked build/ counts, a dist/ inside the user's own ignored folder isn't build output", async () => {
  add("named");
  write(join(wt("named"), "build", "script.sh"), "echo\n");
  write(join(wt("named"), ".gitignore"), "build/.env\nnotes/\nlocal.env\n.agent/\nbackend/\nnode_modules\ndist/\n");
  git(wt("named"), "add", "-A");
  git(wt("named"), "commit", "-q", "-m", "tracked build/");
  write(join(wt("named"), "build", ".env"), "SECRET\n");
  write(join(wt("named"), "notes", "dist", "mine.md"), "mine\n");
  write(join(wt("named"), "notes", "node_modules", "p", "i.js"), "x\n");
  const l = await leftovers(wt("named"));
  assert.deepEqual(l.ignored, ["build/.env", "notes/dist/mine.md"]);
  assert.deepEqual(l.rebuildable, ["notes/node_modules/"]);
});

test("an initialised submodule, clean or not, is listed as a nested repository", async () => {
  add("sub");
  git(wt("sub"), "-c", "protocol.file.allow=always", "submodule", "add", "-q", be, "vendor/be");
  git(wt("sub"), "commit", "-q", "-m", "submodule");
  const l = await leftovers(wt("sub"));
  assert.deepEqual(l.nested, [{ path: "vendor/be", kind: "repository" }]);
  assert.equal(l.dirty.length, 0);
});
