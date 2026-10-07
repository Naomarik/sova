// Run: npx tsx --test server/git-summary.integration.test.ts
// Real git against throwaway repositories in the OS temp dir, and a throwaway PI_CODING_AGENT_DIR:
// ~/.pi is never read or written. The remote transport is the real one (targets.runOnTarget → the
// argv builder → runArgv) with a `docker` PATH shim that runs the exec'd argv on this machine, as
// server/targets.test.ts does — so a remote session's read crosses the same quoting it would in
// production, minus the network.
// Real repositories read through the real git script (sh + git) and process groups; the parsers, cache and builder in-process are git-summary.test.ts.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, test } from "node:test";
import type { GitRepoSummary, GitSummary } from "../shared/protocol";

const agentDir = realpathSync(mkdtempSync(join(tmpdir(), "sova-git-test-agent-")));
process.env.PI_CODING_AGENT_DIR = agentDir; // before the modules below compute their paths
const scratch = realpathSync(mkdtempSync(join(tmpdir(), "sova-git-test-")));
after(() => {
  rmSync(agentDir, { recursive: true, force: true });
  rmSync(scratch, { recursive: true, force: true });
});

mkdirSync(join(scratch, "bin"));
writeFileSync(join(scratch, "bin", "docker"), '#!/bin/sh\n[ "$1 $2" = "exec -i" ] || exit 99\nshift 3\nexec "$@"\n');
chmodSync(join(scratch, "bin", "docker"), 0o755);
process.env.PATH = `${join(scratch, "bin")}:${process.env.PATH}`;
writeFileSync(join(agentDir, "targets.json"), JSON.stringify({ version: 1, targets: [{ name: "here", kind: "docker", docker: { container: "box" } }] }));
// Commits in these repos must not depend on the user's git config.
process.env.GIT_CONFIG_GLOBAL = join(scratch, "gitconfig");
process.env.GIT_CONFIG_NOSYSTEM = "1";
writeFileSync(process.env.GIT_CONFIG_GLOBAL, "[user]\n\tname = Test\n\temail = test@example.com\n[init]\n\tdefaultBranch = main\n");

const G = await import("./git-summary");
const T = await import("./targets");

beforeEach(() => G.clearGitCache());

let n = 0;
/** A fresh folder under scratch. */
const fresh = (name = "repo") => {
  const dir = join(scratch, `${name}-${n++}`);
  mkdirSync(dir, { recursive: true });
  return dir;
};
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
const write = (dir: string, rel: string, body: string | Buffer) => {
  mkdirSync(join(dir, rel, ".."), { recursive: true });
  writeFileSync(join(dir, rel), body);
};
/** A repository with one commit holding `files`. */
function repo(files: Record<string, string> = { "a.txt": "1\n2\n3\n" }, subject = "first"): string {
  const dir = fresh();
  git(dir, "init", "-q");
  for (const [rel, body] of Object.entries(files)) write(dir, rel, body);
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", subject);
  return dir;
}
/** The summary of a local cwd, read through the real script. */
const read = (cwd: string, deps: Parameters<typeof G.getGitSummary>[2] = {}) =>
  G.getGitSummary("/sessions/x.jsonl", {}, { storedCwd: async () => cwd, ...deps });
function asRepo(s: GitSummary): GitRepoSummary {
  assert.equal(s.state, "repo", JSON.stringify(s));
  return s as GitRepoSummary;
}

// ---------------------------------------------------------------------------
// real repositories

test("a clean repository: branch, clean, latest commit, and no files", async () => {
  const dir = repo({ "a.txt": "x\n" }, "the first — ünïcode subject");
  const s = asRepo(await read(dir));
  assert.equal(s.root, dir);
  assert.deepEqual(s.head, { kind: "branch", name: "main" });
  assert.equal(s.clean, true);
  assert.equal(s.unborn, false);
  assert.equal(s.upstream, null);
  assert.deepEqual(s.counts, { staged: 0, unstaged: 0, untracked: 0, conflicted: 0 });
  assert.equal(s.lastCommit?.subject, "the first — ünïcode subject");
  assert.equal(s.lastCommit?.oid, git(dir, "rev-parse", "HEAD").trim());
  assert.ok(Math.abs(s.lastCommit!.at - Date.now()) < 120_000);
  assert.deepEqual(s.commits, [s.lastCommit]);
  assert.deepEqual(s.files, []);
  assert.equal(s.lines, "ok");
});

