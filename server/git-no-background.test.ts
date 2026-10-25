// The server's own git commands start no background cleanup (§app.git-cleanup/no-background), and
// the way they say so never reaches the server's environment (§app/idle-git-cache). Real git in
// throwaway repositories, judged by git's own trace2 event log: a `child_start` of
// `git maintenance` (or `gc`) is exactly the background cleanup starting.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import type { Git } from "../pi-config/extensions/worktrees/git.ts";
import { runGit } from "../pi-config/extensions/worktrees/git.ts";
import { NO_BACKGROUND_CLEANUP } from "./git-no-background";
import { commitSpec, cutWorktree, gitRootOf, mergeBack, specSnapshot } from "./project-worktrees";
import { commitAll, commitPaths } from "./workspace-git";
import { historyToken } from "./worktrees";

const tmp = realpathSync(mkdtempSync(join(tmpdir(), "sova-nobg-")));
after(() => rmSync(tmp, { recursive: true, force: true }));

const sh = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
let n = 0;
/** A repository with one commit whose OWN config asks for background cleanup after every command
    (maintenance.auto=true, gc.auto=1), whatever the system or global config around the test says:
    only a command-line `-c` can still turn it off. */
function repo(): string {
  const dir = join(tmp, `r${n++}`, "client");
  mkdirSync(join(dir, ".sova", "spec"), { recursive: true });
  sh(dir, "init", "-q", "-b", "master");
  for (const [k, v] of [["user.email", "t@example.invalid"], ["user.name", "T"], ["commit.gpgsign", "false"], ["maintenance.auto", "true"], ["gc.auto", "1"]]) sh(dir, "config", k!, v!);
  writeFileSync(join(dir, ".sova", "spec", "manifest.json"), "{}\n");
  writeFileSync(join(dir, "README.md"), "hi\n");
  sh(dir, "add", "-A");
  sh(dir, "-c", "maintenance.auto=false", "commit", "-q", "-m", "init");
  return dir;
}

/** Run `fn` with git's trace2 event log on (inherited by every git the code under test spawns);
    the argv of each background cleanup started meanwhile. */
async function cleanupsStartedBy(fn: () => Promise<unknown>): Promise<string[][]> {
  const file = join(tmp, `trace-${n++}.json`);
  const before = process.env.GIT_TRACE2_EVENT;
  process.env.GIT_TRACE2_EVENT = file;
  try {
    await fn();
  } finally {
    if (before === undefined) delete process.env.GIT_TRACE2_EVENT;
    else process.env.GIT_TRACE2_EVENT = before;
  }
  if (!existsSync(file)) return [];
  const out: string[][] = [];
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    const e = JSON.parse(line) as { event?: string; argv?: string[] };
    if (e.event === "child_start" && e.argv?.some((a) => a === "maintenance" || a === "gc" || /\bgit (maintenance|gc)\b/.test(a))) out.push(e.argv);
  }
  return out;
}

test("the flags stop git's background cleanup, and the trace tells a commit with them from one without", async () => {
  const dir = repo();
  writeFileSync(join(dir, "a.txt"), "a\n");
  sh(dir, "add", "a.txt");
  const without = await cleanupsStartedBy(async () => sh(dir, "commit", "-q", "-m", "plain"));
  assert.equal(without.length, 1, "the control: a plain commit starts one");
  writeFileSync(join(dir, "b.txt"), "b\n");
  sh(dir, "add", "b.txt");
  assert.deepEqual(await cleanupsStartedBy(async () => sh(dir, ...NO_BACKGROUND_CLEANUP, "commit", "-q", "-m", "flagged")), []);
});

test("an organization workspace's commits and pushes start none", async () => {
  const origin = join(tmp, `origin-${n++}.git`);
  execFileSync("git", ["init", "-q", "--bare", origin]);
  // The origin wants cleanup after every push (gc.auto=1) and leaves maintenance.auto to the
  // levels around it: a repository's own maintenance.auto=true would win over any system config.
  sh(origin, "config", "gc.auto", "1");
  const dir = repo();
  sh(dir, "remote", "add", "origin", origin);
  // The control: a plain push into it starts one on the receiving side (where `-c` never arrives).
  writeFileSync(join(dir, "first.txt"), "1\n");
  sh(dir, "add", "first.txt");
  sh(dir, "-c", "maintenance.auto=false", "commit", "-q", "-m", "first");
  const plain = await cleanupsStartedBy(async () => execFileSync("git", [...NO_BACKGROUND_CLEANUP, "push", "-q", "origin", "HEAD"], { cwd: dir, env: { ...process.env, GIT_CONFIG_SYSTEM: "/dev/null" } }));
  assert.equal(plain.length, 1, "a push with only the flags still starts one in a local origin");
  writeFileSync(join(dir, "org.json"), "{}\n");
  let outcome: Awaited<ReturnType<typeof commitAll>> | undefined;
  const started = await cleanupsStartedBy(async () => (outcome = await commitAll(dir, "org: settings")));
  assert.deepEqual([outcome?.committed, outcome?.pushed, outcome?.error], [true, true, undefined]);
  assert.equal(sh(dir, "log", "-1", "--format=%s"), "org: settings");
  assert.equal(sh(origin, "log", "-1", "--format=%s", "master"), "org: settings", "the push reached the origin");
  assert.deepEqual(started, []);
});

