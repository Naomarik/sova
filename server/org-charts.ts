// Typed wrapper over the vendored organization statecharts (server/vendor/org-charts.js).
//
// The bundle is CLJS (fulcrologic/statecharts 1.4.0-RC18) compiled by shadow-cljs from org-charts/;
// rebuild it with `node scripts/build-org-charts.mjs` (needs a JVM; `pnpm build` never runs it).
// The org host (server/org-host/) is its one user in the server; the spike replay uses it too.
//
// Marshalling rules (org-charts/src/sova/org_charts/api.cljs): object keys are camelCase here and
// kebab keywords in the charts; values are untouched except keyword values, which arrive as
// "ns/name" strings. Event names and state ids are strings ("gather/start", "needs-operator").
// Every call takes an optional `now` (epoch ms): the engine clock for that call, so replays run on
// virtual time. The engine stamps it on every event it delivers as `data.at` (overwriting any `at`
// the caller put in the data) and into the charts' data model as `now`.
//
// Durability contract (host side): after each call, write `result.snapshots` together (one atomic
// write, the host's journal): a cross-session send is only durable once its target's step is saved,
// and within one call that target step has already run. After a restart, load the org's sessions,
// `resume` them, then `fireDue(now)`. With `loadCold`, a send to a session not loaded loads it; an id
// that exists nowhere throws OrgChartsError `sova/unknown-session` and the call changes nothing.
// Full contract: org-charts/src/sova/org_charts/engine/API.md.
//
// Step limit: one event may take at most `maxMicrosteps` microsteps (default 200). An eventless cycle
// in a chart then throws `OrgChartsStepLimitError` from start / send / trial / fireDue instead of
// blocking the event loop, and the whole call is rolled back (sessions, generations, the queue): the
// snapshots last written stay the truth. onSave and invocation callbacks already made for earlier
// steps of that call are not taken back, which is why the host writes `result.snapshots`, not onSave's.

import * as vendored from "./vendor/org-charts.js";

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type JsonObject = { [key: string]: Json };

/** A registered chart's name ("org", "person", "baton", "item", …: the refit's registry). */
export type ChartName = string;

/** An effect intent a chart appended to its outbox; the host runs it after the snapshot is saved. */
export interface Effect {
  kind: string;
  key?: string;
  sessionId: string;
  [field: string]: Json | undefined;
}

/** Why an act is refused (engine explain): stage is final | level | pre | state | check | cond | invalid | stale | legacy. */
export interface Refusal {
  sentence: string;
  tail?: string | null;
  stage?: string;
  check?: string | null;
  status?: number | null;
  code?: string | null;
}

/** An act (or effect) waiting in a hold (q10). `act` holds re-deliver the act at `until`. */
export interface Hold {
  id: string;
  sessionId: string;
  act?: boolean;
  event?: string;
  kind: string;
  data?: JsonObject;
  effect?: JsonObject;
  what?: string | null;
  since: number;
  until: number;
  by?: string | null;
  overseerId?: string;
  projectId?: string;
  scope?: string | null;
  counts?: string;
  reserve?: number;
  whileIn?: string;
  /** r7: "hours" when it waits for the person's working hours (until the window opens). */
  wait?: "hours";
  /** q12: its kind is in the project's confirm list: it waits past `until` for approve or cancel. */
  confirm?: boolean;
  /** q12: past its end and still unreviewed (the stall clock runs from `until`). */
  waiting?: boolean;
}

