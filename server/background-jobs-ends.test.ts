// The job keeper's ends that a running test can't wait for (§app.background-jobs/machine-restart,
// /limits, /where): a machine restart (the boot id injected), the 24-hour limit (the clock injected),
// and a machine without the systemd user manager. In-process: no unit is started.
import assert from "node:assert/strict";
import { join } from "node:path";
import { describe, it } from "node:test";
import { JOB_TIME_LIMIT_MS, jobCardText, readSessionJobs, writeJob, type JobRecord } from "../pi-config/extensions/subagents/job-store.ts";
import { readWakeRecords } from "../pi-config/extensions/subagents/wake-store.ts";
import { backgroundJobTool, NO_JOBS_HERE, requestJob, type RequestDeps } from "./background-jobs-request";
import { jobsEnv, JobKeeper } from "./background-jobs";
import { scratchRoot } from "./test-scratch";

const job = (o: Partial<JobRecord> = {}): JobRecord => ({ v: 1, id: "j1", sessionId: "S", path: "/s.jsonl", kind: "kept", command: "make lab > lab.log &", cwd: "/w", unit: "u.scope", driver: "systemd", startedAt: 1_000, bootId: "boot-a", output: "/w/lab.log", ...o });

/** A keeper over a scratch store, every outside effect recorded. */
function rig(o: { boot: string; now: number; alive?: (j: JobRecord) => boolean }) {
  const root = scratchRoot("bgjobs-ends-");
  const dir = join(root, "jobs");
  const wakes = join(root, "wakes");
  const asked: string[] = [];
  const stopped: string[] = [];
  const clock = { t: o.now };
  const keeper = new JobKeeper({
    dir,
    wakeDir: wakes,
    now: () => clock.t,
    bootId: () => o.boot,
    alive: async (j) => {
      asked.push(j.id);
      return o.alive ? o.alive(j) : true;
    },
    exit: () => null,
    stopUnit: async (j) => void stopped.push(j.id),
    stateFile: join(root, "keeper"),
    log: () => {},
  });
  const items = () => readWakeRecords(wakes).flatMap((r) => r.items.map((i) => `${r.source}:${i.id}`));
  return { dir, keeper, asked, stopped, clock, items };
}

describe("background jobs: a machine restart or logout ends them", () => {
  it("jobs from an earlier boot are marked ended by the restart, all of them owed one wake, and nothing is started or stopped", async () => {
    const r = rig({ boot: "boot-b", now: 10 * 60_000 });
    writeJob(r.dir, job({ id: "j1" }));
    writeJob(r.dir, job({ id: "j2", kind: "requested", exitFile: "/nowhere/j2.exit" }));
    writeJob(r.dir, job({ id: "j3", bootId: "boot-b" })); // this boot's: still running
    await r.keeper.tick();
    const [j1, j2, j3] = readSessionJobs(r.dir, "S");
    assert.equal(j1!.ended?.how, "restart");
    assert.equal(j2!.ended?.how, "restart", "a requested job too: its exit code is gone with the boot");
    assert.equal(j1!.ended?.card, "wake");
    assert.equal(j3!.ended, undefined);
    assert.deepEqual(r.asked, ["j3"], "an earlier boot's job is never asked after: a pid or unit name of the new boot isn't it");
    assert.deepEqual(r.stopped, [], "nothing stopped");
    assert.deepEqual(r.items().sort(), ["jobs:j1", "jobs:j2"], "the chat is brought back for them");
    // Its card names them all, and says nothing is started again.
    const text = jobCardText([j1!, j2!], {});
    assert.match(text, /^\[job j1,j2\] 2 background jobs ended\./);
    assert.equal(text.match(/Sova does not start it again\./g)?.length, 2);
    // A second sweep changes nothing: told once.
    r.clock.t += 60_000;
    await r.keeper.tick();
    assert.deepEqual(readSessionJobs(r.dir, "S").map((j) => j.ended?.at), [j1!.ended!.at, j2!.ended!.at, undefined]);
    assert.deepEqual(r.stopped, []);
  });

  it("a job whose record has no boot id is judged by its unit, never as a restart", async () => {
    const r = rig({ boot: "boot-b", now: 10 * 60_000, alive: () => false });
    writeJob(r.dir, job({ bootId: "" }));
    await r.keeper.tick();
    assert.equal(readSessionJobs(r.dir, "S")[0]!.ended?.how, "exited");
  });
});

