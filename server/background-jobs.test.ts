import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { cardFile, jobCardText, MAX_JOBS, OVER_LIMIT_LINE, readSessionJobs, writeJob, type JobRecord } from "../pi-config/extensions/subagents/job-store.ts";
import { readWakeRecords } from "../pi-config/extensions/subagents/wake-store.ts";
import { parseWakeNudge, wakeTitle } from "../shared/wake";
import { captureCall, JOB_CALL_ENV, SETTLE_MS, markedCommand, markedPids, outputOf, startScopeArgv, unmarkedContent, type CaptureDeps, type ProcView } from "./background-jobs-capture";
import { endOf, JobKeeper, monitorJobs, stopJob } from "./background-jobs";
import { scratchRoot } from "./test-scratch";

interface FakeProc {
  env: string[];
  cmd?: string;
  fds?: Record<number, string>;
  state?: string;
}

function fakeProc(procs: Record<number, FakeProc>, cgroupOf: (pid: number) => string | null = () => "/chat.service"): ProcView {
  return {
    pids: () => Object.keys(procs).map(Number),
    environ: (pid) => procs[pid]?.env ?? null,
    cmdline: (pid) => (procs[pid] ? (procs[pid].cmd ?? "sleep\x00300\x00") : null),
    fd: (pid, n) => procs[pid]?.fds?.[n] ?? null,
    cgroup: cgroupOf,
    state: (pid) => (procs[pid] ? (procs[pid].state ?? "S") : null),
    bootId: () => "boot-a",
    self: 1,
  };
}

const mark = (m: string) => [`${JOB_CALL_ENV}=${m}`, "PATH=/bin"];

describe("background jobs: which processes a call left (per-call mark)", () => {
  it("the mark is one statement on the command's own first line, the command left as it is", () => {
    const c = markedCommand(`echo "it's"\necho two`, "M1");
    assert.equal(c, `export ${JOB_CALL_ENV}=M1; echo "it's"\necho two`);
  });

  it("finds the call's shell's forked subshell by its command line, never by a mark another call's line holds", () => {
    const proc = fakeProc({
      10: { env: ["PATH=/bin"], cmd: `/bin/bash\x00-c\x00renice\nexport ${JOB_CALL_ENV}=A; ( sleep 300 ) &\x00` },
      11: { env: ["PATH=/bin"], cmd: `/bin/bash\x00-c\x00export ${JOB_CALL_ENV}=AA; sleep 9\x00` },
    });
    assert.deepEqual(markedPids("A", proc), [10]);
  });

  it("takes only the returning call's mark, never another call still running, never the chat itself", () => {
    const proc = fakeProc({
      1: { env: mark("A") }, // the chat's own process, even if it carried one
      10: { env: mark("A") }, // setsid sleep 300 > f & of call A
      11: { env: mark("B") }, // call B's slow foreground run
      12: { env: ["PATH=/bin"] }, // a helper of the chat's own
      13: { env: mark("AA") }, // a mark that only starts with A's
    });
    assert.deepEqual(markedPids("A", proc), [10]);
    assert.deepEqual(markedPids("B", proc), [11]);
  });

  it("sees the mark of a child that execs between reading its command line and its environment", () => {
    // Before the exec: the call's shell's argv (mark included) and its starting environment (none);
    // after: sleep's argv and the exported mark. The exec lands right after the first read of pid 10.
    let execd = false;
    const before: FakeProc = { env: ["PATH=/bin"], cmd: `/bin/bash\x00-c\x00export ${JOB_CALL_ENV}=A; sleep 300 & false\x00` };
    const after: FakeProc = { env: mark("A"), cmd: "sleep\x00300\x00" };
    const proc = fakeProc({});
    proc.pids = () => [10];
    const read = <T,>(f: (p: FakeProc) => T) => {
      const v = f(execd ? after : before);
      execd = true;
      return v;
    };
    proc.cmdline = () => read((p) => p.cmd!);
    proc.environ = () => read((p) => p.env);
    proc.state = () => "R";
    assert.deepEqual(markedPids("A", proc), [10]);
  });

  it("treats an unreadable process as not ours", () => {
    const proc = fakeProc({ 10: { env: mark("A"), cmd: `export ${JOB_CALL_ENV}=A; x` } });
    proc.environ = () => null;
    proc.cmdline = () => null;
    assert.deepEqual(markedPids("A", proc), []);
  });

  it("takes the mark's statement out of what the result shows, and only it", () => {
    const content = [{ type: "text", text: `bash: -c: line 2: \`export ${JOB_CALL_ENV}=M1; if then fi'` }, { type: "image" }];
    assert.deepEqual(unmarkedContent(content, "M1"), [{ type: "text", text: "bash: -c: line 2: `if then fi'" }, { type: "image" }]);
    const other = [{ type: "text", text: `export ${JOB_CALL_ENV}=M2; x` }];
    assert.equal(unmarkedContent(other, "M1"), other);
  });
});

