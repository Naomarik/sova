import type { AgentSession, AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { SpecialKind } from "./chat-manager";

/**
 * The runaway-stream guard (§chat.transcript/runaway-stream): every hosted runtime's turn is
 * stopped once its stream passes a cap for its runtime kind.
 *
 * Why it exists: pi-ai re-parses a tool call's whole accumulated argument string on every delta
 * (`parseStreamingJson`, O(n) per delta, so O(n²) per call, on the main thread). A model that
 * degenerates into endless whitespace inside a tool call pins the process: the event loop turns
 * only once per network read, and each read's events cost more than the last. This listener runs
 * once per delta, a few microtasks after that delta's parse, so it bounds the damage to roughly
 * cap² instead of forever. It counts characters from the deltas only (never re-stringifies the
 * partial arguments), and checks the clock on every event as well as from a timer: under that
 * load a timer fires late.
 */

export type StreamTripKind = "whitespace" | "tool-args" | "output" | "wall-clock" | "starved";
export interface StreamTrip {
  kind: StreamTripKind;
  /** Plain words for the operator ("a tool call's arguments passed 65,536 characters"). */
  detail: string;
  /** The measured quantity that tripped (characters, or milliseconds for the clocks). */
  chars: number;
  at: string;
}
export interface StreamCaps {
  /** Consecutive raw whitespace characters in one tool call's argument stream. */
  whitespaceRunChars: number;
  /** One tool call's argument characters. */
  toolArgChars: number;
  /** Text + thinking + tool-argument characters of one assistant message; null = none. */
  outputChars: number | null;
  /** agent_start → agent_end; null = none. */
  runWallMs: number | null;
  /** How stale the heartbeat may be (the loop starved)… */
  starvedMs: number;
  /** …while the current tool call is at least this big. */
  starvedMinArgChars: number;
}

const K = 1024;
const COMMON = { whitespaceRunChars: 8 * K, starvedMs: 750, starvedMinArgChars: 128 * K } as const;
/** The caps by runtime kind. Baton sessions (share links, the wrap-up) and both overseers run unattended. */
const CAPS: Record<"baton" | "overseer" | "project-overseer" | "chat", StreamCaps> = {
  baton: { ...COMMON, toolArgChars: 64 * K, outputChars: 256 * K, runWallMs: 10 * 60_000 },
  overseer: { ...COMMON, toolArgChars: 64 * K, outputChars: null, runWallMs: 10 * 60_000 },
  // Its conversation lives in the org's workspace repo, cloned to every host: one reply can't grow past what reads back.
  "project-overseer": { ...COMMON, toolArgChars: 64 * K, outputChars: K * K, runWallMs: 10 * 60_000 },
  chat: { ...COMMON, toolArgChars: K * K, outputChars: null, runWallMs: null },
};

let override: Partial<StreamCaps> | null = null;
/** Tests only: raise or lower the caps of every kind (null restores the table). */
export function setStreamCapsForTest(caps: Partial<StreamCaps> | null): void {
  override = caps;
}

export function capsFor(kind: SpecialKind | null): StreamCaps {
  const base = CAPS[kind ?? "chat"];
  return override ? { ...base, ...override } : base;
}

/** The longest a baton run (the wrap-up included) may take before the guard stops it. */
export const BATON_RUN_WALL_MS = CAPS.baton.runWallMs!;

export interface GuardClock {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(t: unknown): void;
  /** When the event loop last turned (the heartbeat). */
  lastBeat(): number;
}

// One heartbeat for the process: an interval that can't run while the loop is starved, so its
// age, read from inside the hot chain, measures the starvation.
let beat = Date.now();
let heart: NodeJS.Timeout | null = null;
function startHeart(): void {
  if (heart) return;
  beat = Date.now();
  heart = setInterval(() => (beat = Date.now()), 250);
  heart.unref();
}

const realClock: GuardClock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => {
    const t = setTimeout(fn, ms);
    t.unref();
    return t;
  },
  clearTimeout: (t) => clearTimeout(t as NodeJS.Timeout),
  lastBeat: () => beat,
};

const n = (x: number) => x.toLocaleString("en-US");

