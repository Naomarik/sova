// The wire goldens (README.md here): what the browser's live path does with each event before milestone 3
// ports it to SovaEvent. For a faux stream, the v1 control frames the server sends (toWireEvent plus the
// message_end entry id); for every input, the per-step LiveState trace and the effects log of today's
// applyEvent. W3.2's reducer must reproduce the traces from v2 frames and from fromV1(control frames); W3.4's
// server must send the control frames byte for byte.
import assert from "node:assert/strict";
import { createStore } from "solid-js/store";
import { toWireEvent } from "../../../../chat-manager";
import { messageContextTokens } from "../../../../../src/lib/context";
import * as live from "../../../../../src/lib/live";
import { NO_VIEW, type LiveEffect, type LiveEffectsContext } from "../../../../../src/lib/live-effects";
import { isObj } from "../../../../../src/lib/message";
import { navigateDetails } from "../../../../../src/lib/overseer";
import type { Call, Sequence } from "./live-calls";

export type { Call, Sequence };

/** The second view every applyEvent runs in: the Overseer's chat, in the tab whose message started the turn. */
export const OVERSEER_MINE: LiveEffectsContext = { overseer: true, mine: true };
/** `new Date()` while a trace runs (an aborted reply's `stoppedAt`). */
export const FIXED_NOW = Date.UTC(2026, 0, 1);

/**
 * The frames the server sends for a faux stream, as the strings clients receive (server/ws.ts sends
 * JSON.stringify of each): `{type:"event", event: toWireEvent(ev)}`, a message_end tagged with `entryId` when
 * the leaf pi wrote at that moment holds the very message (ChatSession.holdForEntryId). The session file
 * stands in for the leaf: the next message entry, in order, whose message is the event's.
 */
export function controlFrames(events: readonly unknown[], sessionJsonl: string): string[] {
  const entries = sessionJsonl
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>)
    .filter((e) => e.type === "message");
  let next = 0;
  return events.map((event) => {
    const wire: { type: "event"; event: unknown; entryId?: string } = { type: "event", event: toWireEvent(event) };
    if (isObj(event) && event.type === "message_end") {
      const message = JSON.stringify(event.message);
      const at = entries.findIndex((e, i) => i >= next && JSON.stringify(e.message) === message);
      if (at !== -1) {
        wire.entryId = String(entries[at]!.id);
        next = at + 1;
      }
    }
    return JSON.stringify(wire);
  });
}

/** What ChatView's `case "event"` queues for a frame: the event, with a message_end's entry id on it. */
export function clientEvent(frame: string): unknown {
  const msg = JSON.parse(frame) as { event: unknown; entryId?: string };
  return msg.entryId && isObj(msg.event) ? { ...msg.event, entryId: msg.entryId } : msg.event;
}

/**
 * The effects ChatView's flush decided inline before W3.0 (its conditions verbatim, in its order: the
 * ones it ran before applyEvent, then the settle after it). Every trace checks applyEvent's effects
 * against this, so the extraction is proven on every recorded event.
 */
export function flushEffectsBeforeW30(ev: unknown, overseer: boolean, mine: boolean): LiveEffect[] {
  const out: LiveEffect[] = [];
  if (isObj(ev) && ev.type === "agent_start") out.push("clearTurnError", "announceWorking");
  if (isObj(ev) && ev.type === "message_end" && isObj(ev.message) && ev.message.role === "assistant") {
    const tokens = messageContextTokens(ev.message);
    if (tokens !== null) out.push({ context: tokens });
  }
  if (isObj(ev) && ev.type === "compaction_start") out.push("compacting");
  if (isObj(ev) && ev.type === "compaction_end") {
    out.push("compactingDone");
    if (isObj(ev.result)) out.push("compacted");
  }
  if (overseer && isObj(ev) && ev.type === "tool_execution_end" && ev.toolName === "sova_navigate" && ev.isError !== true && mine) {
    const nav = navigateDetails(isObj(ev.result) ? ev.result.details : undefined);
    if (nav) out.push({ navigate: nav.href });
  }
  if (isObj(ev) && ev.type === "agent_settled") out.push("settled");
  return out;
}

export interface Step {
  /** The call (live.test inputs) or the frame's index (faux streams). */
  call?: Call;
  frame?: number;
  /** applyEvent's effects with no view; `overseer` in OVERSEER_MINE's, only when they differ. */
  effects?: LiveEffect[];
  overseer?: LiveEffect[];
  /** A mutator's return value (takeBackQueued's text). */
  returned?: unknown;
  /** The LiveState after the step, as JSON. */
  state: unknown;
}

const snapshot = (s: live.LiveState): unknown => JSON.parse(JSON.stringify(s));

/** `fn` with `new Date()` at FIXED_NOW. */
function atFixedNow<T>(fn: () => T): T {
  const Real = globalThis.Date;
  globalThis.Date = new Proxy(Real, { construct: (target, args) => (args.length ? Reflect.construct(target, args) : new target(FIXED_NOW)) });
  try {
    return fn();
  } finally {
    globalThis.Date = Real;
  }
}

/**
 * The trace of `calls` on a fresh store: after each, the state and (for applyEvent) its effects. A twin store
 * runs every call in OVERSEER_MINE's view; the view may change effects, never the state. Each applyEvent's
 * effects must equal the flush they were pulled out of (flushEffectsBeforeW30), in both views.
 */
export function trace(calls: readonly Call[], frames = false): Step[] {
  return atFixedNow(() => {
    const [s, set] = createStore<live.LiveState>(live.emptyLive());
    const [twin, setTwin] = createStore<live.LiveState>(live.emptyLive());
    return calls.map((call, i): Step => {
      const where = frames ? `frame ${i}` : `call ${i} (${call.fn})`;
      const step: Step = frames ? { frame: i, state: null } : { call, state: null };
      if (call.fn === "applyEvent") {
        const ev = call.args[0];
        const effects = live.applyEvent(set, ev, NO_VIEW);
        const overseer = live.applyEvent(setTwin, ev, OVERSEER_MINE);
        assert.deepEqual(effects, flushEffectsBeforeW30(ev, false, false), `${where}: effects differ from the pre-W3.0 flush`);
        assert.deepEqual(overseer, flushEffectsBeforeW30(ev, true, true), `${where}: Overseer effects differ from the pre-W3.0 flush`);
        step.effects = effects;
        if (JSON.stringify(overseer) !== JSON.stringify(effects)) step.overseer = overseer;
      } else {
        const fn = live[call.fn] as (set: unknown, ...args: unknown[]) => unknown;
        const returned = fn(set, ...call.args);
        fn(setTwin, ...call.args);
        if (returned !== undefined) step.returned = returned;
      }
      step.state = snapshot(s);
      assert.deepEqual(snapshot(twin), step.state, `${where}: the view changed the state`);
      return step;
    });
  });
}

/** A faux stream's trace: each control frame through ChatView's unwrapping, then applyEvent. */
export const frameTrace = (frames: readonly string[]): Step[] =>
  trace(frames.map((f) => ({ fn: "applyEvent", args: [clientEvent(f)] })), true);

/** A sequence's file name: its test name, lowercased, every run of other characters one "-". */
export function slug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 100);
}
