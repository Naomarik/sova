// Run: pnpm test:int -- server/background-jobs-request.integration.test.ts. A requested job for real
// (§app.background-jobs/request): a transient service in sova-jobs.slice, started by the server. A write-only
// worker's job runs under that worker's own confinement: its write inside the worktree lands, its write
// outside fails with a permission error, and the job stays listed and running. An unconfined chat's job
// writes where its commands would, and its exit code is written beside its record.
// Needs Linux with the systemd user manager and bwrap; skipped elsewhere.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { after, describe, test } from "node:test";
import { writeOnlyScope } from "../pi-config/extensions/sandbox/policy.ts";
import { readSessionJobs, runningJobs } from "../pi-config/extensions/subagents/job-store.ts";
import { cgroupProcs } from "./background-jobs-capture";
import { realRequestDeps, requestJob } from "./background-jobs-request";
import { scratchRoot } from "./test-scratch";

const can = (file: string, args: string[]) => {
  try {
    execFileSync(file, args, { stdio: "ignore", timeout: 10_000 });
    return true;
  } catch {
    return false;
  }
};
const ready = process.platform === "linux" && can("systemctl", ["--user", "show", "--property=Version"]) && can("bwrap", ["--version"]);

/** Wait until `cond` holds, re-checking every 100 ms, for at most `ms`. */
async function until(cond: () => boolean, ms: number, what: string): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

describe("background_job on the service manager", { skip: !ready && "needs the systemd user manager and bwrap" }, () => {
  const root = scratchRoot("bgjob-int-");
  const wt = join(root, "wt");
  // Outside the OS temp dir: a confined command sees its own private /tmp, where a folder under the host's isn't
  // there at all (no such file), so it couldn't show the permission error. This checkout's gitignored .cache is
  // visible inside, read-only.
  const cache = join(resolve(import.meta.dirname, ".."), ".cache");
  mkdirSync(cache, { recursive: true });
  const outside = mkdtempSync(join(cache, "bgjob-outside-"));
  mkdirSync(wt);
  const prefix = `sova-job-t${process.pid}-`;
  const deps = { ...realRequestDeps({ dir: join(root, "jobs"), unitPrefix: prefix, agentDir: join(root, "agent") }), outDir: join(root, "out") };
  const units: string[] = [];
  after(() => {
    for (const u of units) can("systemctl", ["--user", "stop", u]);
    rmSync(outside, { recursive: true, force: true });
  });

  test("a write-only worker's job: writes only inside its worktree, a write outside fails with a permission error, and it stays listed", async () => {
    const r = await requestJob(
      {
        sessionId: "worker-1",
        path: join(root, "w.jsonl"),
        command: `echo inside > ${wt}/in.txt; echo outside > ${outside}/out.txt; echo "done rc=$?"; sleep 120`,
        cwd: wt,
        confinement: { kind: "write-only", parent: writeOnlyScope(wt) },
        worker: "ag_01",
      },
      deps,
    );
    assert.ok(r.ok, r.ok ? "" : r.error);
    units.push(r.job.unit);
    const log = () => (existsSync(r.job.output!) ? readFileSync(r.job.output!, "utf8") : "");
    await until(() => log().includes("done rc="), 20_000, "the job's output");
    assert.match(log(), /Read-only file system|Permission denied/, log());
    assert.match(log(), /done rc=[1-9]/, log());
    assert.ok(existsSync(join(wt, "in.txt")), "its write inside the worktree landed");
    assert.ok(!existsSync(join(outside, "out.txt")), "nothing was written outside");
    const listed = runningJobs(readSessionJobs(deps.dir!, "worker-1"));
    assert.deepEqual(listed.map((j) => j.id), ["j1"]);
    assert.ok(cgroupProcs(listed[0]!.cgroup!).length > 0, "still running in its own unit");
    assert.ok(listed[0]!.cgroup!.includes("/sova-jobs.slice/"), listed[0]!.cgroup);
  });

  test("an unconfined chat's job writes where its commands would, and its exit code is kept", async () => {
    const r = await requestJob({ sessionId: "chat-1", path: join(root, "c.jsonl"), command: `echo free > ${outside}/free.txt; exit 3`, cwd: root, confinement: { kind: "none" } }, deps);
    assert.ok(r.ok, r.ok ? "" : r.error);
    units.push(r.job.unit);
    await until(() => existsSync(r.job.exitFile!), 20_000, "its exit file");
    assert.equal(readFileSync(r.job.exitFile!, "utf8").trim(), "3");
    assert.equal(readFileSync(join(outside, "free.txt"), "utf8").trim(), "free");
  });
});