/** Raw whitespace in a JSON stream. Tabs and newlines inside a JSON string arrive escaped, so a long raw run is never a real value. */
const isSpace = (c: number) => c === 32 || c === 9 || c === 10 || c === 13;

/**
 * Watch one session's stream. On a trip: `onTrip` once, then `session.abort()` (which also stops
 * pi's auto-retry), once per run. `onRunStart` runs at each agent_start. Returns the unsubscribe.
 */
export function attachStreamGuard(
  session: Pick<AgentSession, "subscribe" | "abort">,
  caps: () => StreamCaps,
  hooks: { onTrip(trip: StreamTrip): void; onRunStart?(): void },
  clock: GuardClock = realClock,
): () => void {
  if (clock === realClock) startHeart();
  let running = false;
  let tripped = false;
  let runStart = 0;
  let timer: unknown = null;
  let output = 0;
  /** Per tool call (content index): argument characters, and the whitespace run at its end. */
  const args = new Map<number, { chars: number; run: number }>();

  const disarm = () => {
    if (timer !== null) clock.clearTimeout(timer);
    timer = null;
  };
  const trip = (kind: StreamTripKind, detail: string, chars: number) => {
    if (tripped || !running) return;
    tripped = true;
    disarm();
    try {
      hooks.onTrip({ kind, detail, chars, at: new Date(clock.now()).toISOString() });
    } finally {
      // Synchronous up to the provider's AbortSignal (agent.abort()); only the idle wait is async.
      session.abort().catch(() => {});
    }
  };
  const checkClock = (c: StreamCaps) => {
    const now = clock.now();
    if (c.runWallMs !== null && now - runStart > c.runWallMs) trip("wall-clock", `the turn ran past ${n(Math.round(c.runWallMs / 60_000))} minutes`, now - runStart);
  };

  const off = session.subscribe((event: AgentSessionEvent) => {
    const type = event.type;
    if (type === "agent_start") {
      running = true;
      tripped = false;
      runStart = clock.now();
      output = 0;
      args.clear();
      disarm();
      const wall = caps().runWallMs;
      if (wall !== null) timer = clock.setTimeout(() => ((timer = null), checkClock(caps())), wall + 1);
      hooks.onRunStart?.();
      return;
    }
    if (type === "agent_end" || type === "agent_settled") {
      running = false;
      disarm();
      return;
    }
    if (!running || tripped) return;
    const c = caps();
    checkClock(c);
    if (tripped) return;
    if (type === "message_start") {
      output = 0;
      args.clear();
      return;
    }
    if (type !== "message_update") return;
    const e = (event as { assistantMessageEvent?: { type: string; contentIndex?: number; delta?: string } }).assistantMessageEvent;
    if (!e) return;
    if (e.type === "toolcall_start") {
      args.set(e.contentIndex ?? -1, { chars: 0, run: 0 });
      return;
    }
    if (e.type !== "toolcall_delta" && e.type !== "text_delta" && e.type !== "thinking_delta") return;
    const delta = typeof e.delta === "string" ? e.delta : "";
    output += delta.length;
    if (c.outputChars !== null && output > c.outputChars) return trip("output", `the reply passed ${n(c.outputChars)} characters`, output);
    if (e.type !== "toolcall_delta") return;
    const i = e.contentIndex ?? -1;
    let a = args.get(i);
    if (!a) args.set(i, (a = { chars: 0, run: 0 }));
    a.chars += delta.length;
    for (let j = 0; j < delta.length; j++) {
      if (!isSpace(delta.charCodeAt(j))) a.run = 0;
      else if (++a.run >= c.whitespaceRunChars)
        return trip("whitespace", `the model streamed ${n(a.run)} whitespace characters in a row into a tool call`, a.run);
    }
    if (a.chars > c.toolArgChars) return trip("tool-args", `a tool call's arguments passed ${n(c.toolArgChars)} characters`, a.chars);
    const stale = clock.now() - clock.lastBeat();
    if (a.chars >= c.starvedMinArgChars && stale > c.starvedMs)
      trip("starved", `the server stalled ${n(stale)} ms parsing a ${n(a.chars)}-character tool call`, a.chars);
  });
  return () => {
    disarm();
    running = false;
    off();
  };
}
