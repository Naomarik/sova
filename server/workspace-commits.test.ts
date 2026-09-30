// Run: pnpm exec tsx --test server/workspace-commits.test.ts. Plain git repos in the OS temp dir
// (one bare repo as the remote) and a throwaway PI_CODING_AGENT_DIR, deleted after; nothing else is
// read or written. When to commit is the residence chart's (its CLJS tests: an hour since HEAD, a
// write during a commit, Commit Now); here, what its `commit` and `push` effects do in the repo.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";

const root = realpathSync(mkdtempSync(join(tmpdir(), "sova-wscommit-")));
after(() => rmSync(root, { recursive: true, force: true }));
process.env.PI_CODING_AGENT_DIR = join(root, "agent");

const { changeSummary, COMMIT_EVERY_MS, commitEveryMs, flushWorkspaces } = await import("./workspace-commits");
const { commitAll, gitStatus, initRepo, setRemote } = await import("./workspace-git");
await import("./orgs"); // first, as the server loads it (org-engine and orgs import each other)
const { registerOrgEffects } = await import("./org-effects");
type OrgHostApi = import("./org-engine").OrgHostApi;

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

/** The residence's effects on `dir`'s repo, as the org's engine runs them (an org not in the index: its workspace is the host's). */
function effects(dir: string): Record<string, (e: Record<string, unknown>) => Promise<Record<string, unknown>>> {
  const handlers: Record<string, (e: Record<string, unknown>) => Promise<Record<string, unknown>>> = {};
  const host = { paths: { portable: join(dir, "charts") }, effects: { register: (kind: string, fn: never) => (handlers[kind] = fn) }, data: () => null, sessions: () => [] };
  registerOrgEffects(host as unknown as OrgHostApi, "org_commits");
  return handlers;
}
const commit = (dir: string, message?: string) => effects(dir).commit!({ kind: "commit", key: "k", sessionId: "residence/org_commits", ...(message ? { message } : {}) });
const push = (dir: string) => effects(dir).push!({ kind: "push", key: "k", sessionId: "residence/org_commits" });
const headMs = (dir: string) => Number(git(dir, "log", "-1", "--format=%ct")) * 1000;

describe("the workspace commit (the residence's effects)", () => {
  test("the interval: an hour, or SOVA_WORKSPACE_COMMIT_MS when it is a positive whole number", () => {
    assert.equal(COMMIT_EVERY_MS, 3_600_000);
    assert.equal(commitEveryMs({}), 3_600_000);
    assert.equal(commitEveryMs({ SOVA_WORKSPACE_COMMIT_MS: "5000" }), 5000);
    for (const bad of ["0", "-5", "1.5", "soon", ""]) assert.equal(commitEveryMs({ SOVA_WORKSPACE_COMMIT_MS: bad }), 3_600_000, bad);
  });

  test("nothing changed: no commit (with no remote, nothing to push); HEAD's time goes back to the chart", async () => {
    const dir = await repo("clean");
    const before = count(dir);
    const out = await commit(dir);
    assert.equal(out.committed, false);
    assert.equal(count(dir), before, "no empty commit");
    assert.equal(out.headAt, headMs(dir), "the residence counts the hour from HEAD");
    assert.equal(out.pushFailed, false);
  });

  test("one commit takes every change, named by top-level path; its time is HEAD's", async () => {
    const dir = await repo("due");
    writeFileSync(join(dir, "roster.json"), "{\"people\":[]}\n");
    mkdirSync(join(dir, "sessions"), { recursive: true });
    writeFileSync(join(dir, "sessions", "a.jsonl"), "{}\n");
    writeFileSync(join(dir, "sessions", "b.jsonl"), "{}\n");
    const before = count(dir);
    const out = await commit(dir);
    assert.equal(out.committed, true);
    assert.equal(count(dir), before + 1, "one commit");
    assert.equal(git(dir, "status", "--porcelain"), "", "everything that changed is in it");
    assert.equal(git(dir, "log", "-1", "--format=%s"), "Workspace changes: roster.json, sessions/ (2 files)");
    assert.equal(out.headAt, headMs(dir));
  });

  test("a commit the chart names (Commit Now, create, attach, release) carries its own message", async () => {
    const dir = await repo("manual");
    writeFileSync(join(dir, "x.json"), "1\n");
    assert.equal((await commit(dir, "Commit now (Acme)")).committed, true);
    assert.equal(git(dir, "log", "-1", "--format=%s"), "Commit now (Acme)");
  });

  test("with a remote, a commit is pushed; a failed push is the chart's pushFailed, and the push effect retries it", async () => {
    const bare = join(root, "remote.git");
    execFileSync("git", ["init", "-q", "--bare", "-b", "main", bare]);
    const dir = await repo("pushed");
    await setRemote(dir, bare);
    writeFileSync(join(dir, "projects.json"), "{\"projects\":[]}\n");
    const out = await commit(dir);
    assert.equal(out.committed, true);
    assert.equal(out.pushed, true);
    assert.equal(git(bare, "rev-parse", "main"), git(dir, "rev-parse", "HEAD"), "the remote has the commit");

    // The remote goes away: the commit stays local and the failure is the repo's last error.
    await setRemote(dir, join(root, "missing.git"));
    writeFileSync(join(dir, "projects.json"), "{\"projects\":[1]}\n");
    const failed = await commit(dir);
    assert.equal(failed.committed, true);
    assert.equal(failed.pushFailed, true);
    assert.match(String(failed.error ?? ""), /git push failed/);
    // It comes back: the retry pushes although nothing new changed.
    await setRemote(dir, bare);
    const retried = await push(dir);
    assert.equal(retried.committed, false);
    assert.equal(retried.pushed, true);
    assert.equal(retried.pushFailed, false);
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
    const [ca, cb] = [count(a), count(b)];
    const out = await flushWorkspaces([{ id: "a", dir: a }, { id: "b", dir: b }], "shutdown");
    assert.equal(out.length, 1);
    assert.equal(count(a), ca + 1);
    assert.equal(count(b), cb, "no empty commit");
    assert.equal(git(a, "log", "-1", "--format=%s"), "Workspace changes (shutdown): baton.json");
  });

  test("the message names what changed by its top-level entry, never file contents", () => {
    assert.equal(changeSummary(["roster.json", "sessions/x.jsonl", "projects/p1/overseer/todos.json", "projects/p1/decisions.json"]), "projects/ (2 files), roster.json, sessions/ (1 file)");
  });

  test("every workspace commit is Sova's, whatever identity the repo or the host has", async () => {
    const dir = await repo("identity");
    git(dir, "config", "user.name", "Operator Person");
    git(dir, "config", "user.email", "operator@example.invalid");
    writeFileSync(join(dir, "roster.json"), "{}\n");
    assert.equal((await commitAll(dir, "m")).committed, true);
    for (const rev of ["HEAD", "HEAD~1"]) assert.equal(git(dir, "log", "-1", "--format=%an <%ae> / %cn <%ce>", rev), "Sova <sova@localhost> / Sova <sova@localhost>", rev);
  });
});
