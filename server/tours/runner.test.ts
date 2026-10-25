import assert from "node:assert/strict";
import { test } from "node:test";
import { tourScriptFixture } from "../../shared/tour-fixtures";
import { freshCheck, runTourAttempt } from "./runner";
import type { RunnerProxyOptions } from "./runner-proxy";
import type { TourProxyOptions, TourRecordingContext } from "./sandbox";
import { TourCaptureFailure } from "./targets";
import { TourTargetRefused } from "../project-services/tour-target";
import { TourJobFailure } from "./queue";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";

// The production wiring from a recording attempt to its confined launch, stopped at the launch: what
// proxy options a sandbox-on attempt hands its own proxy, and that a sandbox-off attempt starts its own
// proxy (stood in here, nothing listens) and launches only behind it.
const PUBLIC = "1.1.1.1"; // never contacted: nothing is launched here
const context = (on: boolean): TourRecordingContext => ({ sessionId: "runner-seam", sessionFile: "/server/chat.jsonl", cwd: "/server/checkout", agentDir: "/server/agent", sandbox: { on } });
const OWN = "http://127.0.0.1:1";
async function captured(on: boolean, source: "project" | "site", assertCurrent: () => Promise<void> = async () => {}, consent: (origin: string) => Promise<void> = async () => {}) {
  const script = tourScriptFixture();
  script.source = source === "project"
    ? { kind: "project", projectId: "project", instanceId: "copy-a", checkout: "/server/checkout", serviceId: "web", endpoint: "http" }
    : { kind: "site", origin: "https://public.example" };
  const origin = source === "project" ? "http://127.0.0.1:4321" : "https://public.example";
  const seen: { proxy?: TourProxyOptions; own?: string; started?: RunnerProxyOptions; closed: number; called: boolean } = { called: false, closed: 0 };
  await assert.rejects(runTourAttempt({
    context: context(on), script, tourId: "seam-tour", editionId: "seam-edition", dryRun: true, beforeContact: consent,
    target: async () => ({ origin, generation: 1, assertCurrent }),
    startProxy: async options => { seen.started = options; return { url: OWN, closed: new Promise<void>(() => {}), close: async () => { seen.closed++; } }; },
    spawn: async (_context, _argv, proxy, own) => { seen.called = true; seen.proxy = proxy; seen.own = own; throw new Error("launch captured"); },
  }), /launch captured/);
  assert.ok(seen.called, "the attempt reached its confined launch");
  last = seen;
  return seen.proxy;
}
let last: { own?: string; started?: RunnerProxyOptions; closed: number } = { closed: 0 };

test("sandbox on: the attempt proxy refuses every non-public DNS answer and admits nothing else", async () => {
  for (const source of ["project", "site"] as const) {
    const proxy = await captured(true, source);
    assert.ok(proxy?.forbid, source);
    for (const address of ["10.0.0.5", "100.64.1.1", "192.168.1.1", "172.16.0.1", "127.0.0.1", "169.254.1.1", "fd00::1", "::ffff:10.0.0.5"]) assert.equal(proxy.forbid(address), true, `${source} ${address}`);
    assert.equal(proxy.forbid(PUBLIC), false, `${source}: a public answer passes`);
  }
});

test("sandbox on: only a project tour's own copy gets the one loopback admission, re-checked per contact", async () => {
  let current = true, checks = 0;
  const proxy = await captured(true, "project", async () => { checks++; if (!current) throw new Error("This running copy changed during recording."); });
  assert.deepEqual({ host: proxy?.local?.host, port: proxy?.local?.port }, { host: "127.0.0.1", port: 4321 });
  const before = checks;
  assert.equal(await proxy!.local!.admit(), true);
  assert.equal(checks, before + 1, "admission re-runs the copy's identity check");
  current = false;
  await assert.rejects(proxy!.local!.admit());
  assert.equal((await captured(true, "site"))?.local, undefined, "a site tour gets no loopback exception");
});

