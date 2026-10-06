// The wire goldens (README.md here): what the browser's live path does with each event. For a faux stream,
// the v1 control frames the server sends (toWireEvent plus the message_end entry id); for every input, the
// per-step LiveState trace and applyEvent's effects log. The reducer must give the same trace on both paths,
// (a) v2 frames and (b) fromV1(control frames), and the server must send the control frames byte for byte.
import assert from "node:assert/strict";
import { createStore } from "solid-js/store";
import { toV1Event as toWireEvent } from "../../wire";
import * as live from "../../../../../src/lib/live";
import type { SovaEvent } from "../../../../../shared/harness-wire";
import type { V1EventFrame } from "../../../../../shared/protocol";
import { fromV1 } from "../../../../../shared/wire-v1";
import { NO_VIEW, type LiveEffect, type LiveEffectsContext } from "../../../../../src/lib/live-effects";
import { isObj } from "../../../../../src/lib/message";

/** The store mutators a sequence calls; each takes the store's setter first. */
export type Mutator = "applyEvent" | "addPendingPrompt" | "applyQueue" | "markRemoved" | "markQueued" | "markDelivered" | "takeBackQueued";
export interface Call {
  fn: Mutator;
  /** The arguments after the setter, as JSON. */
  args: unknown[];
}
export interface Sequence {
  name: string;
  calls: Call[];
}

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

/** What ChatView's `case "event"` queued for a frame before the port: the event, with a message_end's entry
    id on it (the recorded inputs' form). */
export function clientEvent(frame: string): unknown {
  const msg = JSON.parse(frame) as { event: unknown; entryId?: string };
  return msg.entryId && isObj(msg.event) ? { ...msg.event, entryId: msg.entryId } : msg.event;
}

/** A recorded input event's v1 frame, as the server sends it: a message_end's entry id on the frame. */
export function frameOf(ev: unknown): V1EventFrame {
  if (!isObj(ev)) return { type: "event", event: ev };
  const { entryId, ...event } = ev;
  return { type: "event", event, ...(typeof entryId === "string" && entryId ? { entryId } : {}) };
}

/**
 * The events the ported reducer gets for a v1 frame, on each path, as ChatView reads them (live.ts
 * liveEventsOf), through JSON: (a) the wire-2 frames a server makes of it (one per `fromV1` event) and (b) the
 * v1 frame itself, through the shim. The baton sender marker is client-local: it is applied as it is.
 */
export function pathEvents(frame: V1EventFrame): { v2: live.LiveEvent[]; shim: live.LiveEvent[] } {
  const ev = frame.event;
  if (isObj(ev) && ev.type === live.BATON_SENT_EVENT) return { v2: [ev as live.LiveEvent], shim: [ev as live.LiveEvent] };
  const wire = <T>(v: T): T => JSON.parse(JSON.stringify(v));
  return {
    v2: fromV1(frame).flatMap((e: SovaEvent) => live.liveEventsOf(wire({ type: "event", v: 2, event: e } as const))),
    shim: live.liveEventsOf(wire(frame)),
  };
}

export interface Step {
  /** The call (a recorded sequence) or the frame's index (faux streams). */
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
 * The trace of `calls` on a fresh store: after each, the state and (for applyEvent) its effects. An applyEvent
 * call's v1 event (from `frames[i]` when given, else `frameOf` its recorded event) runs through the shim path,
 * which is what is recorded, and through the v2 path on a second store; the two must agree step by step. Twin
 * stores run each path in OVERSEER_MINE's view; the view may change effects, never the state.
 */
export function trace(calls: readonly Call[], frames?: readonly string[]): Step[] {
  return atFixedNow(() => {
    const fresh = () => createStore<live.LiveState>(live.emptyLive());
    const [s, set] = fresh();
    const [twin, setTwin] = fresh();
    const [v2s, setV2] = fresh();
    const [v2Twin, setV2Twin] = fresh();
    const apply = (to: typeof set, events: live.LiveEvent[], view: LiveEffectsContext) => events.flatMap((e) => live.applyEvent(to, e, view));
    return calls.map((call, i): Step => {
      const where = frames ? `frame ${i}` : `call ${i} (${call.fn})`;
      const step: Step = frames ? { frame: i, state: null } : { call, state: null };
      if (call.fn === "applyEvent") {
        const ev = call.args[0];
        const paths = pathEvents(frames ? (JSON.parse(frames[i]!) as V1EventFrame) : frameOf(ev));
        const effects = apply(set, paths.shim, NO_VIEW);
        const overseer = apply(setTwin, paths.shim, OVERSEER_MINE);
        assert.deepEqual(apply(setV2, paths.v2, NO_VIEW), effects, `${where}: v2 effects differ from the shim's`);
        assert.deepEqual(apply(setV2Twin, paths.v2, OVERSEER_MINE), overseer, `${where}: v2 Overseer effects differ from the shim's`);
        step.effects = effects;
        if (JSON.stringify(overseer) !== JSON.stringify(effects)) step.overseer = overseer;
      } else {
        const fn = live[call.fn] as (set: unknown, ...args: unknown[]) => unknown;
        const returned = fn(set, ...call.args);
        for (const other of [setTwin, setV2, setV2Twin]) fn(other, ...call.args);
        if (returned !== undefined) step.returned = returned;
      }
      step.state = snapshot(s);
      assert.deepEqual(snapshot(twin), step.state, `${where}: the view changed the state`);
      assert.deepEqual(snapshot(v2s), step.state, `${where}: the v2 path's state differs from the shim's`);
      assert.deepEqual(snapshot(v2Twin), step.state, `${where}: the view changed the v2 path's state`);
      return step;
    });
  });
}

/** A faux stream's trace: each control frame as ChatView reads it, on both paths. */
export const frameTrace = (frames: readonly string[]): Step[] => trace(frames.map((f) => ({ fn: "applyEvent", args: [clientEvent(f)] })), frames);

/** A sequence's file name: its test name, lowercased, every run of other characters one "-". */
export function slug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 100);
}