test("the WHOLE repository from a subfolder: root is the top level, paths are root-relative", async () => {
  const dir = repo({ "src/deep/a.ts": "1\n", "top.txt": "t\n" });
  write(dir, "top.txt", "t\nu\n");
  const s = asRepo(await read(join(dir, "src", "deep")));
  assert.equal(s.root, dir);
  assert.equal(s.cwd, join(dir, "src", "deep"));
  assert.deepEqual(s.files.map((f) => f.path), ["top.txt"]);
});

test("staged, unstaged, untracked, deleted and binary: counts, kinds and per-file lines", async () => {
  const dir = repo({ "a.txt": "1\n2\n3\n", "b.txt": "b\n", "gone.txt": "g\ng\n", "img.bin": "\0\x01\x02" });
  write(dir, "a.txt", "1\n2\n3\n4\n5\n"); // unstaged +2
  write(dir, "b.txt", "B\n");
  git(dir, "add", "b.txt"); // staged +1 -1
  write(dir, "b.txt", "B\nC\n"); // and unstaged on top: +1 more against HEAD
  rmSync(join(dir, "gone.txt")); // unstaged delete -2
  write(dir, "img.bin", Buffer.from([0, 9, 9, 9])); // binary
  write(dir, "new.txt", "n\n"); // untracked
  write(dir, "newdir/x.txt", "x\n"); // untracked folder, collapsed by git
  const s = asRepo(await read(dir));
  assert.equal(s.clean, false);
  assert.deepEqual(s.counts, { staged: 1, unstaged: 4, untracked: 2, conflicted: 0 });
  const by = Object.fromEntries(s.files.map((f) => [f.path, f]));
  assert.deepEqual(by["a.txt"], { path: "a.txt", kind: "tracked", unstaged: "modified", lines: { added: 2, removed: 0 } });
  assert.deepEqual(by["b.txt"], { path: "b.txt", kind: "tracked", staged: "modified", unstaged: "modified", lines: { added: 2, removed: 1 } });
  assert.deepEqual(by["gone.txt"]!.lines, { added: 0, removed: 2 });
  assert.equal(by["gone.txt"]!.unstaged, "deleted");
  assert.equal(by["img.bin"]!.lines, "binary");
  assert.deepEqual(by["new.txt"], { path: "new.txt", kind: "untracked", lines: null });
  assert.deepEqual(by["newdir/"], { path: "newdir/", kind: "untracked", lines: null });
  assert.equal(s.added, 4);
  assert.equal(s.removed, 3);
  assert.equal(s.filesTotal, 6);
});

test("renames: a staged rename keeps its source; an unpaired one carries both halves' lines", async () => {
  const dir = repo({ "old.txt": "1\n2\n3\n4\n5\n6\n7\n8\n", "far.txt": "a\nb\n" });
  git(dir, "mv", "old.txt", "new.txt");
  git(dir, "mv", "far.txt", "moved.txt");
  write(dir, "moved.txt", "x\ny\nz\n"); // nothing like the source: the diff can't pair it
  const s = asRepo(await read(dir));
  const by = Object.fromEntries(s.files.map((f) => [f.path, f]));
  assert.equal(by["new.txt"]!.from, "old.txt");
  assert.equal(by["new.txt"]!.staged, "renamed");
  assert.deepEqual(by["new.txt"]!.lines, { added: 0, removed: 0 });
  assert.equal(by["moved.txt"]!.from, "far.txt");
  assert.deepEqual(by["moved.txt"]!.lines, { added: 3, removed: 2 }, "the source's removed lines are this row's");
});

test("unusual paths survive whole: spaces, tabs, newlines, quotes, a leading dash, and non-ASCII", async () => {
  const names = ["with space.txt", "tab\there.txt", "new\nline.txt", `q"u'o\\te.txt`, "-dash.txt", "ünï 文字.txt"];
  const dir = repo(Object.fromEntries(names.map((p) => [p, "1\n"])));
  for (const p of names) write(dir, p, "1\n2\n");
  write(dir, "untracked\nnew.txt", "u\n");
  const s = asRepo(await read(dir));
  assert.deepEqual(s.files.filter((f) => f.kind === "tracked").map((f) => f.path).sort(), [...names].sort());
  for (const f of s.files.filter((f) => f.kind === "tracked")) assert.deepEqual(f.lines, { added: 1, removed: 0 }, f.path);
  assert.ok(s.files.some((f) => f.path === "untracked\nnew.txt" && f.kind === "untracked"));
});

