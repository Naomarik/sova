// Projects get git's scheduled maintenance (server/git-maintenance.ts). Real git, in throwaway
// repositories, with a throwaway global config (HOME, GIT_CONFIG_GLOBAL): the user's own config
// and timers are never touched. `git maintenance start` is a stand-in that only records the call.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { gitMaintenanceOn, gitProcesses, MAINTENANCE_KEYS, mainCheckoutOf, recoverStaleLocks, syncGitMaintenance, type GitRun, type MaintenanceDeps } from "./git-maintenance";

const tmp = realpathSync(mkdtempSync(join(tmpdir(), "sova-gitmaint-")));
after(() => rmSync(tmp, { recursive: true, force: true }));
let n = 0;

/** A world: its own HOME and global config, a git that uses them, and a record of every call. */
function world() {
  const home = join(tmp, `home-${n++}`);
  mkdirSync(home, { recursive: true });
  const env: Record<string, string> = { PATH: process.env.PATH ?? "", HOME: home, XDG_CONFIG_HOME: join(home, ".config"), GIT_CONFIG_GLOBAL: join(home, ".gitconfig"), GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" };
  const calls: string[][] = [];
  const git: GitRun = async (args, cwd) => {
    calls.push(args);
    if (args.includes("maintenance") && args.includes("start")) return { code: 0, stdout: "", stderr: "" }; // never a real timer
    try {
      return { code: 0, stdout: execFileSync("git", args, { cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }), stderr: "" };
    } catch (err) {
      const e = err as { status?: number; stdout?: string; stderr?: string };
      return { code: e.status ?? 1, stdout: String(e.stdout ?? ""), stderr: String(e.stderr ?? "") };
    }
  };
  const logs: string[] = [];
  const deps: MaintenanceDeps = { git, recordPath: join(home, "state", "git-maintenance.json"), log: (l) => logs.push(l) };
  const sh = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  const tryGet = (cwd: string, ...args: string[]) => {
    try {
      return sh(cwd, ...args);
    } catch {
      return null;
    }
  };
  const repo = (name: string) => {
    const dir = join(home, name);
    mkdirSync(dir, { recursive: true });
    sh(dir, "init", "-q", "-b", "main");
    sh(dir, "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "-c", "maintenance.auto=false", "commit", "-q", "--allow-empty", "-m", "init");
    return realpathSync(dir);
  };
  const registered = () => (tryGet(home, "config", "--global", "--get-all", "maintenance.repo") ?? "").split("\n").filter(Boolean);
  const local = (dir: string) => Object.fromEntries(MAINTENANCE_KEYS.map(([k]) => [k, tryGet(dir, "config", "--local", "--get", k)]));
  const record = () => JSON.parse(readFileSync(deps.recordPath, "utf8"));
  return { home, env, calls, deps, logs, sh, repo, registered, local, record };
}

const SOVA_VALUES = Object.fromEntries(MAINTENANCE_KEYS);

test("off under SOVA_GIT_MAINTENANCE=off, on otherwise", () => {
  assert.equal(gitMaintenanceOn({ SOVA_GIT_MAINTENANCE: "off" }), false);
  assert.equal(gitMaintenanceOn({ SOVA_GIT_MAINTENANCE: " OFF " }), false);
  assert.equal(gitMaintenanceOn({}), true);
});

test("a project's repository is registered once, with its keys, and the scheduler starts once", async () => {
  const w = world();
  const a = w.repo("a");
  const linked = join(w.home, "a-wt");
  w.sh(a, "worktree", "add", "-q", "-b", "wt", linked);
  const plain = join(w.home, "plain");
  mkdirSync(plain);
  assert.equal(await mainCheckoutOf(w.deps.git, linked), a, "a linked worktree belongs to its main checkout");
  assert.equal(await mainCheckoutOf(w.deps.git, plain), null);
  await syncGitMaintenance([a, linked, plain, join(w.home, "gone")], w.deps);
  assert.deepEqual(w.registered(), [a]);
  assert.deepEqual(w.local(a), SOVA_VALUES);
  assert.equal(w.calls.filter((c) => c.includes("start")).length, 1);
  assert.deepEqual(Object.keys(w.record().repos), [a]);
  assert.ok(w.record().started?.at);
  // Again: nothing more is registered, set or started.
  const before = w.calls.length;
  await syncGitMaintenance([a, linked, plain], w.deps);
  assert.deepEqual(w.calls.slice(before).filter((c) => c.includes("register") || c.includes("start") || (c[0] === "config" && c.length === 4)), []);
  assert.deepEqual(w.registered(), [a]);
  assert.deepEqual(w.logs, []);
});

test("a repository no project holds any longer: unregistered, and each key Sova set put back", async () => {
  const w = world();
  const a = w.repo("a");
  w.sh(a, "config", "--local", "maintenance.strategy", "gc"); // the user's own, before Sova
  await syncGitMaintenance([a], w.deps);
  assert.deepEqual(w.local(a), SOVA_VALUES);
  w.sh(a, "config", "--local", "gc.worktreePruneExpire", "3.months.ago"); // changed since Sova set it: theirs now
  await syncGitMaintenance([], w.deps);
  assert.deepEqual(w.registered(), []);
  assert.deepEqual(w.local(a), { "maintenance.auto": null, "maintenance.strategy": "gc", "maintenance.prefetch.enabled": null, "maintenance.worktree-prune.enabled": null, "gc.worktreePruneExpire": "3.months.ago", "maintenance.gc.enabled": null, "maintenance.gc.schedule": null });
  assert.deepEqual(w.record().repos, {});
});

test("a registration Sova didn't add is never removed", async () => {
  const w = world();
  const a = w.repo("a");
  const b = w.repo("b");
  w.sh(b, "maintenance", "register"); // the user's own
  const theirs = w.local(b);
  await syncGitMaintenance([a, b], w.deps);
  assert.deepEqual(w.record().repos[b].registered, false);
  assert.equal(w.calls.filter((c) => c.includes("register")).length, 1, "only a was registered by Sova");
  await syncGitMaintenance([], w.deps);
  assert.deepEqual(w.registered(), [b], "b stays registered; a is gone");
  assert.deepEqual(w.local(b), theirs, "and b's keys are as the user had them");
});

test("a recorded repository whose folder is gone is unregistered from the user's config", async () => {
  const w = world();
  const a = w.repo("a");
  await syncGitMaintenance([a], w.deps);
  rmSync(a, { recursive: true, force: true });
  await syncGitMaintenance([a], w.deps);
  assert.deepEqual(w.registered(), []);
  assert.equal(existsSync(a), false);
});

test("a failed start is logged and tried again at the next sweep", async () => {
  const w = world();
  const a = w.repo("a");
  let fail = true;
  const git: GitRun = async (args, cwd) => (args.includes("start") && fail ? { code: 1, stdout: "", stderr: "error: no scheduler\n" } : w.deps.git(args, cwd));
  await syncGitMaintenance([a], { ...w.deps, git });
  assert.equal(w.record().started, undefined);
  assert.match(w.logs.join("\n"), /git maintenance start failed: error: no scheduler/);
  fail = false;
  await syncGitMaintenance([a], { ...w.deps, git });
  assert.ok(w.record().started?.at);
});

test("a registered repository runs a weekly gc, and keeps git's own expiries and every worktree", async () => {
  const w = world();
  const a = w.repo("a");
  await syncGitMaintenance([a], w.deps);
  assert.equal(w.sh(a, "config", "--get", "maintenance.gc.enabled"), "true");
  assert.equal(w.sh(a, "config", "--get", "maintenance.gc.schedule"), "weekly");
  assert.equal(w.sh(a, "config", "--get", "gc.worktreePruneExpire"), "never");
  // No expiry shortened: none of them is set, so git's defaults (2 weeks, 90/30 days) stand.
  for (const k of ["gc.pruneExpire", "gc.reflogExpire", "gc.reflogExpireUnreachable"]) assert.throws(() => w.sh(a, "config", "--get", k), k);
});

test("a repository registered before the gc keys existed gets them at the next sweep, its earlier values recorded", async () => {
  const w = world();
  const a = w.repo("a");
  await syncGitMaintenance([a], w.deps);
  // As a record written before the keys were added would read: no gc keys, and none set.
  const rec = w.record();
  delete rec.repos[a].before["maintenance.gc.enabled"];
  delete rec.repos[a].before["maintenance.gc.schedule"];
  writeFileSync(w.deps.recordPath, JSON.stringify(rec));
  w.sh(a, "config", "--local", "--unset", "maintenance.gc.enabled");
  w.sh(a, "config", "--local", "maintenance.gc.schedule", "daily"); // the user's own, before
  await syncGitMaintenance([a], w.deps);
  assert.deepEqual([w.sh(a, "config", "--get", "maintenance.gc.enabled"), w.sh(a, "config", "--get", "maintenance.gc.schedule")], ["true", "weekly"]);
  assert.deepEqual([w.record().repos[a].before["maintenance.gc.enabled"], w.record().repos[a].before["maintenance.gc.schedule"]], [null, "daily"]);
  await syncGitMaintenance([], w.deps);
  assert.equal(w.sh(a, "config", "--get", "maintenance.gc.schedule"), "daily", "put back on unregister");
});

/** A lock file in `repo`'s git folder, `ageMs` old. */
function lock(repo: string, rel: string, ageMs: number): string {
  const p = join(repo, ".git", rel);
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, "");
  const t = (Date.now() - ageMs) / 1000;
  utimesSync(p, t, t);
  return p;
}
const H = 60 * 60_000;

test("a cut-off run's locks over an hour old are removed when no git works in the repository; a fresh one, index.lock and a ref lock never", async () => {
  const w = world();
  const a = w.repo("a");
  const old = lock(a, "objects/maintenance.lock", 2 * H);
  const gcPid = lock(a, "gc.pid", 2 * H);
  const fresh = lock(a, "objects/pack/multi-pack-index.lock", 5 * 60_000);
  const index = lock(a, "index.lock", 2 * H);
  const ref = lock(a, "refs/heads/main.lock", 2 * H);
  assert.notEqual(gitProcesses(), null, "this host's process table is readable");
  const removed = await recoverStaleLocks(a, w.deps);
  assert.deepEqual(removed.sort(), [old, gcPid].sort());
  assert.deepEqual([existsSync(old), existsSync(gcPid), existsSync(fresh), existsSync(index), existsSync(ref)], [false, false, true, true, true]);
  assert.equal(w.logs.filter((l) => l.includes("removed the stale lock")).length, 2, "each removal logged");
});

test("a stale lock stays while a git process works in the repository or one of its worktrees, and when the process table can't be read", async () => {
  const w = world();
  const a = w.repo("a");
  const wt = join(w.home, "a-wt");
  w.sh(a, "worktree", "add", "-q", "-b", "wt", wt);
  const p = lock(a, "objects/maintenance.lock", 2 * H);
  for (const cwd of [a, wt]) {
    // A git that keeps running (it waits on its stdin) with its working folder there.
    const git = spawn("git", ["cat-file", "--batch"], { cwd, env: w.env, stdio: ["pipe", "ignore", "ignore"] });
    try {
      for (let i = 0; i < 50 && !gitProcesses()?.some((g) => g.pid === git.pid); i++) await new Promise((r) => setTimeout(r, 20));
      assert.ok(gitProcesses()?.some((g) => g.pid === git.pid), "the running git is seen");
      assert.deepEqual(await recoverStaleLocks(a, w.deps), [], cwd);
      assert.equal(existsSync(p), true);
    } finally {
      git.stdin?.end();
      git.kill();
      await new Promise((r) => git.once("exit", r));
    }
  }
  // No process table (macOS, or a restricted /proc): unsure, so nothing goes.
  assert.deepEqual(await recoverStaleLocks(a, { ...w.deps, procRoot: join(w.home, "no-proc") }), []);
  assert.equal(existsSync(p), true);
  assert.match(w.logs.join("\n"), /can't tell whether a git is working there/);
  // The sweep itself recovers it once no git is there.
  await syncGitMaintenance([a], w.deps);
  assert.equal(existsSync(p), false);
});