test("sandbox on: the sandbox proxy also admits only this tour's declared origins, through the live check", async () => {
  const asked: string[] = [];
  const proxy = await captured(true, "site", async () => {}, async origin => { asked.push(origin); });
  assert.equal(await proxy!.admit!("public.example", 443), true, "the declared site");
  const n = asked.length;
  await assert.rejects(Promise.resolve(proxy!.admit!("elsewhere.example", 443)), /Not an origin of this tour/, "an undeclared origin the chat may allowlist");
  assert.equal(asked.length, n, "refused before any check or lookup");
  const copy = await captured(true, "project");
  assert.equal(await copy!.admit!("127.0.0.1", 4321), true, "the project's own copy (its http origin)");
});

test("sandbox on: the chat's sandbox proxy, and no proxy of the attempt's own", async () => {
  await captured(true, "site");
  assert.equal(last.started, undefined); assert.equal(last.own, undefined);
});

test("sandbox off: the launch runs behind the attempt's own proxy, which admits only this tour's origins through the live check", async () => {
  for (const source of ["project", "site"] as const) {
    let checks = 0;
    const asked: string[] = [];
    const proxy = await captured(false, source, async () => { checks++; }, async origin => { asked.push(origin); });
    assert.equal(proxy, undefined, `${source}: no sandbox proxy options`);
    assert.equal(last.own, OWN, `${source}: the child is launched with the attempt's own proxy`);
    assert.equal(last.closed, 1, `${source}: the proxy closes when the launch fails`);
    const own = source === "project" ? "http://127.0.0.1:4321" : "https://public.example";
    const before = checks, askedBefore = asked.length;
    assert.equal(await last.started!.admit([own]), own);
    assert.ok(checks > before, "admission re-runs the source identity check");
    assert.equal(asked.at(-1), own, "and the live consent check");
    // An origin consent would pass but this tour neither declares nor requested: refused unchecked.
    const n = asked.length;
    await assert.rejects(last.started!.admit(["https://elsewhere.example"]), /Not an origin of this tour/);
    assert.equal(asked.length, n, "an undeclared origin is refused before any check");
    assert.ok(askedBefore >= 0);
  }
  // A WebSocket CONNECT to the project copy carries https then http: only the declared http origin is checked and admitted.
  await captured(false, "project");
  assert.equal(await last.started!.admit(["https://127.0.0.1:4321", "http://127.0.0.1:4321"]), "http://127.0.0.1:4321");
});

test("sandbox off: a declared site is admitted; a plain check failure only refuses the connection", async () => {
  const script = tourScriptFixture();
  script.source = { kind: "site", origin: "https://public.example" };
  script.sites = ["https://assets.example"];
  let started: RunnerProxyOptions | undefined;
  let failing = false;
  await assert.rejects(runTourAttempt({
    context: context(false), script, tourId: "seam-tour", editionId: "seam-edition", dryRun: true,
    beforeContact: async () => { if (failing) throw new Error("A transient lookup failed."); },
    target: async () => ({ origin: "https://public.example", generation: 1, assertCurrent: async () => {} }),
    startProxy: async options => { started = options; return { url: OWN, closed: new Promise<void>(() => {}), close: async () => {} }; },
    spawn: async () => { throw new Error("launch captured"); },
  }), /launch captured/);
  assert.equal(await started!.admit(["https://assets.example"]), "https://assets.example", "a declared site");
  failing = true;
  await assert.rejects(started!.admit(["https://assets.example"]), /transient/, "refused, as a plain error");
});

test("sandbox off: a proxy that can't start fails the attempt before any launch", async () => {
  const script = tourScriptFixture();
  script.source = { kind: "site", origin: "https://public.example" };
  let launched = 0;
  await assert.rejects(runTourAttempt({
    context: context(false), script, tourId: "seam-tour", editionId: "seam-edition", dryRun: true, beforeContact: async () => {},
    target: async () => ({ origin: "https://public.example", generation: 1, assertCurrent: async () => {} }),
    startProxy: async () => { throw new Error("EADDRINUSE"); },
    spawn: async () => { launched++; throw new Error("launch captured"); },
  }), (error: unknown) => error instanceof TourCaptureFailure && /network guard/.test(error.failure.message));
  assert.equal(launched, 0, "nothing launched without its proxy");
});

