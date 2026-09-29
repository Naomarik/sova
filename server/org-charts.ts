// Typed wrapper over the vendored organization statecharts (server/vendor/org-charts.js).
//
// The bundle is CLJS (fulcrologic/statecharts 1.4.0-RC18) compiled by shadow-cljs from org-charts/;
// rebuild it with `node scripts/build-org-charts.mjs` (needs a JVM; `pnpm build` never runs it).
// Spike only: nothing in the live server imports this module.
//
// Marshalling rules (org-charts/src/sova/org_charts/api.cljs): object keys are camelCase here and
// kebab keywords in the charts; values are untouched except keyword values, which arrive as
// "ns/name" strings. Event names and state ids are strings ("gather/start", "needs-operator").
// Every call takes an optional `now` (epoch ms): the engine clock for that call, so replays run on
// virtual time. The engine stamps it on every event it delivers as `data.at` (overwriting any `at`
// the caller put in the data) and into the charts' data model as `now`.
//
// Durability contract (host side): after each call, write `result.snapshots` together (one atomic
// write): a cross-session send is only durable once its target's step is saved, and within one call
// that target step has already run. After a restart, load every session of a project before the
// first send/fireDue: a due event for a session this engine does not hold is dropped and reported
// `delivered: false`. Then send "sova/resumed" and fresh facts.
//
// Step limit: one event may take at most `maxMicrosteps` microsteps (default 200). An eventless cycle
// in a chart then throws `OrgChartsStepLimitError` from start / send / trial / fireDue instead of
// blocking the event loop, and the whole call is rolled back (sessions, generations, the queue): the
// snapshots last written stay the truth. onSave and invocation callbacks already made for earlier
// steps of that call are not taken back, which is why the host writes `result.snapshots`, not onSave's.

import * as vendored from "./vendor/org-charts.js";

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type JsonObject = { [key: string]: Json };

export type ChartName = "project" | "work-item";

/** An effect intent a chart appended to its outbox; the host runs it after the snapshot is saved. */
export interface Effect {
  kind: string;
  key?: string;
  sessionId: string;
  [field: string]: Json | undefined;
}

/** One processed event (the transition log entry). */
export interface Step {
  sessionId: string;
  at: number;
  event: string;
  data?: JsonObject;
  invokeId?: string | null;
  before: string[];
  after: string[];
  outbox: Effect[];
  /** false once the session reached a top-level final state (its configuration is then empty). */
  running: boolean;
  /** Microsteps this event took (the step limit bounds it). */
  microsteps: number;
}

/** A send from one session to another; delivered when the target is loaded in this engine. */
export interface CrossSend {
  from: string;
  to: string;
  event: string;
  data: JsonObject;
  delay: number;
  dueAt: number;
  sendId: string | null;
  delivered: boolean;
}

export interface InvocationRecord {
  op: "start" | "stop";
  sessionId: string;
  invokeId: string;
  type: string;
  params?: JsonObject;
}

export interface EngineError {
  level: string;
  message: string;
}

/** The result of start / send / fireDue: every event processed in the call, in order. */
export interface StepResult {
  /** The addressed session's configuration after the call (fireDue: absent). */
  configuration?: string[];
  steps: Step[];
  outbox: Effect[];
  sends: CrossSend[];
  invocations: InvocationRecord[];
  errors: EngineError[];
  /** The snapshot of every session this call moved: write them together, once per call. */
  snapshots: Record<string, string>;
}

export interface TransitionInfo {
  source: string;
  target: string[];
  event: string[];
  cond: boolean;
  /** Any `:sova/*` attribute on the transition, e.g. "sova/needs": "L2". */
  [tag: `sova/${string}`]: Json;
}

export interface TrialResult {
  taken: boolean;
  transitions: TransitionInfo[];
  /** When not taken: the transitions for this event whose guard refused. */
  refused: TransitionInfo[];
  /** The charts' refusal sentence (guards/explain), when not taken. */
  refusal: string | null;
  before: string[];
  configuration: string[];
  outbox: Omit<Effect, "sessionId">[];
  sends: { to: string; event: string; delay: number; data: JsonObject }[];
  invocations: InvocationRecord[];
  errors: EngineError[];
}

