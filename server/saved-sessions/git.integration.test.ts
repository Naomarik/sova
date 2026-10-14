// The saved-sessions branch against real repositories: a bare origin and two clones pushing at once, a
// diverged local branch, the user's checkout left alone throughout, Merge Branch's guard, and the remote
// runner's framing driven through a local sh (the transport a target uses, minus ssh).
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { SAVED_SESSION_MARKER, SAVED_SESSIONS_REF } from "../../shared/session-bundle";
import { mergeBack, type WorktreeRecord } from "../project-worktrees";
import type { TargetRunResult } from "../targets";
import { scratchRoot } from "../test-scratch";
import { applySaved, localGit, readPath } from "./git";
import { remoteGit } from "./repo";

const root = scratchRoot("saved-git-int-");
after(() => rmSync(root, { recursive: true, force: true }));
const ENV = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" };
const sh = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", env: ENV }).trim();

function clone(origin: string, name: string, user: string): string {
  const dir = join(root, name);
  execFileSync("git", ["clone", "-q", origin, dir], { env: ENV });
  sh(dir, "config", "user.name", user);
  sh(dir, "config", "user.email", `${user}@example.invalid`);
  sh(dir, "config", "commit.gpgsign", "false");
  return dir;
}

function origin(name: string): string {
  const seed = join(root, `${name}-seed`);
  mkdirSync(seed, { recursive: true });
  sh(seed, "init", "-q", "-b", "master");
  sh(seed, "config", "user.name", "seed");
  sh(seed, "config", "user.email", "seed@example.invalid");
  writeFileSync(join(seed, "README"), "code\n");
  sh(seed, "add", "README");
  sh(seed, "-c", "commit.gpgsign=false", "commit", "-q", "-m", "init");
  const bare = join(root, `${name}.git`);
  execFileSync("git", ["clone", "-q", "--bare", seed, bare], { env: ENV });
  return bare;
}

function untouched(dir: string) {
  return { head: sh(dir, "rev-parse", "HEAD"), branch: sh(dir, "symbolic-ref", "HEAD"), index: readFileSync(join(dir, ".git", "index")).toString("base64"), status: sh(dir, "status", "--porcelain", "--untracked-files=all") };
}

const saveFolder = (id: string, body: string) => async () => ({
  change: { write: { [`sessions/${id}/session.json`]: JSON.stringify({ format: SAVED_SESSION_MARKER, bundleId: id, body }) } },
  result: id,
  message: `Save session: ${id} (v1)`,
});

describe("the saved-sessions branch between two clones", () => {
  test("two clones pushing at once both land, fast-forward only, and neither checkout moves", async () => {
    const bare = origin("race");
    const a = clone(bare, "a", "Ada");
    const b = clone(bare, "b", "Bo");
    writeFileSync(join(a, "wip.txt"), "uncommitted work\n");
    sh(a, "add", "wip.txt"); // staged, so the index has something of the user's in it
    const beforeA = untouched(a);
    const beforeB = untouched(b);
    const runs = await Promise.all([
      applySaved(localGit(a), { push: true, message: "", plan: saveFolder("aaaaaa01", "from a") }),
      applySaved(localGit(b), { push: true, message: "", plan: saveFolder("bbbbbb01", "from b") }),
      applySaved(localGit(a), { push: true, message: "", plan: saveFolder("aaaaaa02", "from a again") }),
    ]);
    for (const r of runs) assert.equal(r.pushed, true, r.pushError);
    const files = sh(bare, "ls-tree", "-r", "--name-only", SAVED_SESSIONS_REF).split("\n").sort();
    assert.deepEqual(files, ["sessions/aaaaaa01/session.json", "sessions/aaaaaa02/session.json", "sessions/bbbbbb01/session.json"]);
    // History only grew: every push was a fast-forward of the one before.
    const subjects = sh(bare, "log", "--format=%s", SAVED_SESSIONS_REF).split("\n");
    assert.equal(subjects.length, 3);
    assert.deepEqual(untouched(a), beforeA);
    assert.deepEqual(untouched(b), beforeB);
    // The orphan branch shares nothing with the code.
    assert.equal((await localGit(a)(["merge-base", "master", SAVED_SESSIONS_REF])).code, 1, "no common ancestor");
  });

  test("this computer's unpushed saves and someone else's pushed ones are joined, not overwritten", async () => {
    const bare = origin("diverge");
    const a = clone(bare, "da", "Ada");
    const b = clone(bare, "db", "Bo");
    const local = await applySaved(localGit(a), { push: false, message: "", plan: saveFolder("local001", "kept here") });
    assert.equal(local.pushed, false);
    assert.equal(sh(bare, "for-each-ref", SAVED_SESSIONS_REF), "", "nothing pushed yet");
    await applySaved(localGit(b), { push: true, message: "", plan: saveFolder("theirs01", "pushed by Bo") });
    const r = await applySaved(localGit(a), { push: true, message: "", plan: saveFolder("local002", "now pushed") });
    assert.equal(r.pushed, true, r.pushError);
    const files = sh(bare, "ls-tree", "-r", "--name-only", SAVED_SESSIONS_REF).split("\n").sort();
    assert.deepEqual(files, ["sessions/local001/session.json", "sessions/local002/session.json", "sessions/theirs01/session.json"]);
  });

  test("a remote with nowhere to push leaves the save here and says why", async () => {
    const bare = origin("gone");
    const a = clone(bare, "ga", "Ada");
    rmSync(bare, { recursive: true, force: true });
    const r = await applySaved(localGit(a), { push: true, message: "", plan: saveFolder("offline1", "x") });
    assert.equal(r.pushed, false);
    assert.ok(r.pushError);
    assert.ok(await readPath(localGit(a), SAVED_SESSIONS_REF, "sessions/offline1/session.json"));
  });
});