test("sandbox off: a declared origin's check failing with a job failure (scope changed, too many sites) stops the running attempt", async () => {
  const script = tourScriptFixture();
  script.source = { kind: "site", origin: "https://public.example" };
  let started: RunnerProxyOptions | undefined;
  let fail = false;
  // A stand-in child that stays alive until the attempt is stopped (nothing launches).
  const proc = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), pid: undefined, exitCode: null, signalCode: null, kill: () => true }) as unknown as ChildProcess;
  const refusal = new TourJobFailure({ message: "The chat's sandbox scope changed during recording.", guidance: "Retry." });
  const running = runTourAttempt({
    context: context(false), script, tourId: "seam-tour", editionId: "seam-edition", dryRun: true,
    beforeContact: async () => { if (fail) throw refusal; },
    target: async () => ({ origin: "https://public.example", generation: 1, assertCurrent: async () => {} }),
    startProxy: async options => { started = options; return { url: OWN, closed: new Promise<void>(() => {}), close: async () => {} }; },
    spawn: async () => ({ process: proc, dispose: async () => {} }),
  }).then(() => "finished", (e: unknown) => e);
  for (let i = 0; i < 100 && !started; i++) await new Promise(ok => setTimeout(ok, 5));
  fail = true;
  await assert.rejects(started!.admit(["https://public.example"]), (e: unknown) => e === refusal);
  // The attempt was told to stop; the stand-in exits as a stopped child would.
  setTimeout(() => proc.emit("close", null), 20);
  assert.equal(await running, refusal, "the attempt ends with the policy failure, not as a finished recording");
});

test("freshCheck: every caller is covered by a check that began at or after its call; a burst shares two", async () => {
  const starts: number[] = [];
  let release: (() => void) | undefined;
  let n = 0;
  const check = freshCheck(async () => { starts.push(++n); await new Promise<void>(r => { release = r; }); });
  const calledAt: number[] = [];
  const results: Promise<void>[] = [];
  const call = () => { calledAt.push(n); results.push(check()); };
  call(); // starts check 1
  await Promise.resolve();
  call(); call(); call(); // arrive while 1 runs: all wait for check 2
  assert.deepEqual(starts, [1]);
  release!(); await new Promise(r => setTimeout(r, 0));
  assert.deepEqual(starts, [1, 2], "one more check for the whole burst");
  call(); // arrives while 2 runs: waits for check 3
  release!(); await new Promise(r => setTimeout(r, 0));
  assert.deepEqual(starts, [1, 2, 3]);
  release!();
  await Promise.all(results);
  // A failing check reaches exactly the callers it covers.
  const failing = freshCheck(async () => { throw new Error("This running copy changed."); });
  await assert.rejects(failing(), /changed/);
});

test("freshCheck: a caller never reuses a check that began before its call, so a change in between is seen", async () => {
  let ok = true;
  const releases: (() => void)[] = [];
  let starts = 0;
  const check = freshCheck(async () => {
    starts++;
    const passing = ok; // what this check observed when it began
    await new Promise<void>(r => { releases.push(r); });
    if (!passing) throw new TourTargetRefused("This running copy changed.");
  });
  const a = check(); // check 1 begins while the copy is current
  await Promise.resolve();
  ok = false; // the copy changes while check 1 runs
  const b = check(); // B arrives during check 1: it must not take check 1's pass
  const c = check(); // so does C, before check 2 begins: it shares check 2
  assert.equal(starts, 1);
  releases.shift()!();
  await assert.doesNotReject(a, "A gets check 1's pass");
  await new Promise(r => setTimeout(r, 0));
  assert.equal(starts, 2, "B and C share one fresh check");
  releases.shift()!();
  await assert.rejects(b, TourTargetRefused, "B gets check 2's refusal");
  await assert.rejects(c, TourTargetRefused, "the refusal reaches every caller check 2 covers");
  // No rejection stays cached: the copy is current again and the next caller runs check 3 and passes.
  ok = true;
  const d = check();
  await Promise.resolve();
  assert.equal(starts, 3, "a fresh check after a failure");
  releases.shift()!();
  await assert.doesNotReject(d);
});

test("freshCheck: a failed check is not reused by the next caller", async () => {
  let pass = false;
  let starts = 0;
  const failing = freshCheck(async () => { starts++; if (!pass) throw new Error("This running copy changed."); });
  await assert.rejects(failing(), /changed/);
  assert.equal(starts, 1);
  pass = true;
  await assert.doesNotReject(failing());
  assert.equal(starts, 2, "the start count goes up: the rejection was not cached");
});
