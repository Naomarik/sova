// Discard Branch… end to end on a scratch repository (server/worktree-remove-discard.ts): the route, the server's own
// wiring (realDiscardDeps: the owner rule over real session files, the leftovers listing, the process scan, the
// retirer's lock, POST /api/sessions/archive's archive), git doing the removal. Only the queue's target and entries are
// stood in: no merge queue runs here. A real process in the folder holds it; a chat's turn holds it; a file that appears
// after the dry run stops it; an unlanded branch goes with its folder, and its chat is archived.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { Hono } from "hono";

const agentDir = realpathSync(mkdtempSync(join(tmpdir(), "sova-discard-int-")));
process.env.PI_CODING_AGENT_DIR = agentDir;
const sessionsDir = join(agentDir, "sessions", "--discard--");
mkdirSync(sessionsDir, { recursive: true });
mkdirSync(join(agentDir, "sessions", "live"), { recursive: true });

// The full app, for the wiring its build does (the chats' reader the folder's users come from).
const { testApp } = await import("./mesh/app-test-fixtures");
const full = await testApp();
const { addWebSession } = await import("./web-sessions");
const { isArchived } = await import("./archived-sessions");
const { registerMergeLandingRoutes } = await import("./merge-queue/routes-landing");
const { realDiscardDeps, DISCARD_WORDS } = await import("./worktree-remove-discard");

const root = join(agentDir, "work");
const main = join(root, "repo");
const env = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" };
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const hasRef = (ref: string) => {
  try {
    git(main, "rev-parse", "--verify", "-q", ref);
    return true;
  } catch {
    return false;
  }
};

let busy = new Set<string>();
const app = new Hono();
registerMergeLandingRoutes(app, {
  queueOf: async () => null,
  queueOfEntry: async () => null,
  discard: {
    rootOf: async (id) => (id === "prj_1" ? main : null),
    deps: async () => {
      const d = await realDiscardDeps();
      return { ...d, target: async () => "master", openEntry: async () => null, chatBusy: (p: string) => busy.has(p) || d.chatBusy(p) };
    },
    notPage: () => null,
  },
});
const post = async (body: unknown) => {
  const r = await app.request("/api/merge-queue/projects/prj_1/discard-branch", { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } });
  return { status: r.status, body: (await r.json()) as Record<string, any> };
};

/** A web chat working in `cwd`, last written an hour ago: its id and file. */
function chatIn(id: string, cwd: string): { id: string; path: string } {
  const path = join(sessionsDir, `2026-11-10T00-00-00-000Z_${id}.jsonl`);
  writeFileSync(path, `${[
    JSON.stringify({ type: "session", version: 3, id, timestamp: "2026-11-10T00:00:00.000Z", cwd }),
    JSON.stringify({ type: "message", id: "m1", parentId: null, timestamp: "2026-11-10T00:00:01.000Z", message: { role: "user", content: `work in ${id}` } }),
  ].join("\n")}\n`);
  addWebSession(id);
  const then = new Date(Date.now() - 3_600_000);
  utimesSync(path, then, then);
  return { id, path };
}

/** feat/<name> with a commit master hasn't, in its own folder, and a chat working there (quiet for an hour). */
function unlanded(name: string): { branch: string; commit: string; folder: string; chat: { id: string; path: string } } {
  const branch = `feat/${name}`;
  const folder = join(root, ".worktrees", `repo-${name}`);
  git(main, "worktree", "add", "-q", "-b", branch, folder, "master");
  writeFileSync(join(folder, `${name}.txt`), "work\n");
  git(folder, "add", "-A");
  git(folder, "commit", "-q", "-m", `unlanded ${name}`);
  const id = `discard-${name}`;
  const path = join(sessionsDir, `2026-11-10T00-00-00-000Z_${id}.jsonl`);
  writeFileSync(path, `${[
    JSON.stringify({ type: "session", version: 3, id, timestamp: "2026-11-10T00:00:00.000Z", cwd: folder }),
    JSON.stringify({ type: "message", id: "m1", parentId: null, timestamp: "2026-11-10T00:00:01.000Z", message: { role: "user", content: `build ${name}` } }),
  ].join("\n")}\n`);
  addWebSession(id);
  const then = new Date(Date.now() - 3_600_000);
  utimesSync(path, then, then);
  return { branch, commit: git(folder, "rev-parse", "HEAD"), folder, chat: { id, path } };
}

before(() => {
  mkdirSync(main, { recursive: true });
  git(main, "init", "-q", "-b", "master");
  writeFileSync(join(main, "a.txt"), "a\n");
  git(main, "add", "-A");
  git(main, "commit", "-q", "-m", "init");
});
after(() => rmSync(agentDir, { recursive: true, force: true }));

