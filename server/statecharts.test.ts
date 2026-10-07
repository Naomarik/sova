// Run: pnpm exec tsx --test server/statecharts.test.ts. Engine behaviour proven against the vendored
// ESM bundle (server/vendor/statecharts.js) through the typed wrapper, on the "engine-probe" statechart. The
// probe is not in the shipped file: these tests register it at runtime (`statecharts`), as a JS copy
// (fixtures/statecharts-engine/probe-statechart.ts) of statecharts/src/sova/statecharts/engine/probe.cljs, which
// the CLJS tests run; probe_shape.json holds both to one shape. The replay runs the shipped statecharts. Pure: no files, no clock but `now`.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { statechartVersions, createStatecharts as createShipped, hoursInherited, nextWindow, StatechartsStepLimitError, type StatechartName, type EngineOptions, type Invocation, type Statecharts } from "./statecharts";
import { readFileSync } from "node:fs";
import { PROBE_STATECHARTS, probeStatechart, probeShape } from "./fixtures/statecharts-engine/probe-statechart";

/** The shipped engine with the probe statechart registered. */
const createStatecharts = (opts: EngineOptions = {}): Statecharts => createShipped({ ...opts, statecharts: PROBE_STATECHARTS });
const PROBE = "engine-probe" as StatechartName;

const T0 = 1_000_000;

function probe(opts: Parameters<typeof createStatecharts>[0] = {}, data: Record<string, number | string> = {}) {
  const e = createStatecharts(opts);
  e.start("p", PROBE, data, { now: T0 });
  return e;
}

function has(e: Statecharts, sid: string, ...ids: string[]): boolean {
  const c = new Set(e.configuration(sid) ?? []);
  return ids.every((id) => c.has(id));
}