test("an unborn repository: no commit, the branch it will create, lines against the empty tree", async () => {
  const dir = fresh();
  git(dir, "init", "-q");
  write(dir, "a.txt", "1\n2\n");
  git(dir, "add", "a.txt");
  write(dir, "b.txt", "b\n");
  const s = asRepo(await read(dir));
  assert.equal(s.unborn, true);
  assert.deepEqual(s.head, { kind: "branch", name: "main" });
  assert.equal(s.lastCommit, null);
  assert.deepEqual(s.commits, []);
  assert.equal(s.lines, "ok");
  const by = Object.fromEntries(s.files.map((f) => [f.path, f]));
  assert.deepEqual(by["a.txt"]!.lines, { added: 2, removed: 0 });
  assert.equal(by["a.txt"]!.staged, "added");
  assert.equal(by["b.txt"]!.kind, "untracked");
});

test("the log carries the last three commits, newest first, and lastCommit is the newest of them", async () => {
  const dir = repo({ "a.txt": "1\n" }, "first");
  for (const subject of ["second", "third", "fourth"]) {
    write(dir, "a.txt", `${subject}\n`);
    git(dir, "commit", "-qam", subject);
  }
  const s = asRepo(await read(dir));
  assert.equal(G.RECENT_COMMITS, 3);
  assert.deepEqual(s.commits?.map((c) => c.subject), ["fourth", "third", "second"], "the newest first, one per commit, and no further back than three");
  // The oids are the repository's own, in the same order: HEAD, HEAD~1, HEAD~2.
  assert.deepEqual(s.commits?.map((c) => c.oid), ["HEAD", "HEAD~1", "HEAD~2"].map((r) => git(dir, "rev-parse", r).trim()));
  assert.deepEqual(s.lastCommit, s.commits?.[0], "the single field names the same commit as the list's first");
  // Times come from git, and run backwards down the list.
  const times = s.commits!.map((c) => c.at);
  assert.ok(times.every((t) => Math.abs(t - Date.now()) < 120_000), JSON.stringify(times));
  assert.ok(times[0]! >= times[1]! && times[1]! >= times[2]!, JSON.stringify(times));
});

test("a detached HEAD names its commit", async () => {
  const dir = repo();
  const oid = git(dir, "rev-parse", "HEAD").trim();
  git(dir, "checkout", "-q", "--detach");
  assert.deepEqual(asRepo(await read(dir)).head, { kind: "detached", oid });
});

test("upstream ahead/behind come from local refs only — nothing fetches — and a vanished upstream is gone", async () => {
  const origin = fresh("origin");
  git(origin, "init", "-q", "--bare");
  const a = repo();
  git(a, "remote", "add", "origin", origin);
  git(a, "push", "-q", "-u", "origin", "main");
  // Someone else pushes 2 commits; we commit 1 and never fetch.
  const b = fresh("clone");
  git(scratch, "clone", "-q", origin, b);
  for (const k of [1, 2]) {
    write(b, `b${k}.txt`, `${k}\n`);
    git(b, "add", "-A");
    git(b, "commit", "-qm", `b${k}`);
  }
  git(b, "push", "-q");
  write(a, "mine.txt", "m\n");
  git(a, "add", "-A");
  git(a, "commit", "-qm", "mine");
  const before = git(a, "rev-parse", "origin/main").trim();
  let s = asRepo(await read(a));
  assert.deepEqual(s.upstream, { name: "origin/main", ahead: 1, behind: 0 }, "behind stays 0: the far commits were never fetched");
  assert.equal(git(a, "rev-parse", "origin/main").trim(), before, "the remote-tracking ref did not move");
  git(a, "fetch", "-q"); // what the user might do themselves
  G.clearGitCache();
  s = asRepo(await read(a));
  assert.deepEqual(s.upstream, { name: "origin/main", ahead: 1, behind: 2 });
  git(a, "update-ref", "-d", "refs/remotes/origin/main");
  G.clearGitCache();
  assert.deepEqual(asRepo(await read(a)).upstream, { name: "origin/main", gone: true });
});

test("a merge conflict is counted and listed first", async () => {
  const dir = repo({ "c.txt": "base\n", "z.txt": "z\n" });
  git(dir, "checkout", "-qb", "side");
  write(dir, "c.txt", "side\n");
  git(dir, "commit", "-qam", "side");
  git(dir, "checkout", "-q", "main");
  write(dir, "c.txt", "main\n");
  write(dir, "z.txt", "z\nz\n");
  git(dir, "commit", "-qam", "main");
  write(dir, "z.txt", "z\nz\nz\n");
  try {
    git(dir, "merge", "-q", "side");
  } catch {
    // the conflict is the point
  }
  const s = asRepo(await read(dir));
  assert.equal(s.counts.conflicted, 1);
  assert.equal(s.files[0]!.path, "c.txt");
  assert.equal(s.files[0]!.kind, "conflicted");
});

