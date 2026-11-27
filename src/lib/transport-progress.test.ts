// A transport's progress in the dialog and the chat's head (§app.transport/dialog): the current step comes from the
// record's finished steps, never its state alone ("switching" is said both while a Move stops what runs and once the
// switch is decided), and the Sending speed is smoothed over several readings, so it never reads zero or endless
// mid-transfer.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { TransportView } from "./transport-api";
import { currentStep, headLine, ofSize, sendingOf, sendRate, timeLeftText, transportSteps } from "./transport-progress";

const MB = 1024 * 1024;
const at = "2026-11-26T10:00:00.000Z";
const view = (p: Partial<TransportView>): TransportView => ({ tid: "tr_abcdef", side: "source", mode: "move", chatId: "c1", peer: "p1", peerLabel: "Laptop", state: "preparing", steps: {}, ...p });
const marks = (...ks: string[]) => Object.fromEntries(ks.map((k) => [k, at]));
const states = (t: TransportView) => transportSteps(t).map((s) => `${s.id}:${s.state}`).join(" ");

test("a Move switching with only offered and prepared done is stopping its jobs and running copies", () => {
  const t = view({ state: "switching", steps: marks("offered", "prepared") });
  assert.equal(currentStep(t)?.label, "Stopping jobs and running copies");
  assert.equal(states(t), "prepare:done stop:current pack:todo send:todo check:todo open:todo");
});

test("a Move switching once decided is opening there, not stopping", () => {
  const t = view({ state: "switching", steps: marks("offered", "prepared", "stopped", "packed", "pulled", "staged", "verified", "decided") });
  assert.equal(currentStep(t)?.label, "Opening on Laptop");
});

test("each finished step moves the current one along, a Move's and a Copy's", () => {
  const order: [string[], string][] = [
    [[], "prepare"],
    [["offered"], "prepare"],
    [["offered", "prepared"], "stop"],
    [["offered", "prepared", "stopped"], "pack"],
    [["offered", "prepared", "stopped", "packed"], "send"],
    [["offered", "prepared", "stopped", "packed", "pulled"], "check"],
    [["offered", "prepared", "stopped", "packed", "pulled", "verified"], "open"],
  ];
  for (const [ks, id] of order) assert.equal(currentStep(view({ state: "sending", steps: marks(...ks) }))?.id, id, ks.join(","));
  const copy = view({ mode: "copy", state: "packing", steps: marks("offered", "prepared") });
  assert.equal(states(copy), "prepare:done pack:current send:todo check:todo open:todo");
  assert.equal(currentStep(view({ state: "done", steps: marks("offered", "opened", "confirmed") })), null);
});

test("Waiting for helpers shows only for a Move whose helpers were busy, and stays once they rest", () => {
  assert.equal(transportSteps(view({ state: "waiting-helpers", steps: marks("prepared"), ext: { waiting: 0 } })).some((s) => s.id === "helpers"), false);
  const waiting = view({ state: "waiting-helpers", steps: marks("prepared"), ext: { waiting: 2, waitedHelpers: true } });
  assert.equal(currentStep(waiting)?.label, "Waiting for helpers");
  const after = view({ state: "switching", steps: marks("prepared"), ext: { waiting: 0, waitedHelpers: true } });
  assert.equal(states(after), "prepare:done helpers:done stop:current pack:todo send:todo check:todo open:todo");
  assert.equal(transportSteps(view({ mode: "copy", ext: { waitedHelpers: true } })).some((s) => s.id === "helpers"), false);
});

test("needing you marks the step it stopped at as failed, and the head says so", () => {
  const t = view({ state: "needs-you", steps: marks("offered", "prepared", "stopped", "packed"), needsYou: { reason: "Transport to Laptop stopped: x. The chat carries on here." } });
  assert.equal(states(t), "prepare:done stop:done pack:done send:failed check:todo open:todo");
  assert.equal(headLine(t), "Moving to Laptop · Needs you");
});

test("the head names the step, the amount while it sends, and goes once the transport ended", () => {
  assert.equal(headLine(view({ mode: "copy", state: "packing", steps: marks("prepared") })), "Copying to Laptop · Packing");
  assert.equal(headLine(view({ state: "sending", steps: marks("prepared", "stopped", "packed"), pkg: { size: 34 * MB }, received: 12 * MB })), "Moving to Laptop · Sending 12 of 34 MB");
  assert.equal(headLine(view({ state: "done" })), null);
  assert.equal(headLine(view({ state: "cancelled" })), null);
});

test("sizes read in the whole's unit", () => {
  assert.equal(ofSize(12 * MB, 34 * MB), "12 of 34 MB");
  assert.equal(ofSize(0, 34 * MB), "0 of 34 MB");
  assert.equal(ofSize(1.5 * MB, 2.5 * MB), "1.5 of 2.5 MB");
  assert.equal(ofSize(300 * MB, 2048 * MB), "0.3 of 2 GB");
  assert.equal(ofSize(300 * 1024, 2048 * MB), "0 of 2 GB");
});

test("the speed needs several readings, never reads zero, and holds steady across a burst", () => {
  assert.equal(sendRate(undefined), null);
  assert.equal(sendRate([{ at: 0, n: 0 }]), null);
  assert.equal(sendRate([{ at: 0, n: 0 }, { at: 1500, n: MB }]), null, "one interval is no speed yet");
  // The destination reports in bursts: some readings repeat the last count.
  const bursty = [0, 0, 3, 3, 6, 6, 9, 9].map((m, i) => ({ at: i * 1500, n: m * MB }));
  const seen: number[] = [];
  for (let k = 3; k <= bursty.length; k++) {
    const r = sendRate(bursty.slice(0, k));
    if (r === null) continue;
    assert.ok(r > 0 && Number.isFinite(r), `reading ${k}: ${r}`);
    seen.push(r);
  }
  assert.ok(seen.length >= 4);
  // No jump: every speed within 2x of the true 1 MB/s.
  for (const r of seen) assert.ok(r > MB / 2 && r < 2 * MB, String(r));
  // Nothing moved across the whole window: no speed, never zero.
  assert.equal(sendRate([5, 5, 5, 5].map((m, i) => ({ at: i * 1500, n: m * MB }))), null);
});

test("time left is never zero or endless mid-transfer", () => {
  assert.equal(timeLeftText(10 * MB, 0), null);
  assert.equal(timeLeftText(10 * MB, Number.NaN), null);
  assert.equal(timeLeftText(0, MB), null);
  assert.equal(timeLeftText(1, MB), "a few seconds left");
  assert.equal(timeLeftText(33 * MB, MB), "35 s left");
  assert.equal(timeLeftText(240 * MB, MB), "4 min left");
  // Repeated readings mid-transfer: each sending line has a time left or none, never "0" or "Infinity".
  const samples = [0, 0, 0, 2, 2, 4, 4, 4].map((m, i) => ({ at: i * 1500, n: m * MB }));
  for (let k = 1; k <= samples.length; k++) {
    const s = sendingOf(view({ state: "sending", steps: marks("prepared", "stopped", "packed"), pkg: { size: 34 * MB }, received: samples[k - 1]!.n, ext: { sent: samples.slice(0, k) } }));
    assert.ok(s);
    assert.ok(!/(^|\D)0 s|Infinity|NaN/.test(`${s.speed} ${s.left}`), `${k}: ${s.speed} ${s.left}`);
    assert.equal(s.speed === null, s.left === null, `${k}`);
  }
});
