// Run: node scripts/run-tests.mjs server/mesh/resync.integration.test.ts
// Mesh version resync (§mesh.peers/resync) against the real parts: relation by a throwaway git
// repo's history, and jobs whose deploy script is a real child (node -e): its output teed, its
// exit code, a run past the recipe's limit. The rest in-process: resync.test.ts.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import type { ResyncJob } from "../../shared/mesh-resync";
import { realGit } from "./build-id";
import { relationOf } from "./resync";
import { PROTO, realScript, resyncKit, skewed, until } from "./resync-test-fixtures";

const tmp = mkdtempSync(join(tmpdir(), "sova-resync-int-"));
after(() => rmSync(tmp, { recursive: true, force: true }));

// ---- a repo: a - b - c on main, d branching from a ----------------------------------------------

const repo = join(tmp, "repo");
mkdirSync(repo);
const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], { cwd: repo, encoding: "utf8" }).trim();
git("init", "-q", "-b", "main");
const commitFile = (name: string) => {
  writeFileSync(join(repo, name), name);
  git("add", name);
  git("commit", "-q", "-m", name);
  return git("rev-parse", "HEAD");
};
const A = commitFile("a");
const B = commitFile("b");
const C = commitFile("c");
git("checkout", "-q", "-b", "side", A);
const D = commitFile("d");
const MISSING = "f".repeat(40);

describe("relation", () => {
  test("behind, ahead, same, diverged and unknown, by this checkout's history", async () => {
    assert.deepEqual(await relationOf(C, A, repo, realGit), { relation: "behind", distance: 2 });
    assert.deepEqual(await relationOf(A, C, repo, realGit), { relation: "ahead", distance: 2 });
    assert.deepEqual(await relationOf(B, B, repo, realGit), { relation: "same" });
    assert.deepEqual(await relationOf(C, D, repo, realGit), { relation: "diverged" });
    assert.deepEqual(await relationOf(C, MISSING, repo, realGit), { relation: "unknown" }, "a commit this checkout lacks");
    assert.deepEqual(await relationOf(C, undefined, repo, realGit), { relation: "unknown" }, "a peer that says no commit");
    assert.deepEqual(await relationOf(undefined, A, repo, realGit), { relation: "unknown" }, "no boot commit here");
  });
});

const { world, service: kitService } = resyncKit({ A, B, C, D, repo, git: realGit }, realScript);
const service = (w: ReturnType<typeof world>, logDir = join(tmp, "logs")) => kitService(w, logDir);
const json = "application/json";

describe("the service with a real deploy child", () => {
  test("a job: the script with the boot commit, its output teed to the log, then the peer's hello until it matches", async () => {
    const w = world();
    const logs = join(tmp, "logs-ok");
    const s = service(w, logs);
    const r = await s.start("vps", { commit: C }, json);
    assert.equal(r.status, 202);
    assert.equal((r.body as ResyncJob).state, "running");
    assert.deepEqual(w.spawned, [[join(repo, "scripts/mesh-vps/deploy.sh"), "--rev", C]]);
    await until(() => s.job("vps")!.state === "waiting");
    // the peer comes back on this host's protocol
    w.probes.vps = { state: "up", hello: { ...skewed().hello!, protocol: PROTO } };
    await until(() => s.job("vps")!.state === "done");
    const job = s.job("vps")!;
    assert.match(job.tail, /deploying/);
    assert.match(job.tail, /to stderr/);
    // The log is written through a stream: its last line lands just after the job reads done.
    const logFile = join(logs, "vps.log");
    await until(() => readFileSync(logFile, "utf8").includes("# done"));
    const log = readFileSync(logFile, "utf8");
    assert.match(log, new RegExp(`# resync vps to ${C}`));
    assert.match(log, /deploying/);
    assert.match(log, /# done/);
  });

  test("409 while a job runs for that host; another host may start", async () => {
    const w = world({ hang: true });
    const s = service(w);
    assert.equal((await s.start("vps", { commit: C }, json)).status, 202);
    const again = await s.start("vps", { commit: C }, json);
    assert.equal(again.status, 409);
    assert.match((again.body as { error: string }).error, /already running/);
    assert.equal((await s.start("phone", { commit: C }, json)).status, 202, "one job per host, not one in all");
    assert.equal(w.spawned.length, 2);
    s.dispose();
    assert.equal(s.job("vps")!.state, "failed");
    assert.match(s.job("vps")!.error!, /stopped the job/);
  });

  test("a script that fails, or never finishes, or a peer that doesn't come back, fails the job with the reason", async () => {
    const w1 = world({ exit: 3 });
    const s1 = service(w1);
    await s1.start("vps", { commit: C }, json);
    await until(() => s1.job("vps")!.state === "failed");
    assert.match(s1.job("vps")!.error!, /exit 3/);

    const w2 = world({ hang: true });
    const s2 = service(w2);
    await s2.start("vps", { commit: C }, json);
    await until(() => s2.job("vps")!.state === "failed", 15_000); // the 2 s limit, then the kill; a hang guard
    assert.match(s2.job("vps")!.error!, /ran past/);

    const w3 = world();
    const s3 = service(w3);
    await s3.start("vps", { commit: C }, json);
    await until(() => s3.job("vps")!.state === "failed");
    assert.match(s3.job("vps")!.error!, /doesn't answer with this host's version yet/);
  });
});
