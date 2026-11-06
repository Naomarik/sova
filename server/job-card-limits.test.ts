// §chat.profiles/limits for a background job's end card: the run it opens is not the user's, so its
// sends spend the on-its-own (per day) allowance, never the per-message one; a card queued behind the
// user's reply ends the user's part of that run; it doesn't renew the per-message count, and it keeps
// the run's hop. In-process: the run's standing as the chat runtime tracks it (RunState, UserTurns).
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { jobCardText, type JobRecord } from "../pi-config/extensions/subagents/job-store.ts";
import { RunState, SessionLimits } from "./session-powers";
import type { TurnEvent } from "./user-turns";

const LIMITS = { hops: 3, perMessage: 2, perDay: 3, targetsPerRun: 5, perPair: 6 };
const card = (id = "j1") => {
  const j: JobRecord = { v: 1, id, sessionId: "S", path: "/s.jsonl", kind: "kept", command: "make lab > lab.log &", cwd: "/w", unit: "u.scope", driver: "systemd", startedAt: 0, bootId: "b", output: "/w/lab.log", ended: { at: 600_000, how: "exited", card: "wake" } };
  return jobCardText([j], {});
};

/** A run state over a stand-in session: `typed` hands a message in as the composer does (marked as the
    user's), `extension` as an extension's sendUserMessage does (unmarked), each entering the run. */
function rig() {
  const limits = new SessionLimits("S", LIMITS, null);
  const run = new RunState(limits);
  let claim: ((m: unknown) => void) | null = null;
  run.turns.watch({ onUserMessage: (cb: (m: unknown) => void) => void (claim = cb) } as never);
  const ev = (e: unknown) => run.observe(e as TurnEvent);
  const enter = (text: string, marked: boolean) => {
    const msg = { role: "user", content: [{ type: "text", text }] };
    if (marked) run.turns.send(() => claim!(msg));
    else claim!(msg);
    ev({ type: "message.start", role: "user", text, handle: msg });
  };
  const send = (target: string) => {
    const why = limits.check(target, run.hop + 1, run.attended());
    if (!why) limits.take(target, run.attended());
    return why;
  };
  return { limits, run, ev, enter, send };
}

describe("a background job's end card and the send limits", () => {
  test("a run the card opened is not the user's: its sends spend the 40-a-day allowance", () => {
    const r = rig();
    r.ev({ type: "run.start" });
    r.enter(card(), false);
    assert.equal(r.run.attended(), false);
    assert.equal(r.send("t1"), null);
    assert.deepEqual(r.limits.counts().own, 1);
    assert.equal(r.limits.counts().turn, 0, "never the per-message allowance");
    r.send("t2");
    r.send("t3");
    assert.match(r.send("t4") ?? "", /at most 3 sends a day in runs the user didn't start/);
  });

  test("a card queued behind the user's reply ends the user's part of that run; it renews no per-message count", () => {
    const r = rig();
    r.ev({ type: "run.start" });
    r.enter("deploy it", true);
    assert.equal(r.run.attended(), true);
    r.send("t1");
    r.send("t2");
    assert.equal(r.limits.counts().turn, 2);
    r.ev({ type: "message.start", role: "assistant", handle: { role: "assistant" } });
    r.enter(card(), false);
    assert.equal(r.run.attended(), false, "the follow-up is the job's, not the user's");
    assert.equal(r.limits.counts().turn, 2, "the card isn't a message from the user");
    assert.equal(r.send("t3"), null);
    assert.equal(r.limits.counts().own, 1);
  });

  test("a card joining a run keeps its hop, as a wake nudge does", () => {
    const r = rig();
    r.ev({ type: "run.start" });
    r.run.expectHop("from another chat", 3);
    r.enter("from another chat", false);
    assert.equal(r.run.hop, 3);
    r.enter(card(), false);
    assert.equal(r.run.hop, 3);
    assert.match(r.send("t1") ?? "", /^Hop limit: this message would be hop 4/);
  });
});