/** One processed event (the transition log entry, before privacy scrubbing). */
export interface Step {
  sessionId: string;
  chart?: string;
  at: number;
  event: string;
  data?: JsonObject;
  invokeId?: string | null;
  by?: string | null;
  via?: string | null;
  reason?: string;
  before: string[];
  after: string[];
  /** `{path: [from, to]}` for every data key the step changed. */
  changed?: Record<string, [Json, Json]>;
  /** The keys of the effects this step emitted. */
  effects?: string[];
  outbox: Effect[];
  /** Holds this step started, and the ids of holds that ended (cancelled). */
  holds?: Hold[];
  holdsEnded?: string[];
  /** The act was held instead of taken (a q10 hold, an r7 hours wait). */
  held?: Hold;
  /** r8a: the step's feed class (refusals, corrections, holds and starts are always feed). */
  feed?: "feed" | "quiet";
  /** The session's project (its data's projectId, else the envelope's). */
  projectId?: string | null;
  /** r7: the operator's act went at once although the person is off hours until then. */
  offHours?: number;
  /** The act was refused (nothing changed). */
  refused?: Refusal | null;
  /** Nothing happened (not an act): no save. */
  ignored?: boolean;
  /** The session's snapshot changed. */
  saved?: boolean;
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
  /** The run's id: report results with it (`invokeId` option); a result for an ended run is stale. */
  runId: string | null;
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
  /** Holds started in this call. */
  holds: Hold[];
  spawned: { sessionId: string; chart: string; by: string; link: string | null }[];
  /** Sessions loaded through loadCold. */
  loaded: string[];
  /** Answers for ended runs or answered effects, dropped. */
  stale: JsonObject[];
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

export interface TrialResult extends Omit<StepResult, "configuration"> {
  taken: boolean;
  transitions: TransitionInfo[];
  /** When not taken: the transitions for this event whose guard refused. */
  refused: TransitionInfo[];
  /** The refusal sentence, when not taken. */
  refusal: string | null;
  refusalInfo: Refusal | null;
  before: string[];
  configuration: string[];
}

export interface EnabledEvent {
  event: string;
  enabled: boolean;
  refusal?: Refusal;
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

/** What onInvokeStart / onInvokeStop receive (an InvocationRecord). */
export interface Invocation {
  op: "start" | "stop";
  sessionId: string;
  /** The chart's invoke id ("look"); report results with `runId`. */
  invokeId: string;
  runId: string | null;
  type: string;
  params?: JsonObject;
}

/** Who made a held act (its release is stamped for them), or the driving session's project. */
export interface StampContext {
  by?: string;
  overseerId?: string;
  projectId?: string;
}

export interface EngineOptions {
  /** A session not loaded: its snapshot text, or null when it exists nowhere (sync). May throw (a broken snapshot): the call rolls back with that error. */
  loadCold?: (sessionId: string) => string | null;
  /** A fresh envelope for an act the engine delivers itself (a held act's release, a chart's drive). */
  stamp?: (sessionId: string, event: string, payload: JsonObject, ctx: StampContext) => JsonObject;
  /** Called after every step with the session's full snapshot (EDN text: working memory + its queue). */
  onSave?: (sessionId: string, snapshot: string, info: SaveInfo) => void;
  /** An invocation started (state entered); called once the call committed. */
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
  /** The real call on the engine, then rolled back: nothing saved, sent, invoked or called back. */
  trial(sessionId: string, event: string, data?: JsonObject, opts?: CallOptions): TrialResult;
  /** Why the act would be refused now, or null. */
  explain(sessionId: string, event: string, data?: JsonObject, opts?: CallOptions): Refusal | null;
  /** q9/r5: only the project overseer in an attended turn, with a reason. */
  setState(sessionId: string, change: { states: string[]; patch?: JsonObject; reason?: string }, envelope: JsonObject, opts?: CallOptions): StepResult;
  /** `sova/resumed` to each, then link/moved per link; past-due timers wait for fireDue. */
  resume(sessionIds: string[], opts?: CallOptions): StepResult;
  configuration(sessionId: string): string[] | null;
  running(sessionId: string): boolean;
  data(sessionId: string): JsonObject | null;
  chartOf(sessionId: string): ChartName | null;
  enabledEvents(sessionId: string, envelope?: JsonObject, opts?: CallOptions): EnabledEvent[];
  /** Sessions that may be unloaded at `now` (settled per their chart's `cold?`, idle `minAge` ms, nothing pending). */
  coldSessions(now: number, minAge?: number | null): string[];
  /** A snapshot text read without loading it, against this engine's charts (runtime ones included). */
  peek(text: string): SnapshotPeek;
  /** Every held act of every loaded session (or of one). */
  holds(sessionId?: string | null): Hold[];
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

/** What a chart declares (engine chart-info): acts with metadata, states, transitions, invocations. */
export interface ChartInfo {
  name: ChartName;
  version: number;
  storage: "portable" | "host-local";
  exported: string[];
  redact: Record<string, string>;
  acts: Record<string, { needs?: string | null; tool?: string; counts?: string; hold?: boolean; correction?: boolean; peopleFacing?: boolean; codeFacing?: boolean; pre: string[]; [k: string]: Json | undefined }>;
  states: { id: string; kind: string; parent: string }[];
  transitions: ({ id: string; source: string; event: string[]; target: string[]; type: string; guarded: boolean } & Record<string, Json>)[];
  invocations: { state: string; type: string; id: string }[];
  corrections: string[];
}

interface Vendored {
  createEngine(opts?: EngineOptions): OrgCharts;
  charts(): { name: ChartName; version: number; storage: "portable" | "host-local" }[];
  chartInfo(name: string): ChartInfo | null;
  migrateText(text: string): string;
  peekSnapshot(text: string): SnapshotPeek;
}

/** A snapshot read without loading it (cold sessions). */
export interface SnapshotPeek {
  chart: ChartName;
  configuration: string[];
  data: JsonObject;
  running: boolean;
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

/** A typed engine error: `sova/unknown-session` (a send to an id that exists nowhere) or
    `sova/session-exists` (a start or spawn of an existing id). The call changed nothing. */
export class OrgChartsError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly sessionId: string | null,
  ) {
    super(message);
    this.name = "OrgChartsError";
  }
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
      const e = err as Partial<StepLimitDetails> & { code?: string; message?: string; name?: string };
      if (e?.name === "OrgChartsError" && typeof e.code === "string") throw new OrgChartsError(String(e.message), e.code, e.sessionId ?? null);
      if (e?.code !== "sova/step-limit") throw err;
      const { limit, microsteps, sessionId, event, configuration, transitions } = e as StepLimitDetails;
      throw new OrgChartsStepLimitError(String(e.message), { limit, microsteps, sessionId, event, configuration, transitions });
    }
  };
}

/** The typed engine over a raw one: a step limit becomes OrgChartsStepLimitError. */
export function typedEngine<E extends OrgCharts>(e: E): E {
  return {
    ...e,
    start: typed(e.start),
    send: typed(e.send),
    trial: typed(e.trial),
    explain: typed(e.explain),
    setState: typed(e.setState),
    resume: typed(e.resume),
    fireDue: typed(e.fireDue),
    load: typed(e.load),
  };
}

export function createOrgCharts(opts: EngineOptions = {}): OrgCharts {
  return typedEngine(lib.createEngine(opts));
}

export function chartVersions(): { name: ChartName; version: number; storage: "portable" | "host-local" }[] {
  return lib.charts();
}

export function chartInfo(name: string): ChartInfo | null {
  return lib.chartInfo(name);
}

/** A snapshot's chart, configuration, data and running flag without loading it (throws when unreadable). */
export function peekSnapshot(text: string): SnapshotPeek {
  return lib.peekSnapshot(text);
}

/** A snapshot's text at its chart's current version (throws when it can't be migrated). */
export function migrateSnapshot(text: string): string {
  return lib.migrateText(text);
}