describe("Merge Branch's guard", () => {
  test("a saved session committed and deleted on the branch stops the merge; Merge Anyway merges", async () => {
    const bare = origin("guard");
    const top = clone(bare, "guard-root", "Ada");
    const wt = join(root, "guard-wt");
    sh(top, "worktree", "add", "-q", "-b", "sova/feature", wt);
    mkdirSync(join(wt, "chats"), { recursive: true });
    writeFileSync(join(wt, "chats", "card.json"), JSON.stringify({ format: SAVED_SESSION_MARKER }));
    sh(wt, "add", "chats");
    sh(wt, "-c", "commit.gpgsign=false", "commit", "-q", "-m", "save a chat in the branch");
    sh(wt, "rm", "-q", "-r", "chats");
    sh(wt, "-c", "commit.gpgsign=false", "commit", "-q", "-m", "remove it");
    writeFileSync(join(wt, "code.ts"), "x\n");
    sh(wt, "add", "code.ts");
    sh(wt, "-c", "commit.gpgsign=false", "commit", "-q", "-m", "code");
    const w = { branch: "sova/feature", path: wt, target: "master", base: sh(top, "rev-parse", "master") } as unknown as WorktreeRecord;
    const before = sh(top, "rev-parse", "master");
    await assert.rejects(mergeBack(w, top, "Feature"), (err: any) => {
      assert.match(err.message, /history carries saved sessions/);
      assert.match(err.message, /press Merge Anyway\.$/, "the operator's words, not the agent's");
      assert.deepEqual(err.savedSessions.commits.map((c: any) => c.subject).sort(), ["remove it", "save a chat in the branch"]);
      return true;
    });
    assert.equal(sh(top, "rev-parse", "master"), before, "nothing merged");
    const m = await mergeBack(w, top, "Feature", undefined, { allowSavedSessions: true });
    assert.equal(sh(top, "rev-parse", "master"), m.sha);
  });
});

/** The far side of a target, here: `sh -c` in the folder, as runOnTarget's builder composes it. */
const localFar = (target: string, command: string, cwd: string, timeoutMs: number): Promise<TargetRunResult> =>
  new Promise((resolve) => {
    const child = spawn("sh", ["-c", `cd -- "$1" || exit 1\n${command}`, "sh", cwd], { env: ENV });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.stdout.on("data", (b: Buffer) => out.push(b));
    child.stderr.on("data", (b: Buffer) => err.push(b));
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ ok: true, run: { code, stdout: Buffer.concat(out).toString("utf8"), stderr: Buffer.concat(err).toString("utf8"), timedOut: false } } as TargetRunResult);
    });
    void target;
  });

describe("on a remote target", () => {
  test("the framed runner carries large input and output whole, and saves without touching the checkout", async () => {
    const bare = origin("remote");
    const far = clone(bare, "far", "Remy");
    const git = remoteGit("t1", far, 120_000, localFar);
    const big = `${"é€ unicode and a long line ".repeat(60_000)}\nend\n`; // ~1.7 MB, multibyte
    const before = untouched(far);
    const r = await applySaved(git, { push: true, message: "", plan: async () => ({ change: { write: { "sessions/remote01/transcript.jsonl": big } }, result: 1, message: "Save session: remote (v1)" }) });
    assert.equal(r.pushed, true, r.pushError);
    assert.deepEqual(untouched(far), before);
    assert.equal(await readPath(git, SAVED_SESSIONS_REF, "sessions/remote01/transcript.jsonl"), big);
    assert.equal(sh(bare, "cat-file", "-s", `${SAVED_SESSIONS_REF}:sessions/remote01/transcript.jsonl`), String(Buffer.byteLength(big)));
    const failed = await git(["rev-parse", "--verify", "--quiet", "refs/heads/nope"]);
    assert.equal(failed.code, 1);
  });
});