describe("Discard Branch…, end to end", () => {
  test("an unlanded branch: its folder (with the file you saw) and its branch go, with no pin, and its chat is archived", async () => {
    const b = unlanded("whole");
    writeFileSync(join(b.folder, "notes.md"), "mine\n");
    const p = await post({ branch: b.branch, commit: b.commit, dryRun: true });
    assert.equal(p.status, 200, JSON.stringify(p.body));
    assert.equal(p.body.refused, null);
    assert.equal(p.body.commits.count, 1);
    assert.deepEqual(p.body.files.uncommitted, ["notes.md"]);
    assert.equal(p.body.chat?.id, b.chat.id, "the chat working in the folder is the branch's");
    const r = await post({ branch: b.branch, commit: b.commit, digest: p.body.digest });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.outcome, "discarded", r.body.message);
    assert.ok(!existsSync(b.folder), "the folder is gone");
    assert.ok(!hasRef(`refs/heads/${b.branch}`), "the branch is gone");
    assert.equal(git(main, "for-each-ref", "refs/sova/"), "", "no backup pin");
    assert.equal(isArchived(b.chat.id), true, "its chat is archived");
    assert.ok(existsSync(b.chat.path), "archived, not deleted");
  });

  test("a second idle chat working in the folder is listed and archived too", async () => {
    const b = unlanded("two");
    // A later write than the branch's chat: the owner rule picks the newest, so this one names an older id.
    const other = chatIn("discard-two-other", join(b.folder));
    utimesSync(other.path, new Date(Date.now() - 7_200_000), new Date(Date.now() - 7_200_000));
    const p = await post({ branch: b.branch, commit: b.commit, dryRun: true });
    assert.equal(p.body.refused, null, JSON.stringify(p.body));
    const all = [p.body.chat?.id, ...p.body.others.map((c: { id: string }) => c.id)].sort();
    assert.deepEqual(all, [b.chat.id, other.id].sort(), "both chats are named before the confirm");
    const r = await post({ branch: b.branch, commit: b.commit, digest: p.body.digest });
    assert.equal(r.body.outcome, "discarded", r.body.message);
    assert.deepEqual(r.body.chats.map((c: { state: string }) => c.state), ["done", "done"]);
    assert.equal(isArchived(b.chat.id), true);
    assert.equal(isArchived(other.id), true);
  });

  test("while a turn runs in its chat it is refused, and everything stays", async () => {
    const b = unlanded("turn");
    busy = new Set([b.chat.path]);
    try {
      const p = await post({ branch: b.branch, commit: b.commit, dryRun: true });
      assert.equal(p.body.refused, DISCARD_WORDS.chatWorking);
      assert.deepEqual(await post({ branch: b.branch, commit: b.commit, digest: p.body.digest }), { status: 409, body: { error: { code: "refused", message: DISCARD_WORDS.chatWorking } } });
    } finally {
      busy = new Set();
    }
    assert.ok(existsSync(b.folder) && hasRef(`refs/heads/${b.branch}`));
    assert.equal(isArchived(b.chat.id), false);
  });

  test("a program running in its folder holds it, named by its command", async () => {
    const b = unlanded("proc");
    const child = spawn("sleep", ["30"], { cwd: b.folder, stdio: "ignore" });
    try {
      await new Promise((r) => child.once("spawn", r));
      const p = await post({ branch: b.branch, commit: b.commit, dryRun: true });
      assert.equal(p.body.refused, `A process is running in its folder: sleep (${child.pid}).`);
      assert.equal((await post({ branch: b.branch, commit: b.commit, digest: p.body.digest })).status, 409);
    } finally {
      child.kill("SIGKILL");
      await new Promise((r) => child.once("exit", r));
    }
    assert.ok(existsSync(b.folder) && hasRef(`refs/heads/${b.branch}`));
    assert.equal((await post({ branch: b.branch, commit: b.commit, dryRun: true })).body.refused, null, "once it ends, it may go");
  });

  test("a file that appears after the dry run stops it: changed, nothing deleted", async () => {
    const b = unlanded("late");
    const p = await post({ branch: b.branch, commit: b.commit, dryRun: true });
    assert.equal(p.body.refused, null);
    writeFileSync(join(b.folder, "late.txt"), "written after the list\n");
    assert.deepEqual(await post({ branch: b.branch, commit: b.commit, digest: p.body.digest }), { status: 409, body: { error: { code: "changed", message: DISCARD_WORDS.changed } } });
    assert.ok(existsSync(join(b.folder, "late.txt")) && hasRef(`refs/heads/${b.branch}`));
    assert.equal(isArchived(b.chat.id), false);
  });

  test("the live server's route refuses a chat's call", async () => {
    const b = unlanded("chatcall");
    const r = await full.request("/api/merge-queue/projects/prj_1/discard-branch", { method: "POST", body: JSON.stringify({ branch: b.branch, commit: b.commit, dryRun: true }), headers: { "content-type": "application/json", "x-sova-caller": "k" } });
    assert.equal(r.status, 403);
    assert.equal(((await r.json()) as { error: { code: string } }).error.code, "forbidden");
  });
});
