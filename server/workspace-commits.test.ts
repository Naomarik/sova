// Run: pnpm exec tsx --test server/workspace-commits.test.ts. Plain git repos in the OS temp dir
// (one bare repo as the remote), deleted after; nothing else is read or written.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { changeSummary, COMMIT_EVERY_MS, commitEveryMs, WorkspaceCommitter } from "./workspace-commits";
import { commitAll, gitStatus, initRepo, setRemote } from "./workspace-git";

const root = realpathSync(mkdtempSync(join(tmpdir(), "sova-wscommit-")));
after(() => rmSync(root, { recursive: true, force: true }));

const git = (dir: string, ...args: string[]) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" }).trim();
const count = (dir: string) => Number(git(dir, "rev-list", "--count", "HEAD"));

async function repo(name: string): Promise<string> {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  await initRepo(dir);
  writeFileSync(join(dir, "org.json"), "{}\n");
  await commitAll(dir, "first");
  return dir;
}

describe("the hourly workspace commit", () => {
  test("the interval: an hour, or SOVA_WORKSPACE_COMMIT_MS when it is a positive whole number", () => {
    assert.equal(COMMIT_EVERY_MS, 3_600_000);
    assert.equal(commitEveryMs({}), 3_600_000);
    assert.equal(commitEveryMs({ SOVA_WORKSPACE_COMMIT_MS: "5000" }), 5000);
    for (const bad of ["0", "-5", "1.5", "soon", ""]) assert.equal(commitEveryMs({ SOVA_WORKSPACE_COMMIT_MS: bad }), 3_600_000, bad);
  });

  test("nothing changed: no commit, however long it has been", async () => {
    const dir = await repo("clean");
    const c = new WorkspaceCommitter(() => [{ id: "o", dir }], { everyMs: 1000, now: () => Date.now() + 10 * COMMIT_EVERY_MS });
    const before = count(dir);
    assert.deepEqual(await c.tick(), [null]);
    assert.equal(count(dir), before, "no empty commit");
  });

  test("changes wait for the interval, counted from the last commit; then one commit takes them all", async () => {
    const dir = await repo("due");
    const head = Number(git(dir, "log", "-1", "--format=%ct")) * 1000;
    let now = head + 10_000;
    const c = new WorkspaceCommitter(() => [{ id: "o", dir }], { everyMs: 60_000, now: () => now });
    writeFileSync(join(dir, "roster.json"), "{\"people\":[]}\n");
    mkdirSync(join(dir, "sessions"), { recursive: true });
    writeFileSync(join(dir, "sessions", "a.jsonl"), "{}\n");
    writeFileSync(join(dir, "sessions", "b.jsonl"), "{}\n");
    const before = count(dir);
    assert.deepEqual(await c.tick(), [null], "10s after the last commit: not due");
    assert.equal(count(dir), before);
    now = head + 60_000;
    const [out] = await c.tick();
    assert.equal(out?.committed, true);
    assert.equal(count(dir), before + 1, "one commit");
    assert.equal(git(dir, "status", "--porcelain"), "", "everything that changed is in it");
    assert.equal(git(dir, "log", "-1", "--format=%s"), "Workspace changes: roster.json, sessions/ (2 files)");
    // A second change right after: not due again until the interval has passed since THAT commit.
    writeFileSync(join(dir, "roster.json"), "{\"people\":[1]}\n");
    const last = Number(git(dir, "log", "-1", "--format=%ct")) * 1000;
    now = last + 30_000;
    assert.deepEqual(await c.tick(), [null], "at most once per interval");
    now = last + 60_000;
    assert.equal((await c.tick())[0]?.committed, true);
  });

  test("a Commit Now resets the clock: the next periodic commit is an interval after it", async () => {
    const dir = await repo("manual");
    writeFileSync(join(dir, "x.json"), "1\n");
    await commitAll(dir, "Commit now");
    const at = Number(git(dir, "log", "-1", "--format=%ct")) * 1000;
    writeFileSync(join(dir, "x.json"), "2\n");
    const c = new WorkspaceCommitter(() => [{ id: "o", dir }], { everyMs: 60_000, now: () => at + 59_000 });
    assert.deepEqual(await c.tick(), [null]);
  });

  test("with a remote, a commit is pushed; a failed push is retried on a later tick", async () => {
    const bare = join(root, "remote.git");
    execFileSync("git", ["init", "-q", "--bare", "-b", "main", bare]);
    const dir = await repo("pushed");
    await setRemote(dir, bare);
    writeFileSync(join(dir, "projects.json"), "{\"projects\":[]}\n");
    const c = new WorkspaceCommitter(() => [{ id: "o", dir }], { everyMs: 1000, now: () => Date.now() + 5000 });
    const [out] = await c.tick();
    assert.equal(out?.committed, true);
    assert.equal(out?.pushed, true);
    assert.equal(git(bare, "rev-parse", "main"), git(dir, "rev-parse", "HEAD"), "the remote has the commit");

    // The remote goes away: the commit stays local and the failure is the repo's last error.
    await setRemote(dir, join(root, "missing.git"));
    writeFileSync(join(dir, "projects.json"), "{\"projects\":[1]}\n");
    const [failed] = await c.tick();
    assert.equal(failed?.committed, true);
    assert.match(failed?.error ?? "", /git push failed/);
    // It comes back: the next tick pushes although nothing new changed.
    await setRemote(dir, bare);
    const [retried] = await c.tick();
    assert.equal(retried?.committed, false);
    assert.equal(retried?.pushed, true);
    assert.equal(git(bare, "rev-parse", "main"), git(dir, "rev-parse", "HEAD"));
  });

  test("Commit Now with nothing new pushes the commits a just-set remote lacks; nothing to push is a no-op", async () => {
    const bare = join(root, "late-remote.git");
    execFileSync("git", ["init", "-q", "--bare", "-b", "main", bare]);
    const dir = await repo("late");
    await setRemote(dir, bare);
    const first = await commitAll(dir, "Commit now");
    assert.equal(first.committed, false, "nothing new to commit");
    assert.equal(first.pushed, true, "the history went to the remote");
    assert.equal(first.error, undefined);
    assert.equal(git(bare, "rev-parse", "HEAD"), git(dir, "rev-parse", "HEAD"), "the remote has HEAD");
    const again = await commitAll(dir, "Commit now");
    assert.deepEqual(again, { committed: false }, "up to date: no push");
    // A commit made while the remote was unset is pushed by the next Commit Now too.
    await setRemote(dir, "");
    writeFileSync(join(dir, "notes.md"), "x\n");
    await commitAll(dir, "local only");
    await setRemote(dir, bare);
    const behind = await commitAll(dir, "Commit now");
    assert.equal(behind.pushed, true);
    assert.equal(git(bare, "rev-parse", "HEAD"), git(dir, "rev-parse", "HEAD"));
    // Another, empty remote: the old one's tracking refs don't count, so it gets the history.
    const other = join(root, "other-remote.git");
    execFileSync("git", ["init", "-q", "--bare", "-b", "main", other]);
    await setRemote(dir, other);
    assert.equal((await commitAll(dir, "Commit now")).pushed, true);
    assert.equal(git(other, "rev-parse", "HEAD"), git(dir, "rev-parse", "HEAD"));
    // The remote is unreachable: the failure is recorded like a commit's push.
    await setRemote(dir, join(root, "nowhere.git"));
    writeFileSync(join(dir, "notes.md"), "y\n");
    await commitAll(dir, "local only");
    const failed = await commitAll(dir, "Commit now");
    assert.match(failed.error ?? "", /git push failed/);
    assert.match((await gitStatus(dir)).lastError ?? "", /git push failed/);
  });

  test("shutdown: every repo with changes is committed now, due or not; a clean one is left alone", async () => {
    const a = await repo("flush-a");
    const b = await repo("flush-b");
    writeFileSync(join(a, "baton.json"), "{}\n");
    const c = new WorkspaceCommitter(() => [{ id: "a", dir: a }, { id: "b", dir: b }], { everyMs: COMMIT_EVERY_MS });
    const [ca, cb] = [count(a), count(b)];
    const out = await c.flush("shutdown");
    assert.equal(out.length, 1);
    assert.equal(count(a), ca + 1);
    assert.equal(count(b), cb, "no empty commit");
    assert.equal(git(a, "log", "-1", "--format=%s"), "Workspace changes (shutdown): baton.json");
  });

  test("the message names what changed by its top-level entry, never file contents", () => {
    assert.equal(changeSummary(["roster.json", "sessions/x.jsonl", "projects/p1/overseer/todos.json", "projects/p1/decisions.json"]), "projects/ (2 files), roster.json, sessions/ (1 file)");
  });
});