describe("background jobs: where a job's output goes", () => {
  it("names the file stdout or stderr goes to", () => {
    const proc = fakeProc({ 10: { env: [], fds: { 0: "/dev/null", 1: "/tmp/run.log", 2: "pipe:[77]" } } });
    assert.deepEqual(outputOf([10], proc), { output: "/tmp/run.log" });
  });

  it("flags a job whose output is only the command's closed pipe", () => {
    const proc = fakeProc({ 10: { env: [], fds: { 0: "/dev/null", 1: "pipe:[77]", 2: "pipe:[78]" } } });
    assert.deepEqual(outputOf([10], proc), { noOutput: true });
  });

  it("flags the socket pair a JS runtime's spawn gives as pipe stdio, too", () => {
    const proc = fakeProc({ 10: { env: [], fds: { 0: "/dev/null", 1: "socket:[77]", 2: "socket:[78]" } } });
    assert.deepEqual(outputOf([10], proc), { noOutput: true });
  });

  it("doesn't count a pipe the job reads itself (`a | b &`)", () => {
    const proc = fakeProc({ 10: { env: [], fds: { 0: "/dev/null", 1: "pipe:[5]", 2: "/dev/null" } }, 11: { env: [], fds: { 0: "pipe:[5]", 1: "/dev/null", 2: "/dev/null" } } });
    assert.deepEqual(outputOf([10, 11], proc), {});
  });
});

describe("background jobs: keeping a call's leftovers", () => {
  const setup = (jobsAlready = 0) => {
    const root = scratchRoot("bgjobs-");
    const dir = join(root, "jobs");
    const session = join(root, "s.jsonl");
    writeFileSync(session, "");
    for (let i = 1; i <= jobsAlready; i++) writeJob(dir, { v: 1, id: `j${i}`, sessionId: "S", path: session, kind: "kept", command: "x", cwd: root, unit: `u${i}`, driver: "systemd", startedAt: 1, bootId: "boot-a" });
    const calls: string[][] = [];
    const procs: Record<number, FakeProc> = { 10: { env: mark("A"), fds: { 1: "/tmp/f" } }, 11: { env: mark("B") } };
    const d: CaptureDeps = {
      proc: fakeProc(procs, (pid) => (calls.length ? `/sova-jobs.slice/sova-job-h-S-j${jobsAlready + 1}.scope` : `/chat.service${pid ? "" : ""}`)),
      exec: async (file, args) => {
        calls.push([file, ...args]);
        return { code: 0, stdout: "", stderr: "" };
      },
      now: () => 1_000,
      sleep: async () => {},
      env: { SOVA_JOBS_DIR: dir, SOVA_JOBS_UNIT_PREFIX: "sova-job-h-", SOVA_CHAT_PATH: session },
    };
    return { dir, session, calls, d };
  };

  it("moves exactly the call's leftovers into one scope and records the job", async () => {
    const { dir, session, calls, d } = setup();
    const out = await captureCall({ mark: "A", command: "setsid sleep 300 > /tmp/f &", cwd: "/w", sessionId: "S", sessionFile: session }, d);
    assert.ok(out?.job);
    assert.equal(out.job.id, "j1");
    assert.equal(calls.length, 2, "one StartTransientUnit, one attach of the rescan");
    const start = calls[0]!;
    assert.ok(start.includes("StartTransientUnit"));
    const pidsAt = start.indexOf("au");
    assert.deepEqual(start.slice(pidsAt + 1, pidsAt + 3), ["1", "10"], "only pid 10, never call B's 11");
    assert.equal(readSessionJobs(dir, "S").length, 1);
    assert.equal(out.job.output, "/tmp/f");
    assert.match(out.line, /background job j1/);
  });

  it("leaves nothing when the call left nothing", async () => {
    const { session, calls, d } = setup();
    assert.equal(await captureCall({ mark: "C", command: "true", cwd: "/w", sessionId: "S", sessionFile: session }, d), null);
    assert.equal(calls.length, 0);
  });

  it("keeps what a failed `cmd & false` left even when `cmd` was mid-exec, unmarked, at the first look", async () => {
    const { dir, session, calls, d } = setup();
    // Pid 10 is `sleep 300` inside its execve: its new image has no argv or environment yet.
    const procs: Record<number, FakeProc> = { 10: { env: [""], cmd: "", state: "R" } };
    let looks = 0;
    d.proc = fakeProc(procs, (pid) => (calls.length ? "/sova-jobs.slice/sova-job-h-S-j1.scope" : `/chat.service${pid ? "" : ""}`));
    d.sleep = async () => {
      // Still mid-exec at the beat after the first look; through it at the next.
      if (++looks === 2) procs[10] = { env: mark("A"), fds: { 1: "pipe:[7]", 2: "pipe:[7]" } };
    };
    const out = await captureCall({ mark: "A", command: "sleep 300 & false", cwd: "/w", sessionId: "S", sessionFile: session }, d);
    assert.equal(out?.job?.id, "j1");
    const start = calls[0]!;
    assert.deepEqual(start.slice(start.indexOf("au") + 1, start.indexOf("au") + 3), ["1", "10"]);
    assert.equal(readSessionJobs(dir, "S").length, 1);
  });

  it("waits for no zombie, and gives up on an exec that never ends", async () => {
    const { session, calls, d } = setup();
    let waited = 0;
    d.sleep = async (ms) => void (waited += ms);
    d.proc = fakeProc({ 10: { env: [""], cmd: "", state: "Z" } });
    assert.equal(await captureCall({ mark: "A", command: "true", cwd: "/w", sessionId: "S", sessionFile: session }, d), null);
    assert.equal(waited, 0, "a zombie costs no wait");
    d.proc = fakeProc({ 10: { env: [""], cmd: "", state: "R" } });
    assert.equal(await captureCall({ mark: "A", command: "true", cwd: "/w", sessionId: "S", sessionFile: session }, d), null);
    assert.ok(waited > 0 && waited <= SETTLE_MS, `bounded wait (${waited} ms)`);
    assert.equal(calls.length, 0);
  });

  it(`keeps no more than ${MAX_JOBS}: past it nothing moves and the result says so`, async () => {
    const { dir, session, calls, d } = setup(MAX_JOBS);
    const out = await captureCall({ mark: "A", command: "sleep 300 &", cwd: "/w", sessionId: "S", sessionFile: session }, d);
    assert.equal(out?.overLimit, true);
    assert.equal(out?.line, OVER_LIMIT_LINE);
    assert.equal(calls.length, 0, "nothing moved: it stays in the chat's unit");
    assert.equal(readSessionJobs(dir, "S").length, MAX_JOBS);
  });

  it("keeps nothing in a chat not hosted in a unit", async () => {
    const { session, calls, d } = setup();
    d.env = { ...d.env, SOVA_JOBS_UNIT_PREFIX: "" };
    assert.equal(await captureCall({ mark: "A", command: "sleep 300 &", cwd: "/w", sessionId: "S", sessionFile: session }, d), null);
    assert.equal(calls.length, 0);
  });

  it("the scope carries the jobs slice, a 15 s stop and a 24 h limit", () => {
    const a = startScopeArgv("u.scope", [7], "sova-jobs.slice", "d");
    assert.deepEqual(a.slice(a.indexOf("Slice"), a.indexOf("Slice") + 3), ["Slice", "s", "sova-jobs.slice"]);
    assert.equal(a[a.indexOf("TimeoutStopUSec") + 2], "15000000");
    assert.equal(a[a.indexOf("RuntimeMaxUSec") + 2], String(24 * 3600 * 1_000_000));
  });
});