test("Merge Branch and a promotion commit carry the flags and start none", async () => {
  const root = repo();
  const seen: (readonly string[])[] = [];
  const spy: Git = (args, cwd) => {
    seen.push(args);
    return runGit(args, cwd);
  };
  const gr = await gitRootOf(root);
  if ("reason" in gr) throw new Error(gr.reason);
  const cut = await cutWorktree(gr, root, "No cleanup", undefined, "nobg01");
  writeFileSync(join(cut.worktree.path, "f.txt"), "f\n");
  sh(cut.worktree.path, "add", "f.txt");
  sh(cut.worktree.path, "-c", "maintenance.auto=false", "commit", "-q", "-m", "f");
  const merged = await cleanupsStartedBy(() => mergeBack(cut.worktree, root, "No cleanup", spy));
  const snap = await specSnapshot(root, spy);
  assert.ok(snap);
  writeFileSync(join(root, ".sova", "spec", "manifest.json"), '{"claims":{}}\n');
  const promoted = await cleanupsStartedBy(() => commitSpec(snap, "Promote: nothing", spy));
  assert.deepEqual([merged, promoted], [[], []]);
  const writes = seen.filter((a) => a.includes("merge") && !a.includes("--abort") || a.includes("commit"));
  assert.equal(writes.length, 2, JSON.stringify(seen));
  for (const a of writes) assert.ok(NO_BACKGROUND_CLEANUP.every((f, i) => a[a.indexOf("maintenance.auto=false") - 1 + i] === f), a.join(" "));
});

test("the flags never reach the server's environment, so the idle git cache keeps its history token", async () => {
  const dir = repo();
  writeFileSync(join(dir, "x.txt"), "x\n");
  await commitPaths(dir, ["x.txt"], "x");
  assert.equal(process.env.GIT_CONFIG_COUNT, undefined);
  assert.equal(process.env.GIT_CONFIG_PARAMETERS, undefined);
  const gitDir = join(dir, ".git");
  assert.notEqual(historyToken({ top: dir, linked: false, commonDir: gitDir, gitDir }), null);
});

// ---- the ratchet: every git command in server/ that can start background cleanup carries the flags ----

/** Porcelain commands that start git's background cleanup when they write. */
const STARTS_CLEANUP = new Set(["commit", "merge", "fetch", "pull", "rebase", "am", "cherry-pick", "revert", "push"]);
/** Files whose own git helper puts NO_BACKGROUND_CLEANUP before every command (checked below). */
const HELPER_PREFIXED: Record<string, RegExp> = { "server/workspace-git.ts": /const NON_INTERACTIVE = \[[^\]]*\.\.\.NO_BACKGROUND_CLEANUP\]/ };
/** In those files a push still needs the env (the prefix's `-c` doesn't cross into a local origin). */
const pushesWithoutEnv = (text: string) => text.split("\n").filter((l) => /\["push"/.test(l) && !l.includes("noBackgroundCleanupEnv()"));

/** The git argv literals of `source` that can start background cleanup and say nothing to stop it. */
export function unflagged(source: string): string[] {
  const out: string[] = [];
  for (const line of source.split("\n")) {
    if (!/git|run|must/i.test(line)) continue;
    for (const m of line.matchAll(/\[([^[\]]*)\]/g)) {
      const words = [...m[1]!.matchAll(/"([^"]*)"/g)].map((x) => x[1]!);
      if (!words.some((w) => STARTS_CLEANUP.has(w)) || words.includes("--abort")) continue;
      // A push needs the env: git drops `-c` when it starts a local receiving repository's side.
      if (words.includes("push") ? line.includes("noBackgroundCleanupEnv()") : m[1]!.includes("...NO_BACKGROUND_CLEANUP") || words.includes("--no-auto-gc") || words.includes("--no-auto-maintenance")) continue;
      out.push(line.trim());
    }
  }
  return out;
}

test("the ratchet finds a git write without the flags, and passes one with them", () => {
  assert.deepEqual(unflagged('const r = await git(["commit", "-m", m], root);'), ['const r = await git(["commit", "-m", m], root);']);
  assert.deepEqual(unflagged('const r = await git([...NO_BACKGROUND_CLEANUP, "commit", "-m", m], root);'), []);
  assert.deepEqual(unflagged('await git(["merge", "--abort"], root);'), []);
  assert.deepEqual(unflagged('await git(["merge-base", "--is-ancestor", a, b], root);'), []);
  assert.deepEqual(unflagged('await git([...NO_BACKGROUND_CLEANUP, "push", "origin"], root);'), ['await git([...NO_BACKGROUND_CLEANUP, "push", "origin"], root);'], "a push needs the env, not the flags");
  assert.deepEqual(pushesWithoutEnv('const p = await git(dir, ["push", "-q", "origin", "HEAD"]);'), ['const p = await git(dir, ["push", "-q", "origin", "HEAD"]);']);
  assert.deepEqual(pushesWithoutEnv('const p = await git(dir, ["push", "-q", "origin", "HEAD"], noBackgroundCleanupEnv());'), []);
});

test("every git command in server/ that can start background cleanup carries the flags", () => {
  const files: string[] = [];
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (p.endsWith(".ts") && !/\.test\.ts$|\.fixture\.ts$|\/testing\.ts$|\/testing\//.test(p)) files.push(p);
    }
  };
  walk("server");
  assert.ok(files.length > 100, "found the server's sources");
  const misses: string[] = [];
  for (const f of files) {
    const text = readFileSync(f, "utf8");
    const prefix = HELPER_PREFIXED[f];
    if (prefix) {
      assert.match(text, prefix, `${f}'s git helper no longer prefixes NO_BACKGROUND_CLEANUP`);
      for (const line of pushesWithoutEnv(text)) misses.push(`${f}: ${line.trim()}`);
      continue;
    }
    for (const line of unflagged(text)) misses.push(`${f}: ${line}`);
  }
  assert.deepEqual(misses, []);
});
