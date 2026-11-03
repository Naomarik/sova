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