const job = (o: Partial<JobRecord> = {}): JobRecord => ({ v: 1, id: "j1", sessionId: "S", path: "/s.jsonl", kind: "kept", command: "make test > out.log &", cwd: "/w", unit: "u.scope", driver: "systemd", startedAt: 0, bootId: "boot-a", output: "/w/out.log", ...o });

describe("background jobs: how an end is told", () => {
  it("wakes for an end, notes a Stop, says nothing for archive or worker stop; a short kept job wakes too", () => {
    assert.deepEqual(endOf(job(), 60_000, "boot-a", null), { how: "exited", card: "wake" });
    assert.equal(endOf(job({ stop: { at: 1, why: "stop" } }), 60_000, "boot-a", null).card, "note");
    assert.equal(endOf(job({ stop: { at: 1, why: "archive" } }), 60_000, "boot-a", null).card, "none");
    assert.equal(endOf(job({ stop: { at: 1, why: "worker" } }), 60_000, "boot-a", null).card, "none");
    assert.equal(endOf(job(), 5_000, "boot-a", null).card, "wake", "a kept job that ends within seconds still wakes its chat");
    assert.equal(endOf(job({ noOutput: true, output: undefined }), 5_000, "boot-a", null).card, "wake");
    assert.equal(endOf(job({ kind: "requested" }), 1_000, "boot-a", 2).card, "wake", "a requested job always sends one");
    assert.deepEqual(endOf(job(), 24 * 3600_000, "boot-a", null), { how: "time-limit", card: "wake" });
    assert.deepEqual(endOf(job(), 60_000, "boot-b", null), { how: "restart", card: "wake" });
  });

  it("a card names its job, its run time, its output, and parses back as a wake", () => {
    const text = jobCardText([{ ...job(), ended: { at: 300_000, how: "exited", card: "wake" } }], { late: 180_000 });
    assert.match(text, /^\[job j1\] Background job ended\.\nLate by 3m \(Sova was not running\)\.\nj1: `make test > out\.log &`, ran 5m\.\nOutput: \/w\/out\.log\n/);
    const info = parseWakeNudge(text)!;
    assert.equal(info.job, true);
    assert.equal(info.reason, "make test > out.log &");
    assert.equal(info.late, "3m");
    assert.equal(wakeTitle(info), "Background job j1");
    const two = jobCardText(
      [
        { ...job(), ended: { at: 300_000, how: "restart", card: "wake" } },
        { ...job({ id: "j2" }), ended: { at: 300_000, how: "restart", card: "wake" } },
      ],
      {},
    );
    assert.equal(parseWakeNudge(two)?.id, "j1,j2");
  });
});

