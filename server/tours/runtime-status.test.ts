// record_tour status waits for a change since the chat last saw the job (§app.tours/recording): a job
// already waiting on the user doesn't answer at once on every call, a running job advancing views doesn't
// either, a phase change answers at once, and Stop (the tool's abort) ends the wait at once.
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { test } from "node:test";
import type { TourJob } from "../../shared/tour";
import { tourScriptFixture } from "../../shared/tour-fixtures";
import { stateView } from "../harness/state-view";
import { scratchRoot } from "../test-scratch";
import { tourScriptDigest } from "./checks";
import { TOUR_STATUS_WAIT_MS, TourRuntime, type TourRuntimeOptions } from "./runtime";
import type { TourToolCaller } from "./tools";

function setup(statusWaitMs: number, capture?: Promise<void>) {
  const root = scratchRoot("tour-status-");
  const state = () => stateView([]);
  const caller: TourToolCaller = { sessionId: "chat-a", sessionFile: `${root}/chat.jsonl`, cwd: root, state: state() };
  let release!: () => void;
  const gate = new Promise<void>(r => { release = r; });
  /** Moves the running job on by one view, as the recorder's progress does. */
  let step: (completed: number) => void = () => { throw new Error("not running"); };
  const run: NonNullable<TourRuntimeOptions["run"]> = async input => {
    step = completed => input.onProgress?.({ completed, total: 2 });
    // With a capture gate: the dry run passes at once and the recording holds there.
    if (capture) { if (input.dryRun) await new Promise(r => setTimeout(r, 100)); else await capture; }
    else await gate;
    return { steps: [], assets: new Map(), contactSheets: [], suspicious: [], provenance: { origin: "https://example.test", recordedAt: "2026-01-02T03:04:05.000Z", publicOrigins: [] }, scriptDigest: tourScriptDigest(input.script) };
  };
  const runtime = new TourRuntime({ root, statusWaitMs, run,
    context: { canonical: p => p, snapshot: async () => ({ sessionId: caller.sessionId, sessionFile: caller.sessionFile, cwd: root, agentDir: `${root}/agent`, state: state(), held: { on: false, enforcement: "none" } }) },
    target: async () => ({ origin: "https://example.test", assertCurrent: async () => {} }),
  } as TourRuntimeOptions);
  return { runtime, caller, release, step: (n: number) => step(n), close: () => { release(); runtime.close(); rmSync(root, { recursive: true, force: true }); } };
}
const timed = async <T>(p: Promise<T>): Promise<[T, number]> => { const t0 = Date.now(); const v = await p; return [v, Date.now() - t0]; };
async function phase(runtime: TourRuntime, id: string, want: TourJob["phase"]): Promise<void> {
  for (let i = 0; i < 400 && runtime.queue.get("chat-a", id)?.phase !== want; i++) await new Promise(r => setTimeout(r, 5));
  assert.equal(runtime.queue.get("chat-a", id)?.phase, want);
}

test("a job already waiting on the user doesn't make status answer at once again; entering that wait does", async () => {
  const f = setup(400);
  try {
    // No site approval: the job waits for the user in needs-site-approval.
    const dry = await f.runtime.dryRun(f.caller, tourScriptFixture(), "tour-demo");
    await phase(f.runtime, dry.job.id, "needs-site-approval");
    const [first, quick] = await timed(f.runtime.status(f.caller, dry.job.id));
    assert.equal(first.job.phase, "needs-site-approval");
    assert.ok(quick < 300, `entering the wait is a change since the dry-run answer: answered in ${quick} ms`);
    const [again, waited] = await timed(f.runtime.status(f.caller, dry.job.id));
    assert.equal(again.job.phase, "needs-site-approval");
    assert.ok(waited >= 350, `still waiting is no change: status waited ${waited} ms, not the full wait`);
  } finally { f.close(); }
});

