import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { dirtyWhy } from "./land";
import { realGit, statusArgs } from "./guard";

const sh = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8" }).trim();

test("the queue's status probe never rewrites a worktree's index (no index.lock taken); a plain status would", async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "mq-probe-")));
  try {
    sh(dir, "init", "-q", "-b", "master");
    writeFileSync(join(dir, "a.txt"), "a\n");
    sh(dir, "add", "-A");
    sh(dir, "commit", "-q", "-m", "a");
    const index = join(dir, ".git", "index");
    // A stat-dirty file (same content, newer mtime): status would refresh the index and write it.
    const stale = () => {
      const t = new Date(Date.now() + 5_000);
      utimesSync(join(dir, "a.txt"), t, t);
      const old = new Date(Date.now() - 60_000);
      utimesSync(index, old, old);
      return statSync(index).mtimeMs;
    };
    let before = stale();
    const r = await realGit(statusArgs("--porcelain"), dir);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.stdout.trim(), "");
    assert.equal(await dirtyWhy(realGit, dir), null);
    assert.equal(statSync(index).mtimeMs, before, "the probe left the index alone");
    // The case it rules out: a plain status writes it (so the check can tell the two apart).
    before = stale();
    sh(dir, "status", "--porcelain");
    assert.notEqual(statSync(index).mtimeMs, before, "a plain status rewrote the index");
    // A probe while someone else holds index.lock still answers, and leaves their lock alone.
    writeFileSync(join(dir, ".git", "index.lock"), "");
    assert.equal((await realGit(statusArgs("--porcelain"), dir)).code, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("every git status the queue runs goes through statusArgs", () => {
  const here = new URL(".", import.meta.url);
  const files = readdirSync(here).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts") && f !== "guard.ts");
  for (const f of files) assert.doesNotMatch(readFileSync(new URL(f, here), "utf8"), /\[\s*"status"/, `${f}: a git status without statusArgs`);
  assert.deepEqual(statusArgs("--porcelain").slice(0, 4), ["--no-optional-locks", "-c", "core.fsmonitor=false", "status"]);
});

test("a branch's own newer commits: first-parent only, so a merge of the target counts once and the target's commits never count", async () => {
  const { execFileSync } = await import("node:child_process");
  const { writeFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { scratchRoot } = await import("../test-scratch");
  const { ownCommitsPast, countBetween, realGit } = await import("./guard");
  const dir = scratchRoot("mq-own-commits-");
  const g = (...a: string[]) => execFileSync("git", ["-c", "commit.gpgsign=false", "-c", "user.name=t", "-c", "user.email=t@example.invalid", ...a], { cwd: dir, encoding: "utf8" }).trim();
  const commit = (f: string, m: string) => (writeFileSync(join(dir, f), m), g("add", f), g("commit", "-q", "-m", m), g("rev-parse", "HEAD"));
  g("init", "-q", "-b", "master");
  commit("a", "base");
  g("checkout", "-q", "-b", "feat/x");
  const sent = commit("b", "the sent-back commit");
  g("checkout", "-q", "master");
  for (let i = 0; i < 5; i++) commit(`m${i}`, `master ${i}`);
  const head = g("rev-parse", "HEAD");
  g("checkout", "-q", "feat/x");
  g("merge", "-q", "--no-edit", "master");
  const tip = commit("c", "the fix");
  const git = realGit;
  assert.equal(await countBetween(git, dir, sent, tip), 7, "plain counting brings the target's commits in");
  assert.equal(await ownCommitsPast(git, dir, sent, tip, head), 2, "the merge of master and the fix");
  assert.equal(await ownCommitsPast(git, dir, sent, sent, head), 0);
});