test("read-only: a stat-dirty index is NOT refreshed, and no lock file is left", async () => {
  const dir = repo({ "a.txt": "same\n" });
  const index = join(dir, ".git", "index");
  const past = new Date(Date.now() - 3_600_000);
  utimesSync(join(dir, "a.txt"), past, past); // content unchanged, stat changed: a plain status rewrites the index
  const bytes = readFileSync(index);
  const mtime = statSync(index).mtimeMs;
  const s = asRepo(await read(dir));
  assert.equal(s.clean, true);
  assert.ok(readFileSync(index).equals(bytes), "index bytes unchanged");
  assert.equal(statSync(index).mtimeMs, mtime, "index mtime unchanged");
  assert.equal(existsSync(join(dir, ".git", "index.lock")), false);
  // The control: the same status WITHOUT the flag does write it, so the assertion above can fail.
  git(dir, "status", "--porcelain");
  assert.notEqual(statSync(index).mtimeMs, mtime, "control: a plain git status refreshes the index");
});

test("no repository, a missing folder, and a relative stored cwd", async () => {
  const plain = fresh("plain");
  assert.equal((await read(plain)).state, "none");
  const gone = join(scratch, "never-made");
  const s = await read(gone);
  assert.equal(s.state, "unavailable");
  assert.match((s as { reason: string }).reason, /no longer exists/);
  let ran = false;
  const rel = await read("relative/dir", { runLocal: async () => ((ran = true), { code: 0, stdout: "", truncated: false }) });
  assert.equal(rel.state, "unavailable");
  assert.equal(ran, false, "a relative cwd is never resolved against the server's own folder");
});

test("a session file's header decides the folder", async () => {
  const dir = repo();
  const file = join(scratch, `s-${n++}.jsonl`);
  writeFileSync(file, `${JSON.stringify({ type: "session", version: 3, id: "x", timestamp: "t", cwd: dir })}\n`);
  assert.equal(asRepo(await G.getGitSummary(file)).root, dir);
  const bad = join(scratch, `s-${n++}.jsonl`);
  writeFileSync(bad, "not json\n");
  assert.equal((await G.getGitSummary(bad)).state, "unavailable");
});

// ---------------------------------------------------------------------------
// which folder: remote

test("a remote placeholder runs on its target through the real builder — never locally — and quotes a hostile folder", async () => {
  const hostile = join(scratch, `it's $(touch PWNED) ; "q" repo`);
  mkdirSync(hostile);
  git(hostile, "init", "-q");
  write(hostile, "a.txt", "1\n");
  git(hostile, "add", "-A");
  git(hostile, "commit", "-qm", "far");
  write(hostile, "a.txt", "1\n2\n");
  let local = false;
  const s = await G.getGitSummary("/sessions/x.jsonl", {}, {
    storedCwd: async () => T.targetDir("here", hostile),
    runLocal: async () => ((local = true), { code: 0, stdout: "", truncated: false }),
  });
  assert.equal(local, false);
  const r = asRepo(s);
  assert.deepEqual(r.where, { kind: "remote", target: "here" });
  assert.equal(r.cwd, hostile);
  assert.equal(r.root, hostile);
  assert.deepEqual(r.files.map((f) => [f.path, f.lines]), [["a.txt", { added: 1, removed: 0 }]]);
  assert.equal(existsSync(join(scratch, "PWNED")), false);
  assert.equal(existsSync(join(hostile, "PWNED")), false);
});