describe("statecharts engine (vendored ESM)", () => {
  test("the bundle lists its statecharts, each with a positive integer version", () => {
    const names = statechartVersions().map((c) => c.name);
    assert.deepEqual(names.sort(), ["baton", "build", "conflict", "decision", "item", "org", "person", "placement", "project", "reconciler", "residence", "runtime", "watch"], "the refit's thirteen statecharts, nothing else");
    assert.ok(!names.includes(PROBE), "the shipped module has no test statechart");
    assert.throws(() => createShipped().start("p", PROBE), /Unknown statechart/, "the probe exists only where it is registered");
    assert.throws(() => createShipped({ statecharts: { project: PROBE_STATECHARTS["engine-probe"] } }), /Statechart project is already registered/);
    for (const c of statechartVersions()) {
      assert.ok(Number.isInteger(c.version) && c.version > 0, `${c.name} has version ${String(c.version)}`);
    }
  });

  test("the JS probe has probe.cljs's shape (probe_shape.json, which the CLJS suite checks probe.cljs against)", () => {
    const want = JSON.parse(readFileSync(new URL("../statecharts/src/sova/statecharts/engine/probe_shape.json", import.meta.url), "utf8"));
    assert.deepEqual(probeShape(probeStatechart), want, "probe-statechart.ts differs from probe_shape.json: change probe.cljs, probe-statechart.ts and the JSON together");
  });

  test("start enters every region of a parallel state, in document order", () => {
    const e = probe();
    assert.deepEqual(e.configuration("p"), [
      "probe", "running", "lane", "flow", "a", "gate", "closed", "watch", "idle", "acts", "ready",
    ]);
    assert.equal(e.data("p")?.["now"], T0);
  });

  test("an event moves the lane; the step log carries before/after and data.at", () => {
    const e = probe();
    const r = e.send("p", "next", {}, { now: T0 + 5 });
    assert.ok(has(e, "p", "b", "b1"));
    assert.deepEqual(r.configuration, e.configuration("p"));
    assert.equal(r.steps.length, 1);
    assert.equal(r.steps[0]?.event, "next");
    assert.equal(r.steps[0]?.data?.["at"], T0 + 5);
    assert.ok(r.steps[0]?.before.includes("a"));
    assert.deepEqual(r.errors, []);
  });

  test("a delayed send fires at its time on the injected clock, not before", () => {
    const e = probe({}, { tickMs: 60_000 });
    e.send("p", "next", {}, { now: T0 });
    e.send("p", "next", {}, { now: T0 + 10 });
    assert.ok(has(e, "p", "b2"));
    assert.equal(e.nextDueAt(), T0 + 10 + 60_000);
    assert.deepEqual(e.fireDue(T0 + 10 + 59_999).steps, []);
    const r = e.fireDue(T0 + 10 + 60_000);
    assert.deepEqual(r.steps.map((s) => s.event), ["timer/fired"]);
    assert.equal(r.steps[0]?.data?.["at"], T0 + 10 + 60_000);
    assert.ok(has(e, "p", "c"));
    assert.equal(e.nextDueAt(), null);
  });

  test("leaving a state cancels its pending delayed send", () => {
    const e = probe({}, { tickMs: 60_000 });
    e.send("p", "next", {}, { now: T0 });
    e.send("p", "next", {}, { now: T0 });
    assert.notEqual(e.nextDueAt(), null);
    e.send("p", "hold", {}, { now: T0 + 1 });
    assert.ok(has(e, "p", "held"));
    assert.equal(e.nextDueAt(), null);
    assert.deepEqual(e.fireDue(T0 + 120_000).steps, []);
  });

  test("deep history restores the nested configuration and re-arms its timer", () => {
    const e = probe({}, { tickMs: 1000 });
    e.send("p", "next", {}, { now: T0 });
    e.send("p", "next", {}, { now: T0 });
    e.send("p", "hold", {}, { now: T0 + 1 });
    assert.ok(!has(e, "p", "flow"));
    e.send("p", "resume", {}, { now: T0 + 2 });
    assert.ok(has(e, "p", "flow", "b", "b2"), "resume lands in b2, not the default a");
    assert.equal(e.nextDueAt(), T0 + 2 + 1000);
  });

  test("an eventless transition reads another region through In()", () => {
    const e = probe();
    e.send("p", "poke", {}, { now: T0 });
    assert.ok(has(e, "p", "armed"), "waits while the gate is closed");
    e.send("p", "gate/open", {}, { now: T0 + 1 });
    assert.ok(has(e, "p", "open", "fired"));
    assert.equal(e.data("p")?.["firedEventless"], 1);
    assert.equal(e.data("p")?.["inner"], 1, "an event raised by that transition runs in the same macrostep");
  });

  test("an invocation starts on entry and is cancelled on exit, through the host callbacks", () => {
    const started: Invocation[] = [];
    const stopped: Invocation[] = [];
    const e = probe({ onInvokeStart: (i) => started.push(i), onInvokeStop: (i) => stopped.push(i) }, { tickMs: 1 });
    e.send("p", "next", {}, { now: T0 });
    e.send("p", "next", {}, { now: T0 });
    const r = e.fireDue(T0 + 1);
    assert.ok(has(e, "p", "c"));
    assert.deepEqual(started.map(({ runId: _r, ...i }) => i), [{ op: "start", sessionId: "p", invokeId: "look", type: "sova/look", params: { fired: 1, sid: "p" } }]);
    const runId = started[0]?.runId ?? "";
    assert.match(runId, /^p#look#\d+$/, "each start has a run id");
    assert.deepEqual(r.invocations.map((i) => i.op), ["start"]);
    const r2 = e.send("p", "next", {}, { now: T0 + 2 });
    assert.ok(has(e, "p", "a"));
    assert.deepEqual(stopped, [{ op: "stop", sessionId: "p", invokeId: "look", type: "sova/look", runId }]);
    assert.deepEqual(r2.invocations.map((i) => i.op), ["stop"]);
    // The host reports a look back with its invoke id.
    e.send("p", "next", {}, { now: T0 + 3 });
    e.send("p", "next", {}, { now: T0 + 3 });
    const again = e.fireDue(T0 + 4).invocations[0]?.runId ?? "";
    assert.deepEqual(e.send("p", "look/finished", {}, { now: T0 + 5, invokeId: runId }).steps, [], "a result for an ended run is stale");
    assert.ok(has(e, "p", "c"));
    e.send("p", "look/finished", {}, { now: T0 + 5, invokeId: again });
    assert.ok(has(e, "p", "a"));
    assert.equal(e.data("p")?.["looks"], 1);
  });

  test("trial is side-effect free and names the refusing guard; enabledEvents follows the envelope", () => {
    const saves: string[] = [];
    const e = probe({ onSave: (sid) => saves.push(sid) });
    const before = saves.length;
    const refused = e.trial("p", "act/promote", { by: "overseer", level: "L1" }, { now: T0 });
    assert.equal(refused.taken, false);
    assert.deepEqual(refused.refused, [{
      source: "ready", target: ["acted"], event: ["act/promote"], cond: false,
      "sova/needs": "L2", "sova/refusal": "It needs L2. Do not retry it.",
    }]);
    const ok = e.trial("p", "act/promote", { by: "overseer", level: "L2" }, { now: T0 });
    assert.equal(ok.taken, true);
    assert.ok(ok.configuration.includes("acted"));
    assert.deepEqual(ok.outbox.map(({ key: _k, ...o }) => o), [{ kind: "promote", statechartKey: "promote/0", sessionId: "p" }]);
    assert.equal(saves.length, before, "a trial saves nothing");
    assert.ok(has(e, "p", "ready"), "and the session did not move");
    assert.equal(e.trial("p", "act/promote", { by: "operator" }, { now: T0 }).taken, true);
    assert.ok(!e.enabledEvents("p", { by: "overseer", level: "L1" }).some((x) => x.event === "act/promote"));
    assert.deepEqual(e.enabledEvents("p", { level: "L2" }).map((x) => x.event), [
      "probe/stop", "hold", "next", "gate/open", "spin/facts", "peer/pinged", "poke", "act/promote", "act/ping", "probe/warn", "probe/throw",
    ]);
    const r = e.send("p", "act/promote", { by: "overseer", level: "L2" }, { now: T0 });
    assert.deepEqual(r.outbox.map(({ key: _k, ...o }) => o), [{ kind: "promote", statechartKey: "promote/0", sessionId: "p" }]);
    assert.deepEqual(Object.keys((e.data("p")?.["sova/pending"] ?? {}) as object), [r.outbox[0]?.key], "the effect stays pending under its key");
    assert.deepEqual(e.data("p")?.["outbox"], [], "the outbox is drained from the data model");
  });

  test("a trial arms no timer, starts no invocation and delivers no send", () => {
    const calls: string[] = [];
    const e = createStatecharts({
      onSave: (sid) => calls.push(`save ${sid}`),
      onInvokeStart: () => calls.push("start"),
      onInvokeStop: () => calls.push("stop"),
    });
    e.start("a", PROBE, { peer: "b", tickMs: 1000 }, { now: T0 });
    e.start("b", PROBE, {}, { now: T0 });
    e.send("a", "next", {}, { now: T0 });
    calls.length = 0;
    const armed = e.trial("a", "next", {}, { now: T0 });
    assert.ok(armed.configuration.includes("b2"));
    assert.deepEqual(armed.sends.map(({ to, event, delay, data }) => ({ to, event, delay, data })), [{ to: "a", event: "timer/fired", delay: 1000, data: {} }]);
    assert.equal(e.nextDueAt(), null, "the would-be timer is reported, not queued");
    e.send("a", "next", {}, { now: T0 });
    calls.length = 0;
    const invoked = e.trial("a", "timer/fired", {}, { now: T0 });
    assert.ok(invoked.configuration.includes("c"));
    assert.deepEqual(invoked.invocations.map((i) => i.op), ["start"]);
    const pinged = e.trial("a", "act/ping", {}, { now: T0 });
    assert.deepEqual(pinged.sends.map((s) => s.to), ["b"]);
    e.fireDue(T0);
    assert.equal(e.data("b")?.["pinged"], undefined);
    assert.deepEqual(calls, [], "no host callback and no save");
    assert.ok(has(e, "a", "b2"), "the session never moved");
  });

  test("a cross-session send is delivered in the same call, or reported undelivered", () => {
    const e = createStatecharts();
    e.start("a", PROBE, { peer: "b" }, { now: T0 });
    e.start("b", PROBE, {}, { now: T0 });
    const r = e.send("a", "act/ping", {}, { now: T0 });
    assert.deepEqual(r.steps.map((s) => [s.sessionId, s.event]), [["a", "act/ping"], ["b", "peer/pinged"]]);
    assert.equal(r.sends.length, 1);
    assert.equal(r.sends[0]?.delivered, true);
    assert.deepEqual(r.sends[0]?.data, { from: "a", n: 0 });
    assert.equal(e.data("b")?.["pinged"], 1);
    assert.deepEqual(Object.keys(r.snapshots).sort(), ["a", "b"], "both moved sessions' snapshots, for one write");
    const e3 = createStatecharts();
    e3.load("b", r.snapshots["b"] ?? "");
    assert.equal(e3.data("b")?.["pinged"], 1);
    e.unload("b");
    const r2 = e.send("a", "act/ping", {}, { now: T0 });
    assert.equal(r2.sends[0]?.delivered, false);
    assert.equal(e.nextDueAt(), null);
  });

  test("dump → load mid-flight keeps the pending timer, which fires after the load", () => {
    const e = probe({}, { tickMs: 60_000 });
    e.send("p", "gate/open", {}, { now: T0 });
    e.send("p", "next", {}, { now: T0 });
    e.send("p", "next", {}, { now: T0 + 7 });
    const text = e.dump("p");
    assert.ok(text);
    const e2 = createStatecharts();
    const info = e2.load("p", text);
    assert.equal(info.pending, 1);
    assert.equal(info.statechart, "engine-probe");
    assert.deepEqual(e2.configuration("p"), e.configuration("p"));
    assert.deepEqual(e2.data("p"), e.data("p"));
    assert.equal(e2.nextDueAt(), T0 + 7 + 60_000);
    e2.fireDue(T0 + 7 + 60_000);
    assert.ok(has(e2, "p", "c", "open"));
  });

  test("a load cut off mid-look runs nothing until the resumed event, which the statechart handles", () => {
    const e = probe({}, { tickMs: 1 });
    e.send("p", "next", {}, { now: T0 });
    e.send("p", "next", {}, { now: T0 });
    e.fireDue(T0 + 1);
    assert.ok(has(e, "p", "c"));
    const calls: string[] = [];
    const e2 = createStatecharts({
      onSave: () => calls.push("save"),
      onInvokeStart: () => calls.push("start"),
      onInvokeStop: () => calls.push("stop"),
    });
    const gen = e.generation("p");
    e2.load("p", e.dump("p") ?? "");
    assert.deepEqual(calls, [], "loading runs nothing");
    assert.equal(e2.generation("p"), gen);
    e2.send("p", "sova/resumed", {}, { now: T0 + 100 });
    assert.ok(has(e2, "p", "a"));
    assert.equal(e2.data("p")?.["resumes"], 1);
    assert.deepEqual(calls, ["save", "stop"], "once the call committed: the step is saved, then the dead look is stopped");
    assert.equal(e2.generation("p"), (gen ?? 0) + 1, "the generation continues from the snapshot");
  });

  test("simultaneously past-due timers across restored sessions fire in (time, ordinal) order", () => {
    const e = createStatecharts();
    for (const [sid, tick] of [["x", 300], ["y", 100], ["z", 200]] as const) {
      e.start(sid, PROBE, { tickMs: tick }, { now: T0 });
      e.send(sid, "next", {}, { now: T0 });
      e.send(sid, "next", {}, { now: T0 });
    }
    const e2 = createStatecharts();
    for (const sid of ["z", "x", "y"]) e2.load(sid, e.dump(sid) ?? "");
    assert.deepEqual(e2.fireDue(T0 + 100_000).steps.map((s) => s.sessionId), ["y", "z", "x"]);
  });

  test("onSave hands over each step's snapshot, loadable elsewhere", () => {
    const snaps = new Map<string, string>();
    const e = probe({ onSave: (sid, text) => snaps.set(sid, text) });
    e.send("p", "next", {}, { now: T0 });
    const e2 = createStatecharts();
    e2.load("p", snaps.get("p") ?? "");
    assert.deepEqual(e2.configuration("p"), e.configuration("p"));
  });

  test("errors surface as exceptions for misuse", () => {
    const e = createStatecharts();
    assert.throws(() => e.send("nobody", "next"), /not loaded/);
    assert.throws(() => e.start("p", "nope" as "project"), /Unknown statechart/);
    e.start("p", PROBE, {}, { now: T0 });
    assert.throws(() => e.start("p", PROBE), { name: "StatechartsError", code: "sova/session-exists" });
    assert.throws(() => e.load("q", "{:bad 1}"), /format/);
  });

  test("an eventless cycle throws a typed step-limit error, fast, and the call changes nothing", () => {
    // (fast: the typed error is the evidence that it stopped; the runner's per-test timeout guards a loop)
    // The probe's gate holds mutant M34's shape: merged and running cycles working ⇄ merged forever.
    const e = probe({ maxMicrosteps: 50 }, { tickMs: 60_000 });
    e.send("p", "next", {}, { now: T0 });
    e.send("p", "next", {}, { now: T0 });
    const before = { config: e.configuration("p"), data: e.dump("p"), gen: e.generation("p"), due: e.nextDueAt() };
    let caught: unknown = null;
    try {
      e.send("p", "spin/facts", { merged: true, running: true }, { now: T0 + 5 });
    } catch (err) {
      caught = err;
    }
    assert.ok(caught instanceof StatechartsStepLimitError, `a typed error, got ${String(caught)}`);
    assert.equal(caught.code, "sova/step-limit");
    assert.match(caught.message, /^Step limit: session p took more than 50 microsteps on spin\/facts/);
    assert.deepEqual({ ...caught.details, configuration: caught.details.configuration.includes("gate"), transitions: caught.details.transitions.length > 0 },
      { limit: 50, microsteps: 51, sessionId: "p", event: "spin/facts", configuration: true, transitions: true });
    assert.deepEqual({ config: e.configuration("p"), data: e.dump("p"), gen: e.generation("p"), due: e.nextDueAt() }, before, "rolled back");
    assert.throws(() => e.trial("p", "spin/facts", { merged: true, running: true }, { now: T0 }), StatechartsStepLimitError);
    assert.throws(() => createStatecharts().start("x", PROBE, {}, { now: T0 }) && probe().send("p", "spin/facts", { merged: true, running: true }), /more than 200 microsteps/);
    // Merged and not running settles: the event's own transition and one eventless one.
    const r = e.send("p", "spin/facts", { merged: true, running: false }, { now: T0 + 6 });
    assert.ok(has(e, "p", "spin-merged"));
    assert.equal(r.steps[0]?.microsteps, 2);
    assert.deepEqual(e.fireDue(T0 + 60_000).steps.map((s) => s.event), ["timer/fired"], "the engine goes on");
  });

  test("a step limit in a later session of the same call rolls back the earlier one too", () => {
    const e = createStatecharts({ maxMicrosteps: 50 });
    e.start("a", PROBE, { peer: "b", spinOut: { merged: true, running: true } }, { now: T0 });
    e.start("b", PROBE, {}, { now: T0 });
    const before = ["a", "b"].map((sid) => [e.dump(sid), e.generation(sid)]);
    assert.throws(() => e.send("a", "act/ping", {}, { now: T0 + 1 }), (err: unknown) => err instanceof StatechartsStepLimitError && err.details.sessionId === "b" && err.details.event === "peer/pinged");
    assert.deepEqual(["a", "b"].map((sid) => [e.dump(sid), e.generation(sid)]), before);
  });

  test("the library's own warnings and errors land in the call's errors (the timbre shim's appender)", () => {
    const e = probe();
    const w = e.send("p", "probe/warn", {}, { now: T0 });
    assert.deepEqual(w.errors, [{ level: "warn", message: "Operation not understood {:op :probe-unknown-op}" }]);
    const x = e.send("p", "probe/throw", {}, { now: T0 });
    assert.deepEqual(x.errors, [{ level: "error", message: "Expression failure — the probe's script threw" }]);
    assert.deepEqual(e.send("p", "next", {}, { now: T0 }).errors, []);
  });

  test("a nested final keeps the session and its configuration", () => {
    const e = probe();
    const r = e.send("p", "probe/stop", {}, { now: T0 });
    assert.deepEqual(e.configuration("p"), ["probe", "stopped"]);
    assert.equal(r.steps[0]?.running, true);
  });
});

describe("nextWindow (r7: the statecharts' rules.hours, exported)", () => {
  const weekdays = { days: [1, 2, 3, 4, 5], from: "09:00", to: "17:00" };
  test("before, inside and after a person's hours; the weekend; a zone with DST; no hours", () => {
    const mon = Date.UTC(2026, 8, 28); // Monday 2026-09-28 00:00 UTC
    const h = 3600_000;
    assert.equal(nextWindow({ tz: "UTC", hours: weekdays }, mon + 8 * h), mon + 9 * h, "before: today's window");
    assert.equal(nextWindow({ tz: "UTC", hours: weekdays }, mon + 10 * h), null, "inside: now");
    assert.equal(nextWindow({ tz: "UTC", hours: weekdays }, mon + 5 * 24 * h + 12 * h), mon + 7 * 24 * h + 9 * h, "Saturday: Monday 09:00");
    // New York is UTC-4 in September: 09:00 local is 13:00 UTC
    assert.equal(nextWindow({ tz: "America/New_York", hours: weekdays }, mon + 12 * h), mon + 13 * h);
    assert.equal(nextWindow({}, mon), null, "no zone or hours: always open");
    assert.equal(nextWindow({ tz: "Not/AZone", hours: weekdays }, mon), null);
  });

  test("r13: effective hours: own over the company's, the company's when none, neither = always", () => {
    const mon = Date.UTC(2026, 8, 28);
    const h = 3600_000;
    const company = { tz: "UTC", hours: { days: [1, 2, 3, 4, 5], from: "07:00", to: "15:00" } };
    const own = { tz: "UTC", hours: weekdays };
    assert.equal(nextWindow(own, mon + 8 * h, company), mon + 9 * h, "own hours win");
    assert.equal(nextWindow({}, mon + 5 * h, company), mon + 7 * h, "none of their own: the company's");
    assert.equal(nextWindow({}, mon + 8 * h, company), null, "in the company's hours");
    assert.equal(nextWindow({}, mon + 5 * h, null), null, "neither: always in hours");
    assert.equal(nextWindow({ tz: "UTC" }, mon + 5 * h, company), mon + 7 * h, "a zone without hours isn't own hours");
    assert.equal(hoursInherited({}, company), true);
    assert.equal(hoursInherited(own, company), false);
    assert.equal(hoursInherited({}, null), false);
  });
});
