// UserTurns' own-message bit: a run the global Overseer's message opened is attended (the operator's, to its
// model and limits) but never the operator's own message; a typed message or a click is. In-process, no harness.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { TurnEvent } from "./user-turns";

const { UserTurns } = await import("./user-turns");

/** A UserTurns watching a stand-in session: `send` hands `msg` to it as the SDK would, then the run begins. */
function rig() {
  const turns = new UserTurns();
  let claim: ((m: unknown) => void) | null = null;
  turns.watch({ onUserMessage: (cb: (m: unknown) => void) => void (claim = cb) } as never);
  const ev = (e: unknown) => turns.observe(e as TurnEvent);
  const run = (text: string, opts: { overseer?: boolean; confirm?: string; marked?: boolean } = {}) => {
    const msg = { role: "user", content: text };
    const hand = () => claim!(msg);
    if (opts.marked === false) hand();
    else turns.send(hand, opts.confirm, { overseer: opts.overseer });
    ev({ type: "run.start" });
    ev({ type: "message.start", role: "user", text, handle: msg });
    return msg;
  };
  return { turns, run, ev };
}

test("the operator's typed message: attended and their own", () => {
  const { turns, run } = rig();
  run("add Rita to the roster");
  assert.equal(turns.attended(), true);
  assert.equal(turns.ownMessage(), true);
});

test("a message the global Overseer sent: attended, never the operator's own", () => {
  const { turns, run } = rig();
  run("please add Rita", { overseer: true });
  assert.equal(turns.attended(), true, "the operator's to its model and limits");
  assert.equal(turns.ownMessage(), false);
  // The next run, the operator's own: their own again.
  run("now add Rita yourself");
  assert.equal(turns.ownMessage(), true);
});

test("an unmarked message (a wake-up, a look) is neither", () => {
  const { turns, run } = rig();
  run("[wake] something changed", { marked: false });
  assert.equal(turns.attended(), false);
  assert.equal(turns.ownMessage(), false);
});

test("input no one marked after the reply ends the operator's part, and their own with it", () => {
  const { turns, run, ev } = rig();
  run("add Rita");
  ev({ type: "message.start", role: "assistant", handle: { role: "assistant" } });
  ev({ type: "message.start", role: "other", handle: { role: "custom" } });
  assert.equal(turns.attended(), false);
  assert.equal(turns.ownMessage(), false);
});