test("remote failures say what happened: unknown target, a folder that isn't there, an offline host", async () => {
  const place = (t: string, p: string) => ({ storedCwd: async () => T.targetDir(t, p) });
  const unknown = await G.getGitSummary("/s.jsonl", {}, place("nope", "/x"));
  assert.match((unknown as { reason: string }).reason, /isn't in targets\.json/);
  const missing = await G.getGitSummary("/s.jsonl", {}, place("here", join(scratch, "not-there")));
  assert.match((missing as { reason: string }).reason, /Couldn't enter .* on here/);
  const offline = await G.getGitSummary("/s.jsonl", {}, {
    ...place("here", "/x"),
    runRemote: async () => ({ ok: true, run: { code: 255, stdout: "", stderr: "ssh: connect to host x: No route to host\n", timedOut: false } }),
  });
  assert.equal(offline.state, "unavailable");
  assert.match((offline as { reason: string }).reason, /here didn't answer: ssh: connect to host x: No route to host/);
});

// ---------------------------------------------------------------------------
// cache and in-flight sharing

test("cache: a second read within the TTL runs nothing; fresh re-runs; concurrent reads share one run; failures aren't cached", async () => {
  const dir = repo();
  let runs = 0;
  let clock = 1_000_000;
  const deps = {
    now: () => clock,
    runLocal: async (script: string, cwd: string) => {
      runs++;
      await new Promise((r) => setTimeout(r, 20));
      const out = execFileSync("sh", ["-c", `cd -- "$1" || exit 1\n${script}`, "sh", cwd]);
      return { code: 0, stdout: out.toString("utf8"), truncated: false };
    },
  };
  await Promise.all([read(dir, deps), read(dir, deps), read(dir, deps)]);
  assert.equal(runs, 1, "three concurrent callers, one run");
  await read(dir, deps);
  assert.equal(runs, 1, "inside the TTL: served from the cache");
  await G.getGitSummary("/s.jsonl", { fresh: true }, { storedCwd: async () => dir, ...deps });
  assert.equal(runs, 2, "fresh skips the cache");
  clock += G.GIT_TTL_MS;
  await read(dir, deps);
  assert.equal(runs, 3, "past the TTL: read again");

  let fails = 0;
  const failing = { runLocal: async () => ((fails++), { code: 1, stdout: "", truncated: false }), exists: () => true };
  await read(dir, failing);
  await read(dir, failing);
  assert.equal(fails, 2, "an unavailable answer is never cached");
});

// ---------------------------------------------------------------------------
// the framing and parsers, including every way a section can be cut

const nonce = "00112233445566778899aabb";
const mk = (name: string, code: string | number) => `\0@@${nonce}:${name}:${code}@@\0`;

test("a repository root with newlines in its name — inside and at the end — comes back whole", async () => {
  for (const name of ["new\nline root", "ends in newline\n"]) {
    const dir = join(scratch, `nl-${n++}`, name);
    mkdirSync(join(dir, "sub"), { recursive: true });
    git(dir, "init", "-q");
    write(dir, "sub/a.txt", "1\n");
    git(dir, "add", "-A");
    git(dir, "commit", "-qm", "c");
    write(dir, "sub/a.txt", "1\n2\n");
    const s = asRepo(await read(join(dir, "sub")));
    assert.equal(s.root, dir, JSON.stringify(s.root));
    assert.deepEqual(s.files.map((f) => [f.path, f.lines]), [["sub/a.txt", { added: 1, removed: 0 }]]);
  }
});

test("execGroup: a timeout kills the whole process group — the control shows killing the shell alone doesn't", async () => {
  const { execBounded } = await import("./files");
  const alive = (pid: number) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  // A shell waiting on a long child, as the script waits on a git with no timeout(1) around it.
  const run = async (exec: typeof G.execGroup) => {
    const pidFile = join(scratch, `pid-${n++}`);
    await assert.rejects(exec(["sh", "-c", `sleep 30 & echo $! > "$1"; wait`, "sh", pidFile], { timeoutMs: 300, byteCap: 1024 }), /timed out/);
    await new Promise((r) => setTimeout(r, 150));
    return Number(readFileSync(pidFile, "utf8"));
  };
  const grouped = await run(G.execGroup);
  assert.equal(alive(grouped), false, "the child of the killed shell is gone too");
  const control = await run(execBounded);
  try {
    assert.equal(alive(control), true, "control: killing only the shell leaves its child running");
  } finally {
    try {
      process.kill(control, "SIGKILL");
    } catch {
      // already gone
    }
  }
});

test("execGroup caps stdout by bytes and kills the group at the cap", async () => {
  const r = await G.execGroup(["sh", "-c", "yes 0123456789"], { timeoutMs: 5_000, byteCap: 1000 });
  assert.equal(r.truncated, true);
  assert.equal(Buffer.byteLength(r.stdout), 1000);
});

// ---------------------------------------------------------------------------
// runArgv now decodes once: a character split across two chunks survives

test("runArgv decodes a multi-byte character split across two stdout chunks", async () => {
  const src = `process.stdout.write(Buffer.from([0xe6, 0x96])); setTimeout(() => process.stdout.write(Buffer.from([0x87, 0x0a])), 50);`;
  const r = await T.runArgv([process.execPath, "-e", src], 5_000);
  assert.equal(r.stdout, "文\n");
  assert.equal(r.stdoutTruncated, undefined);
});