describe("background jobs: a quick end", () => {
  it("a kept job that exits 3 s after it was kept still wakes its chat", async () => {
    const now = 10 * 60_000;
    const r = rig({ boot: "boot-a", now, alive: () => false });
    writeJob(r.dir, job({ output: "/tmp/o", startedAt: now - 3000 }));
    await r.keeper.tick();
    const ended = readSessionJobs(r.dir, "S")[0]!.ended!;
    assert.equal(ended.how, "exited");
    assert.equal(ended.card, "wake");
    assert.deepEqual(r.items(), ["jobs:j1"], "a jobs wake item is published");
  });
});

describe("background jobs: the 24-hour limit", () => {
  it("a job still running 24 hours after it started is stopped, and its end card says it hit the time limit and wakes the chat", async () => {
    let running = true;
    const r = rig({ boot: "boot-a", now: 1_000 + JOB_TIME_LIMIT_MS - 120_000, alive: () => running });
    writeJob(r.dir, job());
    await r.keeper.tick();
    assert.deepEqual(r.stopped, [], "not before its 24 hours");
    r.clock.t = 1_000 + JOB_TIME_LIMIT_MS;
    await r.keeper.tick();
    assert.deepEqual(r.stopped, ["j1"], "stopped at 24 hours");
    assert.equal(readSessionJobs(r.dir, "S")[0]!.ended, undefined, "recorded once it has ended");
    running = false;
    r.clock.t += 15_000;
    await r.keeper.tick();
    const j = readSessionJobs(r.dir, "S")[0]!;
    assert.equal(j.ended?.how, "time-limit");
    assert.equal(j.ended?.card, "wake", "the time limit is not Stop: it wakes the chat");
    assert.equal(j.stop, undefined, "the keeper's stop leaves no Stop record, which would make it a quiet note");
    assert.deepEqual(r.items(), ["jobs:j1"]);
    assert.match(jobCardText([j], {}), /It hit the time limit of 24 hours and was stopped\./);
  });

  it("a unit's own limit ending it first (systemd's RuntimeMax) is the time limit too", async () => {
    const r = rig({ boot: "boot-a", now: 1_000 + JOB_TIME_LIMIT_MS + 5_000, alive: () => false });
    writeJob(r.dir, job());
    await r.keeper.tick();
    assert.equal(readSessionJobs(r.dir, "S")[0]!.ended?.how, "time-limit");
  });
});

describe("background jobs: off systemd", () => {
  it("chats get no job variables under another driver or none, so nothing is kept", () => {
    assert.deepEqual(jobsEnv("detached"), {});
    assert.deepEqual(jobsEnv(undefined), {});
    assert.ok(Object.keys(jobsEnv("systemd")).length > 0, "under systemd they do");
  });

  it("background_job starts nothing and says why", async () => {
    const calls: string[] = [];
    const deps = (o: { dir: string | null; unitPrefix: string | null }): RequestDeps => ({
      ...o,
      exec: async (file) => {
        calls.push(file);
        return { code: 0, stdout: "", stderr: "" };
      },
      now: () => 1,
      bootId: () => "b",
      env: {},
      agentDir: "/nowhere",
    });
    const tool = backgroundJobTool({ path: "/s.jsonl" }, async () => null, deps);
    await assert.rejects(
      tool.execute("c", { command: "sleep 300" }, undefined, undefined, { sessionId: "S", cwd: "/w", branch: () => [] } as never),
      (e: Error) => e.message === NO_JOBS_HERE,
    );
    assert.equal(NO_JOBS_HERE, "Background jobs need Linux with the systemd user manager, and Sova isn't running its chats under one here, so nothing was started.");
    assert.deepEqual(await requestJob({ sessionId: "S", path: "/s.jsonl", command: "sleep 1", cwd: "/w", confinement: { kind: "none" } }, deps({ dir: null, unitPrefix: null })), { ok: false, error: NO_JOBS_HERE });
    assert.deepEqual(calls, [], "nothing ran");
  });
});