test("status answers as soon as the job changes, not at the end of its wait", async () => {
  const f = setup(20_000);
  try {
    f.runtime.approvals.approve("https://example.test");
    const dry = await f.runtime.dryRun(f.caller, tourScriptFixture(), "tour-demo");
    await phase(f.runtime, dry.job.id, "dry-run");
    await f.runtime.status(f.caller, dry.job.id); // sees dry-run
    setTimeout(() => f.release(), 100);
    const [done, waited] = await timed(f.runtime.status(f.caller, dry.job.id));
    assert.equal(done.job.phase, "checking", "the answer is the changed job");
    assert.ok(waited >= 60 && waited < 5000, `answered on the change after ${waited} ms`);
    // Resting where only the agent can move it: answers at once.
    const [rest, quick] = await timed(f.runtime.status(f.caller, dry.job.id));
    assert.equal(rest.job.phase, "checking");
    assert.ok(quick < 1000, `a resting job answers at once (${quick} ms)`);
  } finally { f.close(); }
});

test("Stop ends a waiting status at once", async () => {
  const f = setup(60_000);
  try {
    const dry = await f.runtime.dryRun(f.caller, tourScriptFixture(), "tour-demo");
    await phase(f.runtime, dry.job.id, "needs-site-approval");
    await f.runtime.status(f.caller, dry.job.id);
    const stop = new AbortController();
    setTimeout(() => stop.abort(), 50);
    const [answer, waited] = await timed(f.runtime.status(f.caller, dry.job.id, stop.signal));
    assert.equal(answer.job.phase, "needs-site-approval");
    assert.ok(waited < 1000, `Stop returned after ${waited} ms`);
  } finally { f.close(); }
});

test("a running job advancing through its views doesn't end the wait", async () => {
  const f = setup(500);
  try {
    f.runtime.approvals.approve("https://example.test");
    const dry = await f.runtime.dryRun(f.caller, tourScriptFixture(), "tour-demo");
    await phase(f.runtime, dry.job.id, "dry-run");
    await f.runtime.status(f.caller, dry.job.id); // sees dry-run
    setTimeout(() => f.step(1), 50);
    setTimeout(() => f.step(2), 150);
    const [answer, waited] = await timed(f.runtime.status(f.caller, dry.job.id));
    assert.equal(answer.job.phase, "dry-run");
    assert.equal(answer.job.completed, 2, "the answer shows the progress made meanwhile");
    assert.ok(waited >= 450, `progress alone is no change: status waited ${waited} ms, not the full wait`);
  } finally { f.close(); }
});

test("a job moving between its own working phases (queued, dry run, recording) doesn't end the wait; Stop still does at once", async () => {
  let open!: () => void;
  const capture = new Promise<void>(r => { open = r; });
  const f = setup(700, capture);
  try {
    f.runtime.approvals.approve("https://example.test");
    const dry = await f.runtime.dryRun(f.caller, tourScriptFixture(), "tour-demo");
    await phase(f.runtime, dry.job.id, "checking");
    const rec = await f.runtime.record(f.caller, dry.job.id); // the chat sees it queued
    assert.equal(rec.job.phase, "queued");
    const [answer, waited] = await timed(f.runtime.status(f.caller, rec.job.id));
    assert.equal(answer.job.phase, "recording", "it went queued \u2192 dry-run \u2192 recording meanwhile");
    assert.ok(waited >= 650, `internal phase steps are no change: status waited ${waited} ms, not the full wait`);
    const stop = new AbortController();
    setTimeout(() => stop.abort(), 50);
    const [stopped, quick] = await timed(f.runtime.status(f.caller, rec.job.id, stop.signal));
    assert.equal(stopped.job.phase, "recording");
    assert.ok(quick < 500, `Stop returned after ${quick} ms`);
    // Coming to rest where only the agent moves it on wakes at once.
    setTimeout(() => open(), 50);
    const [rest, restWait] = await timed(f.runtime.status(f.caller, rec.job.id));
    assert.equal(rest.job.phase, "failed", "the stand-in recording has no steps, so it ends failed: a resting phase");
    assert.ok(restWait < 650, `resting answered after ${restWait} ms`);
  } finally { open(); f.close(); }
});

test("status waits up to five minutes", () => {
  assert.equal(TOUR_STATUS_WAIT_MS, 300_000);
});
