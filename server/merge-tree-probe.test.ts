// The background merged-by-content probes' trial merge (server/merge-tree-probe.ts) on a throwaway repository with a
// merge driver whose command is relative to the checkout (as Sova's spec claims driver is): the same tree as a merge
// run in the checkout, the driver run from the checkout's top, and nothing of git's left in the checkout, even when
// the probe is killed in the middle of the driver.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { driverFromTop, parseDrivers, trialMergeTree } from "./merge-tree-probe";
import { mergedByContent, resetContentMerges } from "./removed-worktrees";
import { execGit, type GitResult, type GitRunner } from "./worktrees";

const root = realpathSync(mkdtempSync(join(tmpdir(), "sova-merge-probe-test-")));
const repo = join(root, "repo");
const log = join(root, "driver.log");
const env = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" };
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const leftovers = (dir: string) => readdirSync(dir).filter((n) => n.startsWith(".merge_file_"));
let commonDir = "";

before(() => {
  mkdirSync(join(repo, "tools"), { recursive: true });
  git(repo, "init", "-q", "-b", "master");
  // A union driver, by a path relative to the checkout: it records where it ran and what it was given.
  writeFileSync(
    join(repo, "tools", "union.sh"),
    `#!/bin/sh\necho "cwd=$(pwd) O=$1 A=$2 B=$3" >> ${JSON.stringify(log)}\nif [ -n "$UNION_HOLD" ] && [ -f "$UNION_HOLD" ]; then echo $$ > "$UNION_HOLD.pid"; touch "$UNION_HOLD.started"; exec sleep 30; fi\ncat "$2" "$3" | awk '!s[$0]++' > "$2.tmp" && mv "$2.tmp" "$2"\n`,
  );
  git(repo, "config", "merge.union-test.driver", "sh tools/union.sh %O %A %B");
  writeFileSync(join(repo, ".gitattributes"), "*.md merge=union-test\n");
  writeFileSync(join(repo, "x.md"), "a\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "base");
  git(repo, "checkout", "-q", "-b", "side");
  writeFileSync(join(repo, "x.md"), "a\nb\n");
  git(repo, "commit", "-q", "-am", "side");
  git(repo, "checkout", "-q", "master");
  writeFileSync(join(repo, "x.md"), "a\nm\n");
  git(repo, "commit", "-q", "-am", "master");
  commonDir = git(repo, "rev-parse", "--path-format=absolute", "--git-common-dir");
});

after(() => rmSync(root, { recursive: true, force: true }));

describe("the trial merge's parts", () => {
  test("a driver runs from the checkout's top with its three inputs named by absolute path; %% stays literal", () => {
    assert.equal(driverFromTop("node tool.mjs %O %A %B %P 100%%", "/r/it's"), `d=$(pwd); cd '/r/it'\\''s' && node tool.mjs "$d"/%O "$d"/%A "$d"/%B %P 100%%`);
  });
  test("the configured drivers, from git config --get-regexp", () => {
    assert.deepEqual(parseDrivers("merge.sova-spec-claims.driver node x.mjs %O %A %B\nmerge.a.b.driver sh y %A\nmerge.empty.driver\n"), [
      { name: "sova-spec-claims", command: "node x.mjs %O %A %B" },
      { name: "a.b", command: "sh y %A" },
    ]);
  });
});

describe("the trial merge", () => {
  test("the same tree as a merge run in the checkout; git runs in a throwaway folder, the driver from the checkout", async () => {
    const inCheckout = git(repo, "merge-tree", "--write-tree", "--no-messages", "master", "side").split("\n")[0];
    writeFileSync(log, "");
    const cwds: string[] = [];
    const spy: GitRunner = (args, opts) => {
      if (args.includes("merge-tree")) cwds.push(opts.cwd);
      return execGit(args, opts);
    };
    const r = await trialMergeTree(spy, { top: repo, gitDir: commonDir, commonDir, base: "master", head: "side" });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.stdout.split("\n")[0], inCheckout, "the driver's union, as in the checkout");
    assert.equal(cwds.length, 1);
    assert.ok(!cwds[0]!.startsWith(`${repo}/`) && cwds[0] !== repo, `git's own folder is outside the checkout: ${cwds[0]}`);
    assert.ok(!existsSync(cwds[0]!), "and it is gone");
    const line = readFileSync(log, "utf8").trim();
    assert.match(line, new RegExp(`^cwd=${repo} O=/`), `the driver ran from the checkout, its inputs absolute: ${line}`);
    assert.ok(!line.includes(`O=${repo}/`), "its inputs are never in the checkout");
    assert.deepEqual(leftovers(repo), []);
  });

  test("merged by content (Clean Up Merged's probe) asks git from outside the checkout", async () => {
    resetContentMerges();
    const cwds: string[] = [];
    const spy: GitRunner = (args, opts) => {
      if (args.includes("merge-tree")) cwds.push(opts.cwd);
      return execGit(args, opts);
    };
    const main = git(repo, "rev-parse", "master");
    const side = git(repo, "rev-parse", "side");
    assert.equal(await mergedByContent(spy, repo, commonDir, main, side), false, "master lacks side's line");
    assert.equal(cwds.length, 1);
    assert.ok(!cwds[0]!.startsWith(repo), cwds[0]);
  });

  test("a probe killed in the middle of the driver leaves no .merge_file_ in the checkout", async () => {
    const hold = join(root, "hold");
    writeFileSync(hold, "");
    let killed = false;
    // A runner that kills git (SIGKILL, as the probes' timeout does) once the driver has started.
    const killer: GitRunner = (args, opts) =>
      args.includes("merge-tree")
        ? new Promise<GitResult>((done) => {
            const child = spawn("git", [...args], { cwd: opts.cwd, env: { ...env, ...opts.env, UNION_HOLD: hold }, stdio: ["ignore", "pipe", "pipe"] });
            const poll = setInterval(() => {
              if (!existsSync(`${hold}.started`)) return;
              clearInterval(poll);
              killed = child.kill("SIGKILL");
            }, 10);
            // "exit", not "close": the orphaned driver still holds git's pipes.
            child.on("exit", (code) => {
              clearInterval(poll);
              done({ code, stdout: "", stderr: "" });
            });
          })
        : execGit(args, opts);
    const stopDriver = () => {
      try {
        process.kill(Number(readFileSync(`${hold}.pid`, "utf8").trim()), "SIGKILL");
      } catch {
        /* gone already */
      }
      rmSync(`${hold}.started`, { force: true });
      rmSync(`${hold}.pid`, { force: true });
    };
    // The control: the same kill of the probe as it ran before (git in the checkout) leaves the driver's inputs there.
    const before = await killer(["merge-tree", "--write-tree", "--no-messages", "master", "side"], { cwd: repo });
    stopDriver();
    assert.ok(killed && before.code === null, "the control was killed mid-driver");
    const left = leftovers(repo);
    assert.ok(left.length > 0, "the control leaves .merge_file_ files in the checkout (else this test proves nothing)");
    for (const f of left) rmSync(join(repo, f));
    killed = false;
    try {
      const r = await trialMergeTree(killer, { top: repo, gitDir: commonDir, commonDir, base: "master", head: "side" });
      assert.ok(killed, "git was killed mid-driver");
      assert.equal(r.code, null);
      assert.deepEqual(leftovers(repo), [], "nothing of git's in the checkout");
      assert.ok(!existsSync(r.cwd), "git's own folder went with whatever it left");
    } finally {
      // The orphaned driver's sleep.
      stopDriver();
    }
  });
});