export interface LoadResult {
  sessionId: string;
  chart: ChartName;
  version: number;
  generation: number;
  configuration: string[];
  pending: number;
}

export interface SaveInfo {
  chart: ChartName;
  version: number;
  generation: number;
}

export interface Invocation {
  sessionId: string;
  invokeId: string;
  type: string;
  params?: JsonObject;
}

export interface EngineOptions {
  /** Called after every step with the session's full snapshot (EDN text: working memory + its queue). */
  onSave?: (sessionId: string, snapshot: string, info: SaveInfo) => void;
  /** A `:sova/look` invocation started (state entered). */
  onInvokeStart?: (inv: Invocation) => void;
  /** It was cancelled (state exited). */
  onInvokeStop?: (inv: Invocation) => void;
  /** Default clock when a call passes no `now`. */
  clock?: () => number;
  /** Microsteps one event may take before the call throws OrgChartsStepLimitError (default 200). */
  maxMicrosteps?: number;
  /** More charts, written in JS (org-charts/src/sova/org_charts/engine/js_chart.cljs), by name. A
      shipped chart's name is refused. The engine tests register their probe chart this way. */
  charts?: Record<string, { version: number; chart: unknown }>;
}

export interface CallOptions {
  now?: number;
  /** For events reporting back from an invocation (e.g. "look/finished"). */
  invokeId?: string;
}

export interface OrgCharts {
  start(sessionId: string, chart: ChartName, data?: JsonObject, opts?: CallOptions): StepResult;
  send(sessionId: string, event: string, data?: JsonObject, opts?: CallOptions): StepResult;
  /** A speculative send on a copy: nothing saved, sent or invoked. */
  trial(sessionId: string, event: string, data?: JsonObject, opts?: CallOptions): TrialResult;
  configuration(sessionId: string): string[] | null;
  data(sessionId: string): JsonObject | null;
  enabledEvents(sessionId: string, envelope?: JsonObject, opts?: CallOptions): string[];
  /** Earliest delayed send due across loaded sessions. */
  nextDueAt(): number | null;
  /** Advance the clock to `now` and deliver everything due. */
  fireDue(now: number): StepResult;
  dump(sessionId: string): string | null;
  /** Nothing runs on load: send "sova/resumed" (and fresh facts) afterwards. */
  load(sessionId: string, snapshot: string): LoadResult;
  unload(sessionId: string): void;
  sessions(): string[];
  generation(sessionId: string): number | null;
}

interface Vendored {
  createEngine(opts?: EngineOptions): OrgCharts;
  charts(): { name: ChartName; version: number }[];
}

const lib = vendored as unknown as Vendored;

export interface StepLimitDetails {
  limit: number;
  microsteps: number;
  sessionId: string;
  event: string;
  /** The session's active states when it tripped, and the transitions it was about to take. */
  configuration: string[];
  transitions: string[];
}

/** One event took more microsteps than `maxMicrosteps`: an eventless cycle in a chart. */
export class OrgChartsStepLimitError extends Error {
  readonly code = "sova/step-limit";
  constructor(
    message: string,
    readonly details: StepLimitDetails,
  ) {
    super(message);
    this.name = "OrgChartsStepLimitError";
  }
}

function typed<A extends unknown[], R>(f: (...args: A) => R): (...args: A) => R {
  return (...args) => {
    try {
      return f(...args);
    } catch (err) {
      const e = err as Partial<StepLimitDetails> & { code?: string; message?: string };
      if (e?.code !== "sova/step-limit") throw err;
      const { limit, microsteps, sessionId, event, configuration, transitions } = e as StepLimitDetails;
      throw new OrgChartsStepLimitError(String(e.message), { limit, microsteps, sessionId, event, configuration, transitions });
    }
  };
}

/** The typed engine over a raw one: a step limit becomes OrgChartsStepLimitError. */
export function typedEngine<E extends OrgCharts>(e: E): E {
  return { ...e, start: typed(e.start), send: typed(e.send), trial: typed(e.trial), fireDue: typed(e.fireDue) };
}

export function createOrgCharts(opts: EngineOptions = {}): OrgCharts {
  return typedEngine(lib.createEngine(opts));
}

export function chartVersions(): { name: ChartName; version: number }[] {
  return lib.charts();
}
