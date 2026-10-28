// The whole loop, for real (integration: it runs bubblewrap): about 7,000 loose objects made by a
// commit through the sandboxed command path start no cleanup there, and the maintenance Sova
// registered, run the way git's own timer runs it, brings the loose count below gc.auto. A
// throwaway HOME and global config; the scheduler itself is never started.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import type { Policy } from "../pi-config/extensions/sandbox/backend.ts";
import { findExecutable, LinuxBwrapBackend, runCapture } from "../pi-config/extensions/sandbox/backends/linux-bwrap.ts";
import { scrubEnv } from "../pi-config/extensions/sandbox/env.ts";
import { syncGitMaintenance, type GitRun } from "./git-maintenance";

const tmp = realpathSync(mkdtempSync(join(tmpdir(), "sova-gitmaint-int-")));
after(() => rmSync(tmp, { recursive: true, force: true }));
const skip = process.platform === "linux" && findExecutable("bwrap") ? false : "needs bubblewrap (Linux)";
/** git's own default (`gc.auto`): past this many loose objects, git calls a repository untidy. */
const GC_AUTO_DEFAULT = 6700;

test("loose objects from a sandboxed commit are packed away by the registered maintenance, not by the commit", { skip, timeout: 240_000 }, async () => {
  const home = join(tmp, "home");
  mkdirSync(home);
  // The timer's world: the throwaway global config, and no git config variable of any caller's.
  const env: Record<string, string> = { PATH: process.env.PATH ?? "", HOME: home, XDG_CONFIG_HOME: join(home, ".config"), GIT_CONFIG_GLOBAL: join(home, ".gitconfig"), GIT_CONFIG_NOSYSTEM: "1" };
  const sh = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  const loose = (dir: string) => Number(/^count: (\d+)$/m.exec(sh(dir, "count-objects", "-v"))![1]);
  const repo = join(home, "project");
  mkdirSync(repo);
  sh(repo, "init", "-q", "-b", "main");
  const git: GitRun = async (args, cwd) => {
    if (args.includes("start")) return { code: 0, stdout: "", stderr: "" }; // never a real timer
    try {
      return { code: 0, stdout: execFileSync("git", args, { cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }), stderr: "" };
    } catch (err) {
      const e = err as { status?: number; stdout?: string; stderr?: string };
      return { code: e.status ?? 1, stdout: String(e.stdout ?? ""), stderr: String(e.stderr ?? "") };
    }
  };
  await syncGitMaintenance([repo], { git, recordPath: join(home, "git-maintenance.json"), log: (l) => assert.fail(l) });
  assert.deepEqual(sh(home, "config", "--global", "--get-all", "maintenance.repo").split("\n"), [realpathSync(repo)]);

  // Through the sandbox: 7,000 files committed (7,000 blobs, a tree and a commit, all loose). The
  // repository's own config says maintenance.auto=false now, so it is cleared here: only the
  // sandbox's own config stands between this commit and a background cleanup.
  sh(repo, "config", "--local", "--unset", "maintenance.auto");
  const ws = realpathSync(repo);
  const sessionTmp = join(tmp, "session-tmp");
  mkdirSync(sessionTmp);
  const policy: Policy = { level: "workspace-write", workspaceRoot: ws, writable: [ws], readOnlyWithinWritable: [], hidden: [], tmpDir: sessionTmp, network: { mode: "none" }, env: scrubEnv({ ...process.env, HOME: home }), sessionId: "gitmaint" };
  const script = [
    'i=0; while [ $i -lt 7000 ]; do echo "file $i" > "f$i.txt"; i=$((i+1)); done',
    "git add -A",
    "GIT_TRACE2_EVENT=/tmp/trace.json git -c user.name=t -c user.email=t@t -c commit.gpgsign=false commit -q -m bulk",
    "grep -c '\"maintenance\"' /tmp/trace.json || true",
  ].join(" && ");
  const res = await new LinuxBwrapBackend().confine({ argv: ["/bin/sh", "-c", script], cwd: ws, policy });
  assert.ok(res.ok, res.ok ? "" : res.reason);
  const run = await runCapture(res.confined.argv, res.confined.env, 180_000);
  assert.equal(run.code, 0, run.output);
  assert.equal(run.output.trim(), "0", "the commit inside started no maintenance");
  const made = loose(repo);
  assert.ok(made > GC_AUTO_DEFAULT, `${made} loose objects after the commit`);

  // Git's timer runs this per schedule (its systemd unit: `git for-each-repo --keep-going
  // --config=maintenance.repo maintenance run --schedule=%i`). Under the incremental strategy the
  // daily loose-objects pass packs them, and the next one deletes the packed copies.
  const timer = () => execFileSync("git", ["for-each-repo", "--keep-going", "--config=maintenance.repo", "maintenance", "run", "--schedule=daily"], { cwd: home, env, stdio: "pipe" });
  timer();
  timer();
  const left = loose(repo);
  assert.ok(left < GC_AUTO_DEFAULT, `${left} loose objects left after two daily runs (made ${made})`);
});
