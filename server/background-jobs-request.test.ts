// Run: pnpm test -- server/background-jobs-request.test.ts. Asking Sova for a job (§app.background-jobs/request):
// who may ask, the limit, and the unit it starts, with the service manager faked. The real thing (systemd,
// the worker's sandbox) is server/background-jobs-request.integration.test.ts.
import assert from "node:assert/strict";
import { join } from "node:path";
import { describe, it } from "node:test";
import { writeOnlyScope } from "../pi-config/extensions/sandbox/policy.ts";
import { readSessionJobs, writeJob, type JobRecord } from "../pi-config/extensions/subagents/job-store.ts";
import type { HEntry } from "../shared/harness";
import { confinementOf, requestArgv, requestJob, requestOverLimit, SANDBOXED_REFUSAL, type RequestDeps } from "./background-jobs-request";
import { scratchRoot } from "./test-scratch";

const sandboxEntry = (on: boolean): HEntry => ({ id: "e1", parentId: null, timestamp: "", kind: "state", key: "sandbox", data: { version: 1, on, level: "workspace-write" } }) as unknown as HEntry;

describe("background_job: who may ask", () => {
  it("a chat with its sandbox off runs it as its own commands run: unconfined", () => {
    assert.deepEqual(confinementOf({ branch: [] }), { kind: "none" });
  });
  it("a chat whose sandbox is On is refused", () => {
    const c = confinementOf({ branch: [sandboxEntry(true)] });
    assert.equal(c.kind, "sandboxed");
  });
  it("a write-only worker gets its own scope; a worker confined under a sandboxed parent is refused; a malformed scope fails closed", () => {
    const scope = writeOnlyScope("/w/tree");
    assert.deepEqual(confinementOf({ workerFlags: { sandbox: "on", "sandbox-parent": JSON.stringify(scope) }, branch: [] }), { kind: "write-only", parent: scope });
    const { writeOnly: _, ...full } = scope;
    assert.equal(confinementOf({ workerFlags: { sandbox: "on", "sandbox-parent": JSON.stringify(full) }, branch: [] }).kind, "sandboxed");
    assert.equal(confinementOf({ workerFlags: { "sandbox-parent": "{nope" }, branch: [] }).kind, "sandboxed");
    assert.equal(confinementOf({ workerFlags: { sandbox: "on" }, branch: [] }).kind, "sandboxed");
  });
});

describe("background_job: starting one", () => {
  const setup = () => {
    const root = scratchRoot("bgjob-req-");
    const calls: string[][] = [];
    const deps: RequestDeps = {
      dir: join(root, "jobs"),
      unitPrefix: "sova-job-abc-",
      exec: async (file, args) => {
        calls.push([file, ...args]);
        return file === "systemctl" ? { code: 0, stdout: "/user.slice/sova-jobs.slice/x.service\n", stderr: "" } : { code: 0, stdout: "", stderr: "" };
      },
      now: () => 1000,
      bootId: () => "boot-a",
      env: { PATH: "/bin", HOME: "/h" },
      agentDir: join(root, "agent"),
      outDir: join(root, "out"),
    };
    return { root, calls, deps };
  };

  it("refuses a sandboxed chat before anything starts", async () => {
    const { calls, deps } = setup();
    const r = await requestJob({ sessionId: "s1", path: "/p.jsonl", command: "sleep 1", cwd: "/", confinement: { kind: "sandboxed" } }, deps);
    assert.deepEqual(r, { ok: false, error: SANDBOXED_REFUSAL });
    assert.equal(calls.length, 0);
  });

  it("starts a service in the jobs slice with its stop grace, time limit and exit file, and records it", async () => {
    const { calls, deps } = setup();
    const r = await requestJob({ sessionId: "s1", path: "/p.jsonl", command: "make test", cwd: "/w", confinement: { kind: "none" }, worker: "ag_01" }, deps);
    assert.ok(r.ok);
    const run = calls.find((c) => c[0] === "systemd-run")!;
    for (const want of ["--slice=sova-jobs.slice", "--property=KillMode=control-group", "--property=TimeoutStopSec=15", "--property=RuntimeMaxSec=86400", "--working-directory=/w"]) assert.ok(run.includes(want), want);
    assert.deepEqual(run.slice(-3), ["/bin/bash", "-c", "make test"], "the command itself, last, never through a second layer of quoting");
    const [j] = readSessionJobs(deps.dir!, "s1");
    assert.equal(j!.kind, "requested");
    assert.equal(j!.worker, "ag_01");
    assert.equal(j!.cgroup, "/sys/fs/cgroup/user.slice/sova-jobs.slice/x.service");
    assert.ok(j!.exitFile && j!.output && r.text.includes(j!.output), r.text);
  });

  it("past the limit it is refused with the reason and starts nothing", async () => {
    const { calls, deps } = setup();
    deps.env = { ...deps.env, SOVA_JOBS_MAX: "1" };
    const base: JobRecord = { v: 1, id: "j1", sessionId: "s1", path: "/p.jsonl", kind: "kept", command: "x", cwd: "/", unit: "u.scope", driver: "systemd", startedAt: 1, bootId: "boot-a" };
    writeJob(deps.dir!, base);
    const r = await requestJob({ sessionId: "s1", path: "/p.jsonl", command: "sleep 1", cwd: "/", confinement: { kind: "none" } }, deps);
    assert.deepEqual(r, { ok: false, error: requestOverLimit(1) });
    assert.equal(calls.length, 0);
  });

  it("the wrapper's argv keeps the command's own argv intact", () => {
    const a = requestArgv({ unit: "u.service", cwd: "/", envFile: "/e", description: "d", output: "/o", exitFile: "/x", argv: ["bwrap", "--bind", "/a", "/a", "--", "/bin/bash", "-c", "echo 'q'"] });
    assert.deepEqual(a.slice(a.indexOf("sova-job")), ["sova-job", "/o", "/x", "bwrap", "--bind", "/a", "/a", "--", "/bin/bash", "-c", "echo 'q'"]);
  });
});