describe("background jobs: the keeper", () => {
  const keeperOf = (dir: string, wakes: string, alive: Set<string>, now: { t: number }, stateFile: string) =>
    new JobKeeper({ dir, wakeDir: wakes, now: () => now.t, bootId: () => "boot-a", alive: async (j) => alive.has(j.id), exit: () => null, stopUnit: async () => {}, stateFile, log: () => {} });

  it("marks an ended job and publishes its card as a wake item; a running one stays", async () => {
    const root = scratchRoot("bgjobs-k-");
    const dir = join(root, "jobs");
    const wakes = join(root, "wakes");
    writeJob(dir, job({ startedAt: 0 }));
    writeJob(dir, job({ id: "j2", startedAt: 0 }));
    const now = { t: 120_000 };
    const k = keeperOf(dir, wakes, new Set(["j2"]), now, join(root, "k"));
    await k.tick();
    const [j1, j2] = readSessionJobs(dir, "S");
    assert.equal(j1!.ended?.how, "exited");
    assert.equal(j2!.ended, undefined);
    const recs = readWakeRecords(wakes);
    assert.deepEqual(recs.map((r) => [r.source, r.items.map((i) => i.id)]), [["jobs", ["j1"]]]);
  });

  it("a Stop sends no wake item; the chat is noted on its next run", async () => {
    const root = scratchRoot("bgjobs-s-");
    const dir = join(root, "jobs");
    const wakes = join(root, "wakes");
    writeJob(dir, job());
    let stopped = "";
    await stopJob("S", "j1", "stop", { dir, stopUnit: async (j) => void (stopped = j.unit) });
    assert.equal(stopped, "u.scope");
    const k = keeperOf(dir, wakes, new Set(), { t: 120_000 }, join(root, "k"));
    await k.tick();
    assert.equal(readSessionJobs(dir, "S")[0]!.ended?.card, "note");
    assert.deepEqual(readWakeRecords(wakes), []);
    assert.equal(existsSync(cardFile(dir, "S", "j1")), false);
  });

  it("an end while no server ran is marked late from the last sweep", async () => {
    const root = scratchRoot("bgjobs-l-");
    const dir = join(root, "jobs");
    mkdirSync(dir, { recursive: true });
    writeJob(dir, job());
    const state = join(root, "k");
    writeFileSync(state, "100000\n");
    const k = keeperOf(dir, join(root, "w"), new Set(), { t: 400_000 }, state);
    await k.tick();
    const e = readSessionJobs(dir, "S")[0]!.ended!;
    assert.equal(e.at, 100_000);
    assert.equal(e.late, 300_000);
  });
});

describe("background jobs: what the resource monitor charges", () => {
  it("each running job with a cgroup, to its chat; a worker's to its parent as that worker; ended and cgroup-less ones never", () => {
    const dir = join(scratchRoot("bgjobs-m-"), "jobs");
    writeJob(dir, job({ cgroup: "/cg/a1" }));
    writeJob(dir, job({ id: "j2", cgroup: "/cg/a2", ended: { at: 1, how: "exited", card: "wake" } }));
    writeJob(dir, job({ id: "j3" })); // no cgroup
    writeJob(dir, job({ sessionId: "W", path: "/w.jsonl", worker: "ag_02", cgroup: "/cg/w1" }));
    const owners = (sid: string) => (sid === "W" ? { parentPath: "/s.jsonl", workerId: "ag_02" } : undefined);
    const got = monitorJobs(owners, dir).sort((a, b) => a.cgroup.localeCompare(b.cgroup));
    assert.deepEqual(got, [{ cgroup: "/cg/a1", session: "/s.jsonl" }, { cgroup: "/cg/w1", session: "/s.jsonl", worker: "ag_02" }]);
    assert.deepEqual(monitorJobs(owners, join(dir, "none")), []);
  });
});

void mkdtempSync;
