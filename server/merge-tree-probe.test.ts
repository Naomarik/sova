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
import { driverFromTop, honoursAttrTree, parseDrivers, trialMergeTree } from "./merge-tree-probe";
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
  test("attr.tree is honoured from git 2.43; what can't be read as a version is no", () => {
    for (const v of ["git version 2.43.0", "git version 2.54.0\n", "git version 2.100.1", "git version 3.0.0", "git version 2.47.1 (Apple Git-154)"]) assert.equal(honoursAttrTree(v), true, v);
    for (const v of ["git version 2.42.4", "git version 2.39.5 (Apple Git-154)", "git version 1.99.0", "git version 2.9.0", "", "not git 2.54"]) assert.equal(honoursAttrTree(v), false, v);
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

  describe("on a git that may ignore attr.tree", () => {
    // Real git underneath, so its answer is checked too; only the version it reports is stood in.
    const reporting = (version: string) => {
      const merges: { args: readonly string[]; cwd: string }[] = [];
      const spy: GitRunner = (args, opts) => {
        if (args[0] === "version") return Promise.resolve({ code: 0, stdout: `${version}\n`, stderr: "" });
        if (args.includes("merge-tree")) merges.push({ args, cwd: opts.cwd });
        return execGit(args, opts);
      };
      return { spy, merges };
    };
    const inCheckout = () => git(repo, "merge-tree", "--write-tree", "--no-messages", "master", "side").split("\n")[0];

    test("git 2.42 merges in the checkout, where it reads the attributes, and gets the driver's clean merge", async () => {
      const { spy, merges } = reporting("git version 2.42.4");
      const r = await trialMergeTree(spy, { top: repo, gitDir: commonDir, commonDir, base: "master", head: "side" });
      assert.equal(merges.length, 1);
      assert.equal(merges[0]!.cwd, repo);
      assert.ok(!merges[0]!.args.some((a) => a.startsWith("attr.tree=")), `no setting it would ignore: ${merges[0]!.args.join(" ")}`);
      assert.equal(r.code, 0, r.stderr);
      assert.equal(r.stdout.split("\n")[0], inCheckout());
      assert.deepEqual(leftovers(repo), []);
    });

    test("git 2.43 merges outside the checkout, naming the attributes' tree", async () => {
      const { spy, merges } = reporting("git version 2.43.0");
      const r = await trialMergeTree(spy, { top: repo, gitDir: commonDir, commonDir, base: "master", head: "side" });
      assert.equal(merges.length, 1);
      assert.ok(!merges[0]!.cwd.startsWith(repo), merges[0]!.cwd);
      assert.ok(merges[0]!.args.some((a) => a.startsWith("attr.tree=")), merges[0]!.args.join(" "));
      assert.equal(r.code, 0, r.stderr);
      assert.equal(r.stdout.split("\n")[0], inCheckout());
    });

    test("what the check guards: with no attributes read, this merge is the false conflict", () => {
      // The answer an older git would give outside the checkout: the setting ignored, so no attributes and no driver.
      const away = join(root, "away");
      mkdirSync(away, { recursive: true });
      assert.throws(() => git(away, "--git-dir", commonDir, "merge-tree", "--write-tree", "--no-messages", "master", "side"), (e: { status?: number }) => e.status === 1);
    });

    test("a repository with no attributes needs no check: outside the checkout on any git", async () => {
      const plain = join(root, "plain");
      mkdirSync(plain);
      git(plain, "init", "-q", "-b", "master");
      writeFileSync(join(plain, "y"), "a\n");
      git(plain, "add", "-A");
      git(plain, "commit", "-q", "-m", "base");
      const common = git(plain, "rev-parse", "--path-format=absolute", "--git-common-dir");
      const { spy, merges } = reporting("git version 2.38.0");
      const r = await trialMergeTree(spy, { top: plain, gitDir: common, commonDir: common, base: "master", head: "master" });
      assert.equal(r.code, 0, r.stderr);
      assert.ok(!merges[0]!.cwd.startsWith(plain), merges[0]!.cwd);
    });
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
    const cwds: string[] = [];
    const killerSpy: GitRunner = (args, opts) => {
      if (args.includes("merge-tree")) cwds.push(opts.cwd);
      return killer(args, opts);
    };
    try {
      const r = await trialMergeTree(killerSpy, { top: repo, gitDir: commonDir, commonDir, base: "master", head: "side" });
      assert.ok(killed, "git was killed mid-driver");
      assert.equal(r.code, null);
      assert.deepEqual(leftovers(repo), [], "nothing of git's in the checkout");
      assert.equal(cwds.length, 1);
      assert.ok(!existsSync(cwds[0]!), "git's own folder went with whatever it left");
    } finally {
      // The orphaned driver's sleep.
      stopDriver();
    }
  });
});
