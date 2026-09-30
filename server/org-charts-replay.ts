/**
 * Replays mined organization traces (server/fixtures/org-charts/*.json, written by
 * scripts/org-charts-mine.mjs) through the org charts (server/org-charts.ts) on a virtual clock, and
 * compares every step with what really happened:
 *
 * - every sova_* tool call the real overseer made gets the chart's verdict under the same envelope
 *   (who, attended, level, allowances), and today's rule (`autonomyRefusal` + `TOOL_NEEDS`) is the
 *   oracle both must agree with;
 * - after every step, each work item's configuration is checked against a projection of the stores'
 *   facts written here, independently of the chart;
 * - the watch loop's looks, and the reasons each look carried, are checked against the real ones;
 * - the end state is checked against the stores' last word.
 *
 * A difference is a divergence. Each is classified with the evidence that explains it (version drift,
 * a host check the chart does not hold, a link the stores do not have, the chart catching what today
 * dropped), or left unexplained. The tests require zero unexplained divergences.
 *
 * Shadow only: nothing here changes Sova's behaviour.
 */

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { autonomyRefusal, overRefusal, TOOL_NEEDS, type Need } from "./project-overseer-tools";
import type { Autonomy } from "../shared/project-overseer";

// ---- the trace (the fixture format) ----------------------------------------------------------------

export type Level = "L0" | "L1" | "L2" | "L3";
type Kinds = "gather" | "promote" | "create" | "prompt";

export interface Step {
  dt: number;
  kind: "setting" | "fact" | "turn" | "tool" | "turn-end" | "obs" | "restart" | "operator" | "expect";
  // operator (synthetic): the operator's clicks and host events the stores do not date
  act?: "run-now" | "attach" | "archive" | "unarchive" | "watch-off" | "watch-on" | "merge" | "merge-refused" | "limit-raised" | "reconcile" | "hold" | "resume" | "settle-text";
  /** hold / resume / settle-text: the gap it acts on. */
  gap?: string;
  /** A decision edited in the spec since promotion (the Keep/Restore case). */
  edited?: boolean;
  ok?: boolean;
  /** merge-refused: why. `busy` (the build works) and `root` (the project root's own checkout) are thrown before the
   *  merge and are the operator's; only `git` (the branch's to fix: commit, resolve) becomes the overseer's reason. */
  cause?: "busy" | "root" | "git";
  // expect (synthetic): what the design says must hold here
  session?: string; // "project" or a gap id
  in?: string[];
  notIn?: string[];
  reasonKinds?: string[];
  noReasonKinds?: string[];
  lookStarted?: boolean;
  // setting
  key?: string;
  value?: unknown;
  src?: string;
  // fact
  entity?: "overseer" | "person" | "gap" | "baton" | "decision" | "build" | "conflict";
  id?: string;
  state?: string;
  status?: string;
  by?: string;
  running?: boolean;
  lastFailed?: boolean;
  merged?: boolean;
  newSinceMerge?: number;
  ownerArea?: boolean | null;
  baton?: string;
  supersededBy?: string;
  /** decision: its spec record's built / not-built (promoted). */
  build?: string | null;
  wrote?: boolean;
  settle?: boolean;
  derived?: string;
  // turn
  attended?: boolean;
  level?: Level | null;
  levelWhy?: string;
  reasons?: { kind: string; soon: boolean }[];
  runAll?: boolean;
  /** The operator's message arrived while a turn ran: it joins that run (one end for both). */
  joins?: boolean;
  // tool
  name?: string;
  verdict?: "ok" | "refused" | "partial" | "error" | "unanswered";
  refusal?: string | null;
  levelAtCall?: Level;
  cap?: { used: number; max: number | null; of?: string };
  args?: { op?: string; id?: string; status?: string; ids?: string[]; baton?: string; build?: string; session?: string };
  link?: { gap: string | null; how: string };
  // turn-end
  stop?: string;
  // obs
  what?: string;
  pending?: string[];
  busy?: boolean;
  lastRun?: { outcome: string; dAt: number; reasons: string[] } | null;
  held?: string[];
}

export interface Trace {
  v: 1;
  id: string;
  source: string;
  t0: string;
  hosts: number;
  sova: { commit: string | null; how: string | null; features: Record<string, boolean | null> };
  events: Step[];
  final: {
    autonomy: Level | null;
    watch: boolean | null;
    caps: Record<string, number | null> | null;
    watchGapMin: number | null;
    /** null: the soon look is Off; absent: the default. */
    soonLookSec?: number | null;
    archived: boolean;
    rosterActive: number;
    gaps: { id: string; status: string; links: number }[];
    batons: { id: string; state: string; owner: string; wrote: boolean }[];
    decisions: { id: string; baton: string; state: string; build: string | null }[];
    builds: { id: string; by: string; merged: boolean }[];
    hosts: { host: string; paused: boolean; lastRun: { outcome: string; reasons: string[] } | null; looks: number; held: string[]; pending: string[] }[];
  };
}

const HERE = dirname(fileURLToPath(import.meta.url));
export const FIXTURES = join(HERE, "fixtures", "org-charts");

/** Tools renamed since a trace was mined, by their old name: the same tool, so the same rule
    (`sova_confirm` became `sova_card`, §app.overseer/confirm). */
const RENAMED_TOOLS: Record<string, string> = { sova_confirm: "sova_card" };

export function loadTraces(dir = FIXTURES): Trace[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => {
      const t = JSON.parse(readFileSync(join(dir, f), "utf8")) as Trace;
      for (const s of t.events) if (s.name && RENAMED_TOOLS[s.name]) s.name = RENAMED_TOOLS[s.name]!;
      return t;
    });
}

// ---- the engine (server/org-charts.ts), as the replay uses it -------------------------------------------

export interface SendResult {
  configuration: string[];
  steps?: { sessionId: string; event: string; before: string[]; after: string[]; outbox: Effect[] }[];
  outbox: Effect[];
  sends?: { from: string; to: string; event: string; data: unknown; delay: number }[];
  invocations?: { sessionId: string; invokeId: string; type: string; op: "start" | "stop"; params?: unknown }[];
  errors?: { level: string; message: string }[];
}
export interface Effect {
  kind: string;
  key?: string;
  sessionId?: string;
  [k: string]: unknown;
}
export interface TrialResult {
  taken: boolean;
  configuration: string[];
  before?: string[];
  outbox?: Effect[];
  refusal?: string | null;
  refused?: unknown[];
  errors?: { level: string; message: string }[];
}
export interface Engine {
  start(sid: string, chart: string, data: unknown, opts?: { now?: number }): SendResult;
  send(sid: string, event: string, data?: unknown, opts?: { now?: number; invokeId?: string }): SendResult;
  trial(sid: string, event: string, data?: unknown, opts?: { now?: number; invokeId?: string }): TrialResult;
  configuration(sid: string): string[] | null;
  data(sid: string): Record<string, unknown> | null;
  nextDueAt(): number | null;
  fireDue(now: number): SendResult;
  dump(sid: string): string | null;
  load(sid: string, text: string): unknown;
  unload?(sid: string): void;
  sessions?(): string[];
}
export interface EngineHooks {
  onInvokeStart?: (inv: { sessionId: string; invokeId: string; type: string; params?: unknown }) => void;
  onInvokeStop?: (inv: { sessionId: string; invokeId: string; type: string }) => void;
  clock?: () => number;
}

/** The engine module and its chart list, or why it cannot be had (the tests say which). */
export async function openEngineModule(): Promise<{ create: (hooks: EngineHooks) => Engine; charts: string[] } | { missing: string }> {
  const path = "./org-charts"; // server/org-charts.ts, owned by the engine teammate
  let mod: Record<string, unknown>;
  try {
    mod = (await import(path)) as Record<string, unknown>;
  } catch (err) {
    return { missing: `server/org-charts.ts: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}` };
  }
  const create = (mod.createOrgCharts ?? mod.createEngine) as ((hooks: EngineHooks) => Engine) | undefined;
  if (typeof create !== "function") return { missing: "server/org-charts.ts exports no createOrgCharts/createEngine" };
  const list = (mod.chartVersions ?? mod.chartList ?? mod.charts) as (() => { name: string }[]) | { name: string }[] | undefined;
  const charts = (typeof list === "function" ? list() : (list ?? [])).map((c) => c.name);
  return { create, charts };
}

// ---- today's rule, the oracle -----------------------------------------------------------------------------

/** What `act()` needs for a call: TOOL_NEEDS, with sova_roster approve/decline at L2 (checked per op). */
export function needOf(name: string, op?: string): Need {
  if (name === "sova_roster" && (op === "approve" || op === "decline")) return "L2";
  return TOOL_NEEDS[name] ?? "operator";
}

export interface Envelope {
  by: "overseer" | "operator" | "system";
  attended: boolean;
  autonomy: Level;
  paused: boolean;
  rosterActive: boolean;
  allowance: Record<Kinds, { used: number; max: number | null }>;
  atOnce: { gatheringsOpen: number; gatheringsCap: number | null; codingRunning: number; codingCap: number | null };
}

/** The level in force (effectiveAutonomy) and today's sentence for this call, or null. */
export function oracle(name: string, op: string | undefined, env: Envelope): string | null {
  const effective: { autonomy: Autonomy; reason?: string } = env.paused
    ? { autonomy: "L0", reason: "Paused at L0: this organization was attached on this host. Set its level to resume." }
    : !env.rosterActive
      ? { autonomy: "L0", reason: "The roster has no active people yet, so the overseer only proposes (L0)." }
      : { autonomy: env.autonomy };
  return autonomyRefusal(name, needOf(name, op), env.attended, effective);
}

// ---- divergences -----------------------------------------------------------------------------------------

export type Cls =
  | "drift" // the trace ran a Sova commit older than the behaviour the chart models
  | "host-check" // a refusal by a host check the chart holds no facts for (validation, per-id, abilities, privacy)
  | "store-shape" // today's stores are the wrong shape for the charts (a missing edge, an undated event): the `why` names the cleaner shape
  | "chart-better" // the chart holds what today dropped or could not see (a reason, a stall, a position)
  | "cannot-express" // real behaviour the chart's model does not have
  | "mining" // the replay's own reconstruction is approximate here (a reconstructed counter)
  | "chart-bug"; // the chart is wrong: reported to `charts`

export interface Divergence {
  trace: string;
  dt: number;
  check: string;
  expected: unknown;
  got: unknown;
  cls: Cls | null;
  why: string;
  /** For chart-better: the concrete step (what today did, what the chart holds). */
  evidence?: Record<string, unknown>;
}

export interface Report {
  trace: string;
  steps: number;
  checks: number;
  passes: number;
  divergences: Divergence[];
  skipped: string[];
  looks: { real: number; chart: number };
  items: Record<string, string[]>;
  /** What the chart was actually asked: trials of real acts, item positions checked, real looks compared. */
  coverage: { trials: number; itemChecks: number; lookChecks: number; expects: number; restarts: number; maxMicrosteps: number };
  /** With a horizon: each item's phase at the trace's end and, the clock run on to the horizon, when it stalled. */
  stalls?: { item: string; endPhase: string[]; stalledAt: number | null; phaseAtHorizon: string[] }[];
}

// ---- the replay ------------------------------------------------------------------------------------------

const KIND_OF: Record<string, Kinds | undefined> = { sova_start_gathering: "gather", sova_offer: "gather", sova_promote: "promote", sova_create_session: "create", sova_send: "prompt" };
const PER_DAY: Record<Kinds, string> = { gather: "gatherPerDay", promote: "promotePerDay", create: "createPerDay", prompt: "promptsPerDay" };
const PER_TURN: Record<Kinds, string> = { gather: "gatherPerTurn", promote: "promotePerTurn", create: "createPerTurn", prompt: "promptsPerTurn" };
/** The cleaner store shapes, named where a divergence comes from today's (operator ruling: no back-compat). */
const PROPOSE = {
  gap: "Proposal: sova_start_gathering/sova_offer take `gap`; the baton row records `gapId` and decisions inherit it through their baton; sova_create_session takes `decisions`, recorded per coding row in started.json.",
  dated: "Proposal: one append-only, dated transition log per project (who did what, when: reconciler runs and who ran them, Run Now clicks, settings changes, run ends), which the charts' step log already is.",
};

/** The chart's atomic states (a configuration's leaves, for messages). */
const LEAVES = new Set(["open", "gather-starting", "asking", "needs-operator", "unreconciled", "conflicted", "drafted", "spec-edited", "awaiting-build", "build-starting", "working", "idle", "failed", "merged", "done", "on-hold", "follow-up-starting", "follow-up-asking", "follow-up-needs-operator", "quiet", "waiting", "due", "held", "running", "paused", "live", "archived", "watch-off", "stalled", "dropped"]);
/** Today's watch ticker (WATCH_TICK_MS in server/project-overseer.ts). */
const TICK_MS = 20e3;
/** A look's prompt lands this long after its tick, at most, in the corpus (acquiring the session). */
const TICK_SLACK = 50;
/** Stamps within this of a real look are the same tick (the memo's and the prompt's clocks). */
const TICK_SAME = 2000;
/** How much earlier than the real look the chart's may start (the 20 s ticker, acquiring the session). */
const LOOK_EARLY = 90e3;
/** The miner's reason kinds (today's sentences) as the chart's `reason/noted` kinds. */
const REASON_KIND: Record<string, string> = {
  "gathering-done": "baton/done",
  "gathering-closed": "baton/closed",
  proposal: "baton/proposal",
  "asked-operator": "baton/asked-operator",
  conflict: "reconcile/conflict",
  resolved: "reconcile/resolved",
  "operator-promoted": "reconcile/promoted",
  promoted: "reconcile/promoted",
  drafted: "reconcile/drafted",
  "turn-ended": "coding/settled",
  "turn-failed": "coding/settled",
  merged: "build/merged",
  "merge-refused": "build/merge-refused",
  "looks-back": "held/looks",
  "allowance-back": "held/day",
  "message-allowance-back": "held/message",
  "limit-raised": "held/raised",
};
/** Each drift reason kind, by the commit that stopped it (checked by the tests: the trace's commit predates it). */
export const DRIFT_COMMIT: Record<string, { commit: string; note?: string }> = {
  "drift:todo-queued": { commit: "77f3cdbf" },
  "drift:idea-added": { commit: "77f3cdbf" },
  "drift:decision-recorded": { commit: "239852ee" },
  // In no commit: the lane ran its worktree at 4adbfb02 with this work uncommitted, and it was committed as
  // 80a785ca (the held message allowance) 78 s after the trace ended, reworded.
  "drift:message-left": {
    commit: "80a785ca",
    note: "an uncommitted draft of 80a785ca's held message-allowance reason (\"The operator's last message reached its limit on …; it may go on within today's allowance.\"): the lane ran its worktree at 4adbfb02 with that work uncommitted, committed as 80a785ca at 19:11:38Z, 78 s after the trace ended; the sentence was reworded before the commit, so no commit carries it",
  },
};
const driftEvidence = (kinds: string[]) => {
  const ds = [...new Set(kinds)].map((k) => DRIFT_COMMIT[k]).filter((d): d is { commit: string; note?: string } => !!d);
  return { commits: [...new Set(ds.map((d) => d.commit))], ...(ds.some((d) => d.note) ? { notes: ds.flatMap((d) => (d.note ? [d.note] : [])) } : {}) };
};

/** Refusals by checks outside the chart's facts: the chart may take the event, and that is not a divergence of its model. */
const HOST_CHECKS = new Set(["validation", "per-id"]);

/** The item phases a projection of the facts allows (several where the chart has a transient). */
export function expectedPhases(it: ItemFacts): string[] {
  if (it.status === "dropped") return ["dropped"];
  if (it.starting && !it.followUp) return ["gather-starting"];
  const b = it.build;
  // A gathering still going: decisions recorded during it wait for its end (the item is still gathering).
  if (it.baton?.state === "open" && !it.followUp && !(it.build && it.decisions.length)) return ["asking"];
  if (it.baton?.state === "needs-you" && !it.followUp && !(it.build && it.decisions.length)) return ["needs-operator"];
  const live = it.decisions.filter((d) => d.state !== "superseded");
  const states = new Set(live.map((d) => d.state));
  const dphase = !live.length ? "none" : states.has("conflict") ? "conflict" : states.has("pending") ? "pending" : states.has("drafted") ? "drafted" : live.some((d) => d.editedInSpec) ? "edited" : "promoted";
  if (dphase === "edited") return ["spec-edited"];
  if (dphase === "promoted" && b) {
    const allBuilt = live.every((d) => d.build === "built");
    if (b.merged && !b.running) return allBuilt ? ["done"] : ["merged"];
    if (b.running) return ["working"];
    return b.lastFailed ? ["failed"] : ["idle"];
  }
  if (dphase === "promoted") return ["awaiting-build", "build-starting"];
  if (dphase === "pending") return ["unreconciled"];
  if (dphase === "conflict") return ["conflicted"];
  if (dphase === "drafted") return ["drafted"];
  const bs = it.baton?.state;
  if (bs === "open") return ["asking"];
  if (bs === "needs-you") return ["needs-operator"];
  return ["open", "gather-starting"];
}

/** The follow-up region's state for these facts. */
export function followUpPhase(it: ItemFacts): string {
  if (!it.followUp) return "no-follow-up";
  if (it.starting) return "follow-up-starting";
  if (it.baton?.state === "open") return "follow-up-asking";
  if (it.baton?.state === "needs-you") return "follow-up-needs-operator";
  return "no-follow-up";
}

export interface ItemFacts {
  status: string;
  baton: { id: string; state: string; own: boolean; wrote: boolean; settle: boolean } | null;
  /** A gathering was started for it and its baton row is not written yet. */
  starting?: boolean;
  /** Its latest gathering started once it was deciding or promoted: a follow-up, beside the lane. */
  followUp?: boolean;
  decisions: { id: string; state: string; authorOwnsArea: boolean; build: string | null; editedInSpec?: boolean }[];
  build: { sessionId: string; running: boolean; lastFailed: boolean; merged: boolean; newSinceMerge: number; startedBy: string; state: string } | null;
}

/** An engine with no charts: the replay then checks the trace against today's rule only. */
const noEngine = (): Engine => {
  const none = (): never => {
    throw new Error("no engine");
  };
  return { start: none, send: none, trial: none, configuration: () => null, data: () => null, nextDueAt: () => null, fireDue: none, dump: () => null, load: none };
};

export async function replay(trace: Trace, create: ((hooks: EngineHooks) => Engine) | null, charts: string[], opts: { horizon?: number } = {}): Promise<Report> {
  const T0 = Date.parse(trace.t0);
  let now = T0;
  const rep: Report = { trace: trace.id, steps: trace.events.length, checks: 0, passes: 0, divergences: [], skipped: [], looks: { real: 0, chart: 0 }, items: {}, coverage: { trials: 0, itemChecks: 0, lookChecks: 0, expects: 0, restarts: 0, maxMicrosteps: 0 } };
  const looksStarted: number[] = [];
  /** The chart's looks: when each started, the reason kinds it carried, and whether a real look matched it. */
  const chartLooks: { at: number; kinds: string[] | null; rows: { kind: string; at: number; item: string | null }[]; matched: boolean }[] = [];
  const hooks: EngineHooks = {
    clock: () => now,
    onInvokeStart: (inv) => {
      if (!inv.type.endsWith("look")) return;
      looksStarted.push(now);
      chartLooks.push({ at: now, kinds: null, rows: [], matched: false });
    },
  };
  /** Reasons the chart kept while the overseer was busy because someone else acted (today drops them: R3). */
  const keptWhileBusy = new Set<string>();
  /** Items where the chart refused a real act as a chart bug: their later positions follow from it. */
  const bugItems = new Set<string>();
  /** Batons started as a follow-up: the item was deciding or promoted when the gathering began. */
  const followUps = new Set<string>();
  /** Decisions ever promoted (a flip back to drafted leaves a build that served them). */
  const everPromoted = new Set<string>();
  /** Promoted decisions seen back at drafted: today notes no one (lane e2e-2 NEW-MS2-1). */
  const flipBacks: { id: string; dt: number; gap: string | null }[] = [];
  /** New decisions on a gap whose decisions were all promoted (a follow-up's): today notes only the gathering. */
  const newOnPromoted: { id: string; dt: number; gap: string }[] = [];
  let busy = false;
  /** Every reason sent to the chart, when. */
  const noted: { kind: string; at: number }[] = [];
  /** Reasons a real look took that the chart's earlier look missed (noted between the two): the chart's next look
      carries them. Kind → when the chart's look started, when the reason was noted after it, and the real look. */
  const carry = new Map<string, { chartLookAt: number; notedAt: number[]; realLookAt: number }>();
  /** Reasons of looks that were stopped or cut off, which the chart put back (R2): kind → when. */
  const requeued = new Map<string, number>();
  /** When facts of each reason family last changed (for classifying a reason the chart lacks). */
  const lastFactOf: Record<string, number> = {};
  let lastReconcileDt = -Infinity;
  let eng = (create ?? noEngine)(hooks);
  const projectBuilt = charts.includes("project");
  const projOn = () => projectBuilt && projectOn;
  const hasItem = charts.includes("work-item");
  if (!projectBuilt) rep.skipped.push("project chart not in the build: watch-loop checks skipped");
  if (!hasItem) rep.skipped.push("work-item chart not in the build: item checks skipped");
  const F = trace.sova.features;

  let curDt = 0;
  const diverge = (check: string, expected: unknown, got: unknown, cls: Cls | null, why: string, evidence?: Record<string, unknown>) => {
    rep.checks++;
    rep.divergences.push({ trace: trace.id, dt: curDt, check, expected, got, cls, why, ...(evidence ? { evidence } : {}) });
  };
  const leaves = (conf: string[]) => conf.filter((x) => LEAVES.has(x)).join("/");
  const pass = () => {
    rep.checks++;
    rep.passes++;
  };

  // ---- the stores, as of now --------------------------------------------------------------------------
  const caps: Record<string, number | null> = { ...(trace.final.caps ?? {}) };
  const syncedCaps = new Set<string>();
  let autonomy: Level = trace.final.autonomy ?? "L1";
  let paused = false;
  const people = new Map<string, string>();
  const gaps = new Map<string, ItemFacts>();
  const batons = new Map<string, { id: string; state: string; own: boolean; wrote: boolean; settle: boolean }>();
  const decisions = new Map<string, { id: string; baton: string; state: string; authorOwnsArea: boolean; build: string | null; supersededBy?: string; editedInSpec?: boolean }>();
  const builds = new Map<string, { sessionId: string; running: boolean; lastFailed: boolean; merged: boolean; newSinceMerge: number; startedBy: string; state: string }>();
  const batonGap = new Map<string, string>();
  const buildGap = new Map<string, string>();
  const finalBuild = new Map(trace.final.decisions.map((d) => [d.id, d.build]));
  const rosterActive = () => (people.size ? [...people.values()].some((s) => s === "active") : trace.final.rosterActive > 0);

  // Allowance ledgers: per operator message (attended) and per local day (unattended).
  let turn: { attended: boolean; by: string; used: Record<Kinds, number>; look: boolean } | null = null;
  /** Before 80a785ca one ledger per operator message, drawn by every run until the next message (attended or not). */
  let legacyMessage: Record<Kinds, number> = { gather: 0, promote: 0, create: 0, prompt: 0 };
  const day = new Map<string, Record<Kinds, number>>();
  const dayKey = () => {
    const d = new Date(now);
    return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
  };
  const zero = (): Record<Kinds, number> => ({ gather: 0, promote: 0, create: 0, prompt: 0 });
  const ledger = () => (turn?.attended ? turn.used : (day.get(dayKey()) ?? (day.set(dayKey(), zero()), day.get(dayKey())!)));
  const envelope = (attended: boolean, by: Envelope["by"] = "overseer"): Envelope => {
    const L = ledger();
    const al = {} as Envelope["allowance"];
    for (const k of ["gather", "promote", "create", "prompt"] as Kinds[]) al[k] = { used: L[k], max: (attended ? caps[PER_TURN[k]] : caps[PER_DAY[k]]) ?? null };
    return {
      by,
      attended,
      autonomy,
      paused,
      rosterActive: rosterActive(),
      allowance: al,
      atOnce: {
        gatheringsOpen: [...batons.values()].filter((b) => b.own && (b.state === "open" || b.state === "needs-you")).length,
        gatheringsCap: caps.gatheringsOpen ?? null,
        codingRunning: [...builds.values()].filter((b) => b.startedBy === "overseer" && b.running).length,
        codingCap: caps.codingRunning ?? null,
      },
    };
  };

  // ---- sessions -------------------------------------------------------------------------------------------
  const PSID = `project/${trace.id}`;
  const itemSid = (g: string) => `item/${trace.id}/${g}`;
  const call = <R>(what: string, f: () => R): R | null => {
    try {
      const r = f();
      // An action or guard that threw inside the chart is never a divergence to explain away.
      const errs = (r as { errors?: { message: string }[] } | null)?.errors ?? [];
      if (errs.length) diverge(`engine:${what}`, "no chart error", errs.map((e) => e.message), null, "an action or guard threw inside the chart");
      for (const l of chartLooks)
        if (l.kinds === null && projOn()) {
          const rows = (eng.data(PSID)?.runReasons as { kind?: string; at?: number; params?: { item?: string } }[] | undefined) ?? [];
          l.kinds = rows.map((x) => String(x.kind));
          l.rows = rows.map((x) => ({ kind: String(x.kind), at: Number(x.at), item: x.params?.item ?? null }));
        }
      for (const st of (r as { steps?: { microsteps?: number }[] } | null)?.steps ?? []) rep.coverage.maxMicrosteps = Math.max(rep.coverage.maxMicrosteps, st.microsteps ?? 0);
      return r;
    } catch (err) {
      diverge(`engine:${what}`, "no throw", err instanceof Error ? err.message : String(err), null, "the engine threw");
      return null;
    }
  };
  let projectOn = false;
  const startProject = () => {
    if (projectOn || !projectBuilt) return;
    projectOn = true;
    call("start project", () =>
      eng.start(PSID, "project", { projectSid: PSID, ...(tickOrigin !== null ? { tickOrigin, tickMs: TICK_MS } : {}), settings: { watch: trace.final.watch ?? true, watchGapMin: trace.final.watchGapMin ?? 10, soonLookSec: F.codingSettledReason === false ? null : trace.final.soonLookSec === undefined ? 60 : trace.final.soonLookSec, unattendedPerDay: caps.unattendedPerDay ?? null, caps }, paused, archived: false, rosterActive: rosterActive() }, { now }),
    );
  };
  // Whether this build has the project's `overseer/act` (item-less tool calls): an attended read is always allowed.
  let hasAct = false;
  if (projectBuilt) {
    const probe = (create ?? noEngine)({ clock: () => now });
    try {
      probe.start("probe", "project", { projectSid: "probe" }, { now });
      const t = probe.trial("probe", "overseer/act", { by: "overseer", attended: true, autonomy: "L0", paused: false, rosterActive: true, tool: "sova_project" }, { now });
      hasAct = t.taken || (t.refused?.length ?? 0) > 0;
    } catch {
      hasAct = false;
    }
    if (!hasAct) rep.skipped.push("overseer/act is not in this build: item-less tool calls get today's rule only");
  }
  // Today's looks start on its 20 s ticker, phased from the server's start: the looks the loop started itself
  // share one phase (a Run Now's does not), so the densest cluster of real look phases is the ticker's.
  const phases = trace.events.filter((e) => e.kind === "turn" && e.by === "watch" && !e.runAll).map((e) => (T0 + e.dt) % TICK_MS);
  const tickOrigin = phases.length ? T0 - (T0 % TICK_MS) + phases.map((p) => [p, phases.filter((q) => Math.abs(q - p) <= 500).length] as const).sort((a, b) => b[1] - a[1] || a[0] - b[0])[0]![0] : null;
  // Whether the chart rounds a look to the tick itself (start data `tickOrigin`): then the host fires timers when due.
  let chartTicks = false;
  /** How long `t` is after the chart's last grid tick (0 on a tick). */
  const sinceTick = (t: number) => (tickOrigin === null ? 0 : (((t - tickOrigin) % TICK_MS) + TICK_MS) % TICK_MS);
  if (projectBuilt) {
    const probe = (create ?? noEngine)({ clock: () => now });
    try {
      probe.start("tick", "project", { projectSid: "tick", tickOrigin: now + 7000, tickMs: TICK_MS, settings: { watchGapMin: 0, soonLookSec: 0 } }, { now });
      const r = probe.send("tick", "reason/noted", { kind: "baton/closed", params: { sessionId: "x", title: "x" } }, { now });
      chartTicks = !(r.configuration ?? []).includes("running");
    } catch {
      chartTicks = false;
    }
  }
  // The project chart starts with the overseer's conversation (noteReason is a no-op before it); older fixtures: at once.
  if (!trace.events.some((e) => e.entity === "overseer")) startProject();
  const ensureItem = (g: string) => {
    if (gaps.has(g)) return;
    gaps.set(g, { status: "open", baton: null, decisions: [], build: null });
    if (hasItem) call("start item", () => eng.start(itemSid(g), "work-item", { itemId: g, projectSid: PSID }, { now }));
  };
  const factsOf = (g: string): ItemFacts => {
    const it = gaps.get(g)!;
    const bid = [...batonGap].filter(([, x]) => x === g).map(([b]) => b).at(-1);
    it.baton = bid ? (batons.get(bid) ?? null) : null;
    // Linked by the call that started it, its baton row not written yet.
    it.starting = !!bid && !batons.has(bid);
    it.followUp = !!bid && followUps.has(bid);
    const bids = new Set([...batonGap].filter(([, x]) => x === g).map(([b]) => b));
    // Its batons' decisions, and (transitively) the winners of those superseded: a winner decided in a
    // settle session answers this gap too (charts' facts contract).
    const ids = new Set([...decisions.values()].filter((d) => bids.has(d.baton)).map((d) => d.id));
    for (let grew = true; grew; ) {
      grew = false;
      for (const id of [...ids]) {
        const w = decisions.get(id)?.supersededBy;
        if (w && decisions.has(w) && !ids.has(w)) ids.add(w), (grew = true);
      }
    }
    it.decisions = [...ids].map((id) => decisions.get(id)!).map((d) => ({ id: d.id, state: d.state, authorOwnsArea: d.authorOwnsArea, build: d.build, editedInSpec: !!d.editedInSpec }));
    const cid = [...buildGap].filter(([, x]) => x === g).map(([c]) => c).at(-1);
    it.build = cid ? (builds.get(cid) ?? null) : null;
    return it;
  };
  /** The gap a decision serves: through its baton, or as the winner of one of that gap's superseded decisions. */
  const gapOfDecision = (id: string): string | null => {
    const d = decisions.get(id);
    const direct = d ? batonGap.get(d.baton) : undefined;
    if (direct) return direct;
    for (const x of decisions.values()) if (x.supersededBy === id) return gapOfDecision(x.id);
    return null;
  };
  const pushFacts = (g: string) => {
    if (!hasItem || !gaps.has(g)) return;
    const f = factsOf(g);
    call("facts", () => eng.send(itemSid(g), "facts/changed", { baton: f.baton, decisions: f.decisions, build: f.build }, { now }));
  };
  /** Reasons of one instant go to the chart as one batch (as one store write notes them before any tick). */
  const instant: Record<string, unknown>[] = [];
  const reason = (kind: string, params: Record<string, unknown>) => {
    if (!projOn()) return;
    if (busy && params.by && params.by !== "overseer") keptWhileBusy.add(kind);
    noted.push({ kind, at: now });
    instant.push({ kind, params, ...(params.by ? { by: params.by } : {}) });
  };
  const sendInstant = () => {
    if (!instant.length || !projOn()) return;
    const reasons = instant.splice(0);
    call(`reasons ${reasons.map((r) => r.kind).join(",")}`, () => eng.send(PSID, "reason/noted", reasons.length === 1 ? reasons[0]! : { reasons }, { now }));
  };
  /** The reconciler's events come one per run with the ids it moved (reconcile.ts emit): batched per instant and actor. */
  const batch = new Map<string, { kind: string; by: string | undefined; ids: string[] }>();
  const batched = (kind: string, id: string, by: string | undefined) => {
    const k = `${kind}|${by ?? ""}`;
    batch.set(k, { kind, by, ids: [...(batch.get(k)?.ids ?? []), id] });
  };
  /** Items whose facts changed in this instant: the store writes of one instant reach the chart as one change. */
  const dirty = new Set<string>();
  const flush = () => {
    const changed = dirty.size > 0;
    for (const g of dirty) pushFacts(g);
    dirty.clear();
    if (changed) checkItems();
    for (const b of batch.values()) reason(b.kind, { n: b.ids.length, ids: b.ids, ...(b.by ? { by: b.by } : {}) });
    batch.clear();
    sendInstant();
  };

  // ---- checks ---------------------------------------------------------------------------------------------
  const checkItems = () => {
    if (!hasItem) return;
    for (const g of gaps.keys()) {
      rep.coverage.itemChecks++;
      const conf = eng.configuration(itemSid(g)) ?? [];
      const facts = factsOf(g);
      const want = expectedPhases(facts);
      // The follow-up region (work-item v3), beside the lane.
      if (conf.some((x) => x.includes("follow-up"))) {
        const fu = followUpPhase(facts);
        if (conf.includes(fu)) pass();
        else diverge("item-follow-up", fu, conf.filter((x) => x.includes("follow-up")), null, "the chart's follow-up region differs from the stores' latest gathering");
      }
      if (want.some((p) => conf.includes(p)) || (want.includes("dropped") && conf.length === 0)) {
        pass();
        continue;
      }
      if (conf.includes("on-hold")) {
        pass();
        continue;
      }
      const it = gaps.get(g)!;
      if (bugItems.has(g)) {
        diverge("item-position", want, conf, "chart-bug", "follows from the chart bug on this item's refused act (reported to charts)");
        continue;
      }
      // A build linked before the item's decisions are promoted: the chart moves on decisions first. Only
      // that case: with its decisions promoted, a chart not following the build is wrong.
      const promotedAll = it.decisions.length > 0 && it.decisions.filter((d) => d.state !== "superseded").every((d) => d.state === "promoted");
      if (it.build && !promotedAll && !conf.includes("building") && !["done", "dropped"].some((p) => want.includes(p)))
        diverge("item-position", want, conf, "cannot-express", it.decisions.some((d) => everPromoted.has(d.id))
          ? "its promoted decisions flipped back to drafted (a reconciler re-run, lane e2e-2 NEW-MS2-1) while their build exists; the item follows its decisions back, and the build shows again once they are re-promoted"
          : "a coding session serves the gap before its decisions are promoted (the operator coded first); the item follows its decisions, and the build shows only once they are promoted",
          { item: g, build: it.build.sessionId, decisions: it.decisions.map((d) => `${d.id}:${d.state}`), everPromoted: it.decisions.filter((d) => everPromoted.has(d.id)).map((d) => d.id) });
      else diverge("item-position", want, conf, null, "the chart's position differs from the projection of the stores' facts");
    }
  };

  /** One chart verdict for a real call: the act on its item, or `overseer/act` on the project. */
  interface Verdict {
    sid: string;
    event: string;
    data: Record<string, unknown>;
    item: string | null;
    taken: boolean;
    refusal: string | null;
    before: string[];
  }

  /** Compare today's rule, the chart's verdict and its sentence with what really happened to one call. */
  const checkTool = (s: Step, vs: Verdict[]): void => {
    const env = envelope(!!s.attended);
    const oracleSays = oracle(s.name!, s.args?.op, env);
    const realAutonomy = s.refusal === "autonomy" || s.refusal === "operator-only";
    // 1. Today's rule against the real verdict: the envelope reconstruction is what this tests.
    if (!!oracleSays === realAutonomy) pass();
    else if (s.name === "sova_todos" && F.mergeReasonAndTodosOperatorOnly === false) diverge("oracle-vs-real", "refused", s.verdict, "drift", "sova_todos became operator-only in 77f3cdbf; this trace ran an older commit", { commits: ["77f3cdbf"] });
    else diverge("oracle-vs-real", oracleSays ? "refused" : "allowed", { verdict: s.verdict, refusal: s.refusal, level: env.autonomy, attended: env.attended, paused: env.paused, roster: env.rosterActive }, null, "the reconstructed envelope (level, attended, pause, roster) disagrees with the real verdict");
    if (!vs.length) return;
    // The turn was cut off before the tool answered: there is no real verdict to compare.
    if (s.verdict === "unanswered") return void rep.skipped.push(`${s.dt}: ${s.name} unanswered (its turn was aborted before the tool returned)`);
    // 2. The chart's verdict against the real one (a partial promote ran: some route must be taken).
    const realOk = s.verdict === "ok" || s.verdict === "partial";
    const chartOk = s.verdict === "partial" ? vs.some((v) => v.taken) : vs.every((v) => v.taken);
    const refused = vs.find((v) => !v.taken) ?? null;
    if (chartOk === realOk) {
      pass();
      // 3. Both refused: the chart's sentence is today's.
      if (!realOk && refused) checkSentence(s, env, refused);
      return;
    }
    if (!chartOk && realOk) {
      const v = refused!;
      const got = { event: v.event, refusal: v.refusal, at: v.before.filter((x) => LEAVES.has(x)) };
      if (s.name === "sova_todos" && F.mergeReasonAndTodosOperatorOnly === false)
        return diverge("chart-vs-real", "taken", got, "drift", "sova_todos became operator-only in 77f3cdbf; this trace ran an older commit", { commits: ["77f3cdbf"] });
      if (v.event === "decision/promote" && v.item && v.before.some((x) => ["gather-starting", "asking", "needs-operator"].includes(x)) && factsOf(v.item).decisions.some((d) => d.state === "drafted")) {
        bugItems.add(v.item);
        return diverge("chart-vs-real", "taken", got, "chart-bug", `drafted decisions promoted while a follow-up gathering on the same gap runs (${got.at.join("/")}): today promotes any drafted decision; the item's single lane holds promotion until the gathering ends`, { act: v.event, at: got.at, drafted: factsOf(v.item).decisions.filter((d) => d.state === "drafted").length });
      }
      if (v.event === "gather/start" && v.before.some((x) => ["awaiting-build", "build-starting", "working", "idle", "failed", "merged", "done", "spec-edited"].includes(x))) {
        if (s.link?.how === "words")
          return diverge("chart-vs-real", "taken", got, "store-shape", `a gathering after this gap's decisions were promoted (${got.at.join("/")}), matched to it only by its words: it may serve another question entirely. ${PROPOSE.gap}`);
        return diverge("chart-vs-real", "taken", got, "cannot-express", `a gathering named for a gap past its decisions (${got.at.join("/")}), e.g. feedback on its build: today gathers at any time; the chart gathers only while the gap is open or deciding`, { act: v.event, at: got.at, link: s.link ?? null });
      }
      if (v.event === "gather/start" && v.before.some((x) => ["asking", "needs-operator", "gather-starting", "unreconciled", "conflicted", "drafted"].includes(x)))
        return diverge("chart-vs-real", "taken", got, "cannot-express", `a second gathering for a gap that already has one (${got.at.join("/")}): today the overseer may follow up or replace a gathering at any time${s.attended ? ", here at the operator's request" : ""}; the chart gathers only from open (gap link ${s.link?.how ?? "?"})`, { act: v.event, at: got.at, link: s.link ?? null });
      if (v.event === "build/start" && s.attended && v.before.some((x) => ["open", "asking", "gather-starting", "unreconciled", "drafted", "conflicted"].includes(x)))
        return diverge("chart-vs-real", "taken", got, "cannot-express", "the operator asked for a build before any decision on the gap was promoted; the chart builds only from promoted decisions", { act: v.event, at: got.at, attended: true });
      if (v.event === "build/start" && !s.attended && v.before.some((x) => ["open", "asking", "gather-starting", "unreconciled", "drafted", "conflicted"].includes(x))) {
        // Only when nothing anywhere was promoted and unbuilt is the order itself what the chart holds; else the
        // build rests on decisions whose gathering carries no gap (the link today's stores lack).
        const unbuilt = [...decisions.values()].filter((d) => d.state === "promoted" && d.build !== "built");
        if (!unbuilt.length) return diverge("chart-vs-real", "taken", got, "chart-better", "an unattended build with no promoted, unbuilt decision anywhere in the project: the chart holds the pipeline order the prompt only asks for", { at: got.at, promotedUnbuilt: 0 });
        return diverge("chart-vs-real", "taken", got, "store-shape", `the build names no gap; ${unbuilt.length} promoted, unbuilt decision(s) exist but their gathering carries no gap, so the words matched an item with none. ${PROPOSE.gap}`);
      }
      diverge("chart-vs-real", "taken", got, null, "the chart refused what really ran");
      return;
    }
    // Real refused, the chart took it.
    if (s.refusal && HOST_CHECKS.has(s.refusal)) return diverge("chart-vs-real", "refused", "taken", "host-check", `real refusal by a host check (${s.refusal}) the chart holds no fact for`);
    if (s.refusal === "budget-legacy") return diverge("chart-vs-real", "refused", "taken", "drift", "the coding token budget was removed in 320042f0", { commits: ["320042f0"] });
    if (s.refusal === "cap-message" && !s.attended && F.allowanceHeld === false)
      return diverge("chart-vs-real", "refused", "taken", "drift", "before 80a785ca an unattended run drew on the operator's per-message allowance (lane r3-R1 bug 3); the chart draws on the day's", { commits: ["80a785ca"] });
    diverge("chart-vs-real", `refused (${s.refusal})`, "taken", null, "the chart took what really was refused");
  };

  /** A refusal both gave: the chart's sentence must be today's (autonomyRefusal, overRefusal, the at-once line). */
  const checkSentence = (s: Step, env: Envelope, v: Verdict) => {
    const said = v.refusal ?? "";
    let want: string | null = null;
    let driftWhy: string | null = null;
    if (s.refusal === "autonomy" || s.refusal === "operator-only") want = oracle(s.name!, s.args?.op, env);
    else if ((s.refusal === "cap-day" || s.refusal === "cap-message") && s.cap?.max != null && KIND_OF[s.name!]) {
      want = overRefusal({ ledger: s.refusal === "cap-day" ? "day" : "message", kind: KIND_OF[s.name!]!, used: s.cap.used, max: s.cap.max }, new Date(now)).said;
      if (F.allowanceHeld === false) driftWhy = "the allowance sentences were rewritten in 80a785ca";
    } else if (s.refusal === "cap-open" && s.cap?.max != null) {
      want = `${s.cap.used} of its ${s.cap.of === "coding" ? "coding sessions are running" : "gathering sessions are open"}, and the limit is ${s.cap.max} at once.`;
      if (F.allowanceHeld === false) driftWhy = "the at-once sentence was rewritten in 80a785ca";
    }
    if (want === null) return; // host checks and per-id refusals: the tool's own words
    if (said.startsWith(want)) return pass();
    diverge("refusal-sentence", want, said, driftWhy ? "drift" : null, driftWhy ?? "the chart refuses with a sentence other than today's", driftWhy ? { commits: ["80a785ca"] } : undefined);
  };

  /** Run one act on the chart speculatively; nothing moves. */
  const trialOn = (sid: string, event: string, data: Record<string, unknown>, item: string | null): Verdict | null => {
    const before = eng.configuration(sid) ?? [];
    const tr = call(`trial ${event}`, () => eng.trial(sid, event, data, { now }));
    if (tr) rep.coverage.trials++;
    return tr ? { sid, event, data, item, taken: tr.taken, refusal: tr.refusal ?? null, before } : null;
  };

  // ---- time ------------------------------------------------------------------------------------------------
  /** The host drives the charts' timers from today's 20 s watch ticker (design §6.3: "fireDue: the 20 s ticker
      calls this"). Its phase is read off each real look (a look starts on a tick); before the first, timers
      fire at their exact due time. */
  let tickPhase: number | null = null;
  const advance = (to: number) => {
    if (!projOn() && !hasItem) return;
    for (let guard = 0; guard < 100000; guard++) {
      const due = eng.nextDueAt();
      if (due === null || due > to) break;
      const at = tickPhase === null || chartTicks ? Math.max(due, now) : nextTick(Math.max(due, now));
      if (at > to) break;
      now = at;
      call("fireDue", () => eng.fireDue(now));
    }
  };
  const nextTick = (t: number) => {
    const k = Math.ceil((t - tickPhase!) / TICK_MS);
    return tickPhase! + k * TICK_MS;
  };

  // ---- looks ----------------------------------------------------------------------------------------------
  /** A real look: a chart look must have started up to LOOK_EARLY before it (the real ticker runs every 20 s,
      and the prompt lands after the session is acquired), carrying the same kinds of reasons. */
  /** Each item/reopened reason a chart look carried, with the store changes on that item at the instant the
      chart noted it (the reason's own `at`): a flip-back or a follow-up's new decision. Scoped to the item and the
      step, so a later unrelated reopen cannot borrow an earlier one's evidence. */
  const reopenedEvidence = (rows: { kind: string; at: number; item: string | null }[]) =>
    rows
      .filter((r) => r.kind === "item/reopened")
      .map((r) => ({
        item: r.item,
        notedAt: r.at - T0,
        flippedBack: flipBacks.filter((f) => f.gap === r.item && T0 + f.dt === r.at).map((f) => f.id),
        newDecisions: newOnPromoted.filter((f) => f.gap === r.item && T0 + f.dt === r.at).map((f) => f.id),
      }));
  const realLook = (s: Step) => {
    rep.coverage.lookChecks++;
    const realKinds = (s.reasons ?? []).map((r) => REASON_KIND[r.kind] ?? r.kind);
    // This look started on a tick, a moment before its prompt was written (acquiring the session): whatever
    // was due by now fires on it.
    tickPhase = now - TICK_SLACK;
    // Today stamps lastRunAt after the prompt is accepted, so a gap measured from it can come due a few ms
    // after this look's own stamp: the same tick.
    for (let guard = 0; guard < 1000; guard++) {
      const due = eng.nextDueAt();
      if (due === null || due > now + TICK_SAME) break;
      now = Math.max(now, due);
      call("fireDue (tick)", () => eng.fireDue(now));
    }
    if (s.runAll) call("run-now", () => eng.send(PSID, "operator/run-now", {}, { now }));
    const match = chartLooks.find((l) => !l.matched && l.at >= now - LOOK_EARLY && l.at <= now);
    if (!match) {
      const conf = eng.configuration(PSID) ?? [];
      const d = eng.data(PSID) ?? {};
      const settings = (d.settings ?? {}) as { watchGapMin?: number };
      const gapDue = (Number(d.lastRunAt ?? 0) || 0) + 60e3 * (settings.watchGapMin ?? 10);
      const dueAt = d.soonAt ? Math.min(Number(d.soonAt), gapDue) : gapDue;
      const pendingKinds = ((d.reasons as { kind?: string }[] | undefined) ?? []).map((r) => String(r.kind));
      const drift = realKinds.length > 0 && realKinds.every((k) => k.startsWith("drift:"));
      const explained = realKinds.filter((k) => k.startsWith("drift:") || pendingKinds.includes(k));
      if (drift) diverge("look-started", "a chart look", conf.filter((x) => LEAVES.has(x)), "drift", `the look's reasons (${realKinds.join(", ")}) are ones only older commits emit`, driftEvidence(realKinds));
      else if (realKinds.length && realKinds.every((k) => k === "held/raised"))
        diverge("look-started", "a chart look", conf.filter((x) => LEAVES.has(x)), "store-shape", `the operator raised a limit (settings PATCH); no store dates that change (overseer.json's history is the workspace's hourly commits), so the replay could not send it. ${PROPOSE.dated}`);
      else if (now + TICK_MS < dueAt && explained.length === realKinds.length && !conf.includes("running"))
        diverge("look-started", "a chart look", { at: conf.filter((x) => LEAVES.has(x)), dueIn: dueAt - now }, "store-shape", `a look before any rule allows one, carrying reasons the chart holds: a Run Now with reasons pending (its prompt lists them, and no store records the click); resynced as one. ${PROPOSE.dated}`);
      else if (conf.includes("running") && realKinds.every((k) => k === "run-now"))
        diverge("look-started", "a chart look", conf.filter((x) => LEAVES.has(x)), "store-shape", `a Run Now while the previous look still runs in the chart: that look's end is missing from its session (cut off) and nothing else records it; resynced. ${PROPOSE.dated}`);
      else if (chartTicks && tickOrigin !== null && dueAt <= now && explained.length === realKinds.length && sinceTick(now) < TICK_MS / 40 && dueAt > now - sinceTick(now))
        diverge("look-started", "a chart look", { at: conf.filter((x) => LEAVES.has(x)), dueAt: dueAt - T0 }, "cannot-express", `today's 20 s ticker drifts (setInterval: this look ran ${sinceTick(now)} ms after the tick grid it started on); the chart's grid is fixed at start, so a look due between the grid tick and the drifted real tick waits one tick more`, { dueAt: dueAt - T0, realLookAt: now - T0, gridTickAt: now - sinceTick(now) - T0, nextGridTickAt: now - sinceTick(now) + TICK_MS - T0 });
      else diverge("look-started", "a chart look", { at: conf.filter((x) => LEAVES.has(x)), reasons: ((d.reasons as { kind?: string }[] | undefined) ?? []).map((r) => r.kind), dueAt }, null, "a real look started where the chart started none");
      // Resync: the look happened; the chart takes it as a Run Now.
      call("resync look", () => eng.send(PSID, "operator/run-now", {}, { now }));
      const l = chartLooks.at(-1);
      if (l && !l.matched && l.at === now) l.matched = true;
      return;
    }
    match.matched = true;
    pass();
    const chartKinds = match.kinds ?? [];
    const tickGap = (k: string) => noted.some((n) => n.kind === k && n.at > match.at && n.at <= now);
    const carried = (k: string) => carry.set(k, { chartLookAt: match.at - T0, notedAt: noted.filter((n) => n.kind === k && n.at > match.at && n.at <= now).map((n) => n.at - T0), realLookAt: now - T0 });
    for (const k of new Set(realKinds)) {
      if (k === "run-now") continue;
      if (chartKinds.includes(k)) {
        pass();
        // Noted again after the chart's look had started: the chart keeps that one for its next look.
        if (tickGap(k)) carried(k);
      } else if (tickGap(k)) {
        carried(k);
        diverge("look-reasons", k, chartKinds, "cannot-express", "today's looks start on its 20 s ticker, so a reason noted after the look was due joins it; the chart looks the moment it is due (its due send has no delay) and takes this reason in its next look", { chartLookAt: match.at - T0, realLookAt: now - T0 });
      }
      else if (k.startsWith("drift:")) diverge("look-reasons", k, chartKinds, "drift", "a reason only older commits emit", driftEvidence([k]));
      else if (k === "baton/proposal") diverge("look-reasons", k, chartKinds, "store-shape", `no store dates a referral, so the replay cannot send it. ${PROPOSE.dated}`);
      else diverge("look-reasons", k, chartKinds, null, "the real look carried a reason the chart's look lacks");
    }
    for (const k of new Set(chartKinds)) {
      if (realKinds.includes(k)) continue;
      if (requeued.has(k)) diverge("look-reasons", `no ${k}`, k, "chart-better", "R2: the look that was to act on this reason was stopped or cut off; today's memo had already cleared it, so it was lost, and the chart put it back", { stoppedAt: requeued.get(k), lookAt: s.dt });
      else if (carry.has(k)) {
        diverge("look-reasons", `no ${k}`, k, "cannot-express", "carried over: the previous real look took this reason on its tick, after the chart's look had started (20 s ticker vs an exact due time)", { ...carry.get(k), nextChartLookAt: match.at - T0, thisRealLookAt: s.dt });
        carry.delete(k);
      } else if (keptWhileBusy.has(k)) diverge("look-reasons", `no ${k}`, k, "chart-better", "a reconciler event by someone else while the overseer was busy: today's memo drops it (R3), the chart keeps it", { chartLookAt: match.at - T0, realLookAt: s.dt });
      else if (k === "item/reopened" && reopenedEvidence(match.rows).every((e) => e.flippedBack.length + e.newDecisions.length > 0))
        diverge("look-reasons", `no ${k}`, k, "chart-better", "a gap whose decisions were promoted went back to deciding: promoted decisions flipped back to drafted (a reconciler re-run, lane e2e-2 NEW-MS2-1; today notes no one) or a follow-up gathering recorded a new decision (today notes only the gathering's end); the chart's item/reopened makes it a reason. The evidence is that item's, at the instant the chart noted each reopen", { reopened: reopenedEvidence(match.rows) });
      else if (k.startsWith("item/")) diverge("look-reasons", `no ${k}`, k, null, "a reason only the chart has, with no evidence found for it in the stores");
      else diverge("look-reasons", `no ${k}`, k, null, "the chart's look carried a reason the real look lacks");
    }
    // What was put back has now been looked at.
    requeued.clear();
  };
  /** Chart looks no real look matched within LOOK_EARLY: classified, then taken as finished. */
  const extraLooks = (end = false) => {
    for (const l of chartLooks) {
      if (l.matched || (!end && now - l.at <= LOOK_EARLY)) continue;
      l.matched = true;
      // A synthetic trace asserts only what its `expect` steps say: a chart look it scripts no real look for
      // just ends (as if it had looked), so the next one can start.
      if (trace.source === "synthetic") {
        if ((eng.configuration(PSID) ?? []).includes("running")) call("look/finished (synthetic)", () => eng.send(PSID, "look/finished", {}, { now, invokeId: "look" }));
        continue;
      }
      const kinds = l.kinds ?? [];
      const own = kinds.filter((k) => keptWhileBusy.has(k));
      if (kinds.length && kinds.every((k) => carry.has(k))) {
        const ev = Object.fromEntries(kinds.map((k) => [k, carry.get(k)]));
        for (const k of kinds) carry.delete(k);
        diverge("chart-look-extra", "no look", kinds, "cannot-express", "a second chart look for reasons the real look took on its 20 s tick after the chart's first look had started", { lookAt: l.at - T0, carried: ev });
      } else if (own.length) diverge("chart-look-extra", "no look", kinds, "chart-better", `the chart looked for ${own.join(", ")}: a reason today's memo dropped while the overseer was busy (R3)`, { lookAt: l.at - T0, keptWhileBusy: own });
      else if (kinds.some((k) => k.startsWith("item/"))) diverge("chart-look-extra", "no look", kinds, "chart-better", "the chart looked for an item's own reason (stall, reopen, answered-nothing, built) today has no reason for", { lookAt: l.at - T0, reasons: l.rows.filter((r) => r.kind.startsWith("item/")).map((r) => ({ ...r, at: r.at - T0 })) });
      else diverge("chart-look-extra", "no look", kinds, null, "the chart started a look where none really started");
      if ((eng.configuration(PSID) ?? []).includes("running")) call("look/finished (extra)", () => eng.send(PSID, "look/finished", {}, { now, invokeId: "look" }));
    }
  };
  /** The operator's Merge Branch: allowed wherever the item follows its build. */
  const mergeClick = (g: string, ok: boolean) => {
    const conf = eng.configuration(itemSid(g)) ?? [];
    if (!conf.includes("building")) {
      if (conf.length === 0 || conf.includes("dropped")) return pass(); // dropped: the item is over; the branch is the operator's
      if (conf.includes("merged") && ok) return pass();
      return diverge("merge-click", "building", conf.filter((x) => LEAVES.has(x)), null, "a Merge Branch on a build the item does not follow");
    }
    const tr = call("trial merge", () => eng.trial(itemSid(g), "build/merge", { by: "operator" }, { now }));
    if (tr) tr.taken === ok ? pass() : diverge("merge-click", ok ? "taken" : "refused", tr.taken ? "taken" : tr.refusal, null, "the chart's Merge Branch guard disagrees with the real outcome");
  };

  // ---- the events -----------------------------------------------------------------------------------------
  for (const s of trace.events) {
    if (s.dt !== curDt || s.kind !== "fact") flush();
    curDt = s.dt;
    const at = T0 + s.dt;
    if (at > now) {
      advance(at);
      now = at;
    }
    if (projOn()) extraLooks();
    if (s.kind === "setting" && s.key === "autonomy") {
      autonomy = s.value as Level;
      paused = false;
      if (projOn()) call("level-set", () => eng.send(PSID, "operator/level-set", { autonomy }, { now }));
      continue;
    }
    if (s.kind === "setting") {
      if (s.key === "caps") Object.assign(caps, s.value as object);
      if (projOn()) call(`setting ${s.key}`, () => eng.send(PSID, "settings/changed", { [s.key!]: s.key === "caps" ? caps : s.value } as Record<string, unknown>, { now }));
      continue;
    }
    if (s.kind === "fact") {
      const fam = { baton: "baton", decision: "reconcile", conflict: "reconcile", build: s.merged ? "build" : "coding" }[s.entity as string];
      if (fam) lastFactOf[fam] = s.dt;
      if (s.entity === "overseer") startProject();
      else if (s.entity === "person") {
        people.set(s.id!, s.status!);
        if (projOn()) call("roster", () => eng.send(PSID, "facts/changed", { rosterActive: rosterActive() }, { now }));
      } else if (s.entity === "gap") ensureItem(s.id!);
      else if (s.entity === "baton") {
        const prev = batons.get(s.id!);
        const b = { id: s.id!, state: s.state!, own: prev?.own ?? s.by === "overseer", wrote: prev?.wrote || !!s.wrote, settle: prev?.settle || !!s.settle };
        batons.set(s.id!, b);
        const g = batonGap.get(s.id!);
        if (g) dirty.add(g);
        if (s.state === "done") reason("baton/done", { sessionId: s.id, title: s.id });
        else if (s.state === "closed") reason("baton/closed", { sessionId: s.id, title: s.id });
        else if (s.state === "needs-you" && b.own && F.askedOperatorReason) reason("baton/asked-operator", { sessionId: s.id, title: s.id, question: "" });
      } else if (s.entity === "decision") {
        const prev = decisions.get(s.id!);
        // A new decision (a follow-up gathering's) on a gap whose decisions were all promoted: it reopens.
        if (!prev && s.baton && batonGap.has(s.baton)) {
          const live = factsOf(batonGap.get(s.baton)!).decisions.filter((d) => d.state !== "superseded");
          if (live.length && live.every((d) => d.state === "promoted")) newOnPromoted.push({ id: s.id!, dt: s.dt, gap: batonGap.get(s.baton)! });
        }
        decisions.set(s.id!, { id: s.id!, baton: s.baton ?? prev?.baton ?? "", state: s.state!, authorOwnsArea: s.ownerArea ?? prev?.authorOwnsArea ?? false, build: s.state === "promoted" ? (s.build ?? finalBuild.get(s.id!) ?? null) : null, supersededBy: s.supersededBy ?? prev?.supersededBy, editedInSpec: s.edited ?? prev?.editedInSpec ?? false });
        if (s.state === "promoted") everPromoted.add(s.id!);
        if (s.state === "drafted" && prev?.state === "promoted") flipBacks.push({ id: s.id!, dt: s.dt, gap: gapOfDecision(s.id!) });
        // Every item holding it (its own, and any whose superseded decision it won) learns of it.
        for (const g of gaps.keys()) if (factsOf(g).decisions.some((d) => d.id === s.id)) dirty.add(g);
        // Who ran the reconcile: the overseer's own sova_reconcile in this minute, else the operator or the auto-run.
        // Today's reconciler reports the records its draft changed: a promoted decision flipped back (lane
        // e2e-2 NEW-MS2-1) changes none and is noted by no one; the item chart's item/reopened is the reason.
        if (s.state === "drafted" && prev?.state !== "drafted" && prev?.state !== "promoted") batched("reconcile/drafted", s.id!, s.by ?? (s.dt - lastReconcileDt < 60e3 ? "overseer" : "operator"));
        if (s.state === "promoted" && prev?.state !== "promoted") batched("reconcile/promoted", s.id!, s.by ?? "operator");
      } else if (s.entity === "conflict") {
        batched(s.state === "resolved" ? "reconcile/resolved" : "reconcile/conflict", s.id!, s.state === "resolved" ? "operator" : s.dt - lastReconcileDt < 60e3 ? "overseer" : "operator");
      } else if (s.entity === "build") {
        const prev = builds.get(s.id!);
        const b = { sessionId: s.id!, running: s.running ?? prev?.running ?? false, lastFailed: s.lastFailed ?? prev?.lastFailed ?? false, merged: s.merged ?? prev?.merged ?? false, newSinceMerge: s.newSinceMerge ?? prev?.newSinceMerge ?? 0, startedBy: s.by ?? prev?.startedBy ?? "operator", state: "open" };
        if (s.newSinceMerge) b.merged = false;
        builds.set(s.id!, b);
        const g = buildGap.get(s.id!);
        if (s.merged && g && hasItem) mergeClick(g, true);
        if (g) dirty.add(g);
        if (s.running === false && b.startedBy === "overseer" && F.codingSettledReason) reason("coding/settled", { sessionId: s.id, title: s.id, failed: !!s.lastFailed });
        if (s.merged && F.mergeReasonAndTodosOperatorOnly) reason("build/merged", { sessionId: s.id, title: s.id, branch: "b", target: "t" });
      }
      continue;
    }
    if (s.kind === "turn") {
      // The operator raised a limit (its reason is the only trace of it): limits synced from refusals go back to
      // the stored value, the only one the settings store keeps.
      if ((s.reasons ?? []).some((r) => r.kind === "limit-raised") && syncedCaps.size) {
        for (const key of syncedCaps) caps[key] = trace.final.caps?.[key] ?? null;
        rep.skipped.push(`${s.dt}: limit raised by the operator (undated setting): ${[...syncedCaps].join(", ")} back to the stored value`);
        syncedCaps.clear();
        if (projOn()) call("setting caps", () => eng.send(PSID, "settings/changed", { caps }, { now }));
      }
      // A message joining a running look keeps it a look: the run ends once, for both.
      const prev = turn as { look: boolean } | null;
      turn = { attended: !!s.attended, by: s.by!, used: zero(), look: s.by === "watch" || (!!s.joins && !!prev?.look) };
      if (s.by === "operator" && !s.joins) legacyMessage = zero();
      if (!s.levelWhy && s.level) autonomy = s.level;
      paused = s.levelWhy === "paused";
      if (s.by === "watch") {
        rep.looks.real++;
        if (projOn()) realLook(s);
      }
      // The session streams (a look too): the host's overseer/busy (EVENTS.md), which today's own-act filter reads.
      busy = true;
      if (projOn()) call("busy", () => eng.send(PSID, "overseer/busy", {}, { now }));
      continue;
    }
    if (s.kind === "turn-end") {
      if (projOn() && turn?.look) {
        if (s.stop !== "stop") for (const k of chartLooks.filter((l) => l.matched).at(-1)?.kinds ?? []) requeued.set(k, s.dt);
        call("look end", () => eng.send(PSID, s.stop === "stop" ? "look/finished" : "look/stopped", { detail: s.stop }, { now, invokeId: "look" }));
      }
      if (projOn()) call("idle", () => eng.send(PSID, "overseer/idle", {}, { now }));
      busy = false;
      turn = null;
      continue;
    }
    if (s.kind === "restart") {
      // The server stops mid-flight: every snapshot is taken as saved, a new engine loads them, and the
      // host sends sova/resumed and fresh facts (design §B.5).
      if (projOn() || hasItem) {
        const saved = (eng.sessions?.() ?? []).map((sid) => [sid, eng.dump(sid)] as const);
        rep.coverage.restarts++;
        // Every session comes back: the restart reloads what was saved, nothing else.
        const started = [...(projOn() ? [PSID] : []), ...(hasItem ? [...gaps.keys()].map(itemSid) : [])];
        const dumped = saved.filter(([, text]) => !!text).map(([sid]) => sid);
        started.every((sid) => dumped.includes(sid)) ? pass() : diverge("restart", started, dumped, null, "a session could not be dumped");
        eng = (create ?? noEngine)(hooks);
        for (const [sid, text] of saved) if (text) call(`load ${sid}`, () => eng.load(sid, text));
        const back = eng.sessions?.() ?? [];
        saved.every(([sid]) => back.includes(sid)) ? pass() : diverge("restart", saved.map(([sid]) => sid), back, null, "a session did not come back from its snapshot");
        if (projOn()) call("resumed", () => eng.send(PSID, "sova/resumed", {}, { now }));
        for (const g of gaps.keys()) pushFacts(g);
      }
      turn = null;
      continue;
    }
    if (s.kind === "operator") {
      if (!projOn() && !hasItem && s.act !== "run-now") continue;
      const g = s.id ? (buildGap.get(s.id) ?? null) : null;
      if (s.act === "run-now") {
        // No conversation yet: today's lookNow refuses ("no conversation yet"), and the chart does not exist.
        if (projOn()) call("run-now", () => eng.send(PSID, "operator/run-now", {}, { now }));
      }
      else if (s.act === "attach") {
        paused = true;
        call("attach", () => eng.send(PSID, "org/attached-here", {}, { now }));
      } else if (s.act === "archive") call("archive", () => eng.send(PSID, "project/archived", {}, { now }));
      else if (s.act === "unarchive") call("unarchive", () => eng.send(PSID, "project/unarchived", {}, { now }));
      else if (s.act === "watch-off" || s.act === "watch-on") call(s.act, () => eng.send(PSID, "settings/changed", { watch: s.act === "watch-on" }, { now }));
      else if (s.act === "limit-raised") {
        Object.assign(caps, s.value as object);
        call("limit-raised", () => eng.send(PSID, "settings/changed", { caps }, { now }));
      } else if ((s.act === "merge" || s.act === "merge-refused") && g && hasItem) {
        // Root and git refusals come from the checkout, which the chart does not see: only busy is its guard's.
        if (s.act === "merge" || s.cause === "busy") mergeClick(g, s.act === "merge");
        if (s.act === "merge-refused" && s.cause === "git") reason("build/merge-refused", { sessionId: s.id, title: s.id, reason: "r" });
        flush();
      } else if (s.act === "reconcile") lastReconcileDt = -Infinity;
      else if ((s.act === "hold" || s.act === "resume" || s.act === "settle-text") && s.gap && hasItem && gaps.has(s.gap)) {
        const event = s.act === "hold" ? "item/hold" : s.act === "resume" ? "item/resume" : "decision/settle-text";
        const data = { ...envelope(true, "operator"), ...(s.act === "settle-text" ? { action: s.value } : {}) };
        const v = trialOn(itemSid(s.gap), event, data, s.gap);
        if (v) (v.taken === (s.ok !== false) ? pass() : diverge(`operator ${s.act}`, s.ok !== false ? "taken" : "refused", v.taken ? "taken" : v.refusal, null, "the chart's guard on the operator's click disagrees with the design"));
        if (v?.taken) call(event, () => eng.send(itemSid(s.gap!), event, data, { now }));
      }
      continue;
    }
    if (s.kind === "expect") {
      rep.coverage.expects++;
      const sid = s.session === "project" || !s.session ? PSID : itemSid(s.session);
      if ((sid === PSID && !projOn()) || (sid !== PSID && !hasItem)) continue;
      const conf = eng.configuration(sid) ?? [];
      for (const st of s.in ?? []) conf.includes(st) ? pass() : diverge(`expect in ${st}`, st, conf, null, "the design's expectation for this edge case");
      for (const st of s.notIn ?? []) !conf.includes(st) ? pass() : diverge(`expect not in ${st}`, `not ${st}`, conf, null, "the design's expectation for this edge case");
      if (s.reasonKinds || s.noReasonKinds) {
        const d = eng.data(sid) ?? {};
        const kinds = [...((d.reasons as { kind?: string }[] | undefined) ?? []), ...((d.runReasons as { kind?: string }[] | undefined) ?? [])].map((r) => r.kind);
        for (const k of s.reasonKinds ?? []) kinds.includes(k) ? pass() : diverge(`expect reason ${k}`, k, kinds, null, "the design's expectation for this edge case");
        for (const k of s.noReasonKinds ?? []) !kinds.includes(k) ? pass() : diverge(`expect no reason ${k}`, `no ${k}`, kinds, null, "the design's expectation for this edge case");
      }
      if (s.lookStarted !== undefined) (looksStarted.length > 0) === s.lookStarted ? pass() : diverge("expect look", s.lookStarted, looksStarted.length, null, "the design's expectation for this edge case");
      continue;
    }
    if (s.kind === "obs" && s.what === "decision" && s.id && decisions.has(s.id) && s.state && decisions.get(s.id)!.state !== s.state && ["promoted", "drafted"].includes(s.state)) {
      // decisions.json keeps a decision's last state only: a promotion later flipped back and promoted again
      // (lane e2e-2 NEW-MS2-1) leaves no fact for the first. The lab's poll saw it: taken as the fact.
      const d = decisions.get(s.id)!;
      diverge("decision-state", s.state, d.state, "mining", `decisions.json keeps only a decision's last state; the lab's poll saw ${s.id} ${s.state} here; synced`);
      decisions.set(s.id, { ...d, state: s.state, build: s.state === "promoted" ? (finalBuild.get(s.id) ?? null) : null });
      if (s.state === "promoted") everPromoted.add(s.id);
      if (s.state === "drafted" && d.state === "promoted") flipBacks.push({ id: s.id, dt: s.dt, gap: gapOfDecision(s.id) });
      for (const g of gaps.keys()) if (factsOf(g).decisions.some((x) => x.id === s.id)) dirty.add(g);
      flush();
      continue;
    }
    if (s.kind === "obs" && s.what === "pending" && projOn()) {
      // The lab monitor's view of today's memo: every reason today noted. One the chart lacks is fed in,
      // after classifying why the chart did not have it.
      // A chart look the real ticker has not caught up with yet still holds its reasons: today's memo shows them pending.
      const ahead = chartLooks.some((l) => !l.matched);
      const d = eng.data(PSID) ?? {};
      const chartKinds = [...((d.reasons as { kind?: string }[] | undefined) ?? []), ...(ahead ? ((d.runReasons as { kind?: string }[] | undefined) ?? []) : [])].map((r) => String(r.kind));
      const count = (xs: string[], k: string) => xs.filter((x) => x === k).length;
      const realKinds = (s.pending ?? []).map((k) => REASON_KIND[k] ?? k).filter((k) => !k.startsWith("drift:"));
      for (const k of new Set(realKinds)) {
        const missing = count(realKinds, k) - count(chartKinds, k);
        if (missing <= 0) {
          pass();
          continue;
        }
        const recent = lastFactOf[k.split("/")[0]!] ?? -Infinity;
        const own = k.startsWith("reconcile/") && k !== "reconcile/promoted";
        if (s.dt - recent > 60e3) diverge("memo-reason", k, chartKinds, "store-shape", `today noted this reason with no store change dated before it (e.g. a reconciler re-run after a merge re-reporting a drafted decision, lane e2e-2 NEW-MS2-1): fed to the chart. ${PROPOSE.dated}`);
        else if (own) diverge("memo-reason", k, chartKinds, "store-shape", `no store records who ran a reconcile: the replay attributed this run to the overseer (its own act, dropped while busy), but today kept it, so it was someone else's; fed to the chart. ${PROPOSE.dated}`);
        else diverge("memo-reason", k, chartKinds, null, "today noted this reason for a fact the chart saw, and the chart has none");
        for (let i = 0; i < missing; i++) reason(k, { n: 1, ids: [`obs${s.dt}-${i}`], sessionId: `obs${s.dt}-${i}`, title: `obs${s.dt}-${i}`, by: "system", failed: false, branch: "b", target: "t", question: "" });
      }
      flush();
      continue;
    }
    if (s.kind === "tool") {
      const name = s.name!;
      const kind = KIND_OF[name];
      if (name === "sova_reconcile" && s.verdict === "ok") lastReconcileDt = s.dt;
      // The count a cap refusal named is checked against the ledger the trace's commit kept: before 80a785ca an
      // unattended run drew on the operator's last message (one ledger per message, every run), since then on
      // the day's (or the message's, attended). Nothing is synced: a count that differs is unexplained.
      if (s.cap && kind && (s.refusal === "cap-day" || s.refusal === "cap-message")) {
        const legacy = s.refusal === "cap-message" && !s.attended && F.allowanceHeld === false;
        const counted = legacy ? legacyMessage[kind] : ledger()[kind];
        if (counted === s.cap.used) pass();
        else diverge("allowance-count", s.cap.used, counted, null, `the ${legacy ? "operator's last message (before 80a785ca, every run drew on it)" : s.refusal === "cap-day" ? "day's" : "message's"} ledger reconstructed from the trace differs from the count the refusal named`, { ledger: legacy ? "message (before 80a785ca)" : s.refusal === "cap-day" ? "day" : "message", counted, named: s.cap.used });
        // The settings store keeps only its last value: the limit in force then is the one the refusal named.
        const key = (s.refusal === "cap-day" ? PER_DAY : PER_TURN)[kind];
        if (s.cap.max != null && caps[key] !== s.cap.max) {
          diverge("allowance-max", s.cap.max, caps[key] ?? null, "mining", `the settings store keeps only its last ${key}; the refusal named the limit in force then; synced`);
          caps[key] = s.cap.max;
          syncedCaps.add(key);
          if (projOn()) call("setting caps", () => eng.send(PSID, "settings/changed", { caps }, { now }));
        }
      }
      if (s.levelAtCall && s.levelAtCall !== autonomy && s.levelWhy === "paused") paused = true;
      const env = envelope(!!s.attended);
      // The tool's own validation runs right after the level (charts' `invalid`): its refusal, when it gave one.
      // A partial promote refused some ids, not the call: those per-id verdicts are the chart's own to give.
      const invalid = s.refusal && HOST_CHECKS.has(s.refusal) && s.verdict !== "partial" ? `host:${s.refusal}` : undefined;
      const base: Record<string, unknown> = { ...env, ...(invalid ? { invalid } : {}) };
      const act = (n?: number): { sid: string; event: string; data: Record<string, unknown>; item: string | null } => ({ sid: PSID, event: "overseer/act", data: { ...base, tool: name, ...(s.args?.op ? { op: s.args.op } : {}), ...(n !== undefined ? { n } : {}) }, item: null });
      const onItem = (g: string | null, event: string, data: Record<string, unknown>) => (g && hasItem && gaps.has(g) ? { sid: itemSid(g), event, data: { ...base, ...data }, item: g } : null);
      // Route the call: the act on the gap it serves, or the project's overseer/act when it names none.
      const routes: { sid: string; event: string; data: Record<string, unknown>; item: string | null }[] = [];
      let unrouted: string | null = null;
      if (name === "sova_idea" && s.args?.op === "add" && s.args.id?.startsWith("§gap/")) ensureItem(s.args.id);
      if (name === "sova_idea" && s.args?.op === "status" && s.args.id?.startsWith("§gap/")) {
        ensureItem(s.args.id);
        routes.push(onItem(s.args.id, "gap/status", { status: s.args.status }) ?? act());
      } else if (name === "sova_start_gathering" || name === "sova_offer") {
        const r = onItem(s.link?.gap ?? null, "gather/start", { to: "p", publicTitle: "t", question: "q", goal: "g" });
        if (!r) unrouted = "gathering";
        routes.push(r ?? act());
      } else if (name === "sova_close_gathering") {
        routes.push(onItem(batonGap.get(s.args?.session ?? "") ?? null, "gather/close", { reason: "r" }) ?? act());
      } else if (name === "sova_create_session") {
        // A build rests on promoted decisions ("with the decisions it rests on"): the one item waiting to be
        // built beats a word match that points at an item with none.
        const waiting = [...gaps.keys()].filter((x) => (eng.configuration(itemSid(x)) ?? []).includes("awaiting-build"));
        const worded = s.link?.gap ?? null;
        const pick = worded && waiting.includes(worded) ? worded : waiting.length === 1 ? waiting[0]! : worded;
        const r = onItem(pick, "build/start", { prompt: "p" });
        if (!r) unrouted = "build";
        routes.push(r ?? act());
      } else if (name === "sova_send") {
        routes.push(onItem(buildGap.get(s.args?.session ?? "") ?? null, "build/prompt", { text: "t" }) ?? act());
      } else if (name === "sova_promote") {
        // An LLM's ids split per item (an id not linked to an item reads "unknown decision" there); the rest on the project.
        const byGap = new Map<string, string[]>();
        const loose: string[] = [];
        for (const id of s.args?.ids ?? []) {
          const gg = gapOfDecision(id);
          if (gg && gaps.has(gg) && hasItem) byGap.set(gg, [...(byGap.get(gg) ?? []), id]);
          else loose.push(id);
        }
        for (const [gg, ids] of byGap) routes.push(onItem(gg, "decision/promote", { ids })!);
        if (loose.length || !byGap.size) routes.push(act(loose.length));
      } else if (name === "sova_reconcile") {
        const deciding = [...gaps.keys()].filter((x) => (eng.configuration(itemSid(x)) ?? []).includes("deciding"));
        routes.push(deciding.length === 1 ? onItem(deciding[0]!, "decision/reconcile", {})! : act());
        if (deciding.length > 1) rep.skipped.push(`${s.dt}: sova_reconcile with ${deciding.length} deciding items checked on the project (one run serves them all)`);
      } else routes.push(act());
      // An allowance refusal holds the item for a later look (today's host.hold → the chart's limit/refused).
      // Held items arrived in 80a785ca: older commits held nothing.
      if ((s.refusal === "cap-day" || s.refusal === "cap-message") && kind && projOn() && s.cap?.max != null && F.allowanceHeld !== false)
        call("limit/refused", () => eng.send(PSID, "limit/refused", { ledger: s.refusal === "cap-day" ? "day" : "message", kind, used: s.cap!.used, max: s.cap!.max }, { now }));
      const vs = projOn() || hasItem ? routes.filter((r) => r.sid !== PSID || (projOn() && hasAct)).map((r) => trialOn(r.sid, r.event, r.data, r.item)).filter((v): v is Verdict => !!v) : [];
      checkTool(s, vs);
      if (unrouted && (s.verdict === "ok" || s.verdict === "partial"))
        diverge("item-route", "a gap", null, "store-shape", `${name} names no gap and none could be inferred from its words: the gap→${unrouted} edge today's stores lack (checked on the project instead). ${PROPOSE.gap}`);
      // Real: it ran, so the chart moves (a refusal moves nothing).
      const ran = s.verdict === "ok" || s.verdict === "partial";
      for (const v of vs) {
        if (!(ran && v.taken)) continue;
        call(v.event, () => eng.send(v.sid, v.event, v.data, { now }));
      }
      const g = vs.find((v) => v.item)?.item ?? null;
      const chartRefused = vs.some((v) => v.item && !v.taken);
      if (s.verdict === "ok" && name === "sova_idea" && s.args?.op === "status" && s.args.id && gaps.has(s.args.id)) gaps.get(s.args.id)!.status = s.args.status!;
      // Links the real call made (the chart's `gap` parameter would carry them); one the chart refused is not made.
      if (s.verdict === "ok" && g && !chartRefused) {
        if (s.args?.baton) {
          const before = factsOf(g);
          if (before.decisions.some((d) => d.state !== "superseded") || before.build) followUps.add(s.args.baton);
          batonGap.set(s.args.baton, g);
        }
        if (s.args?.build) buildGap.set(s.args.build, g);
      }
      if (s.verdict === "ok" && kind && s.refusal == null) {
        const n = kind === "promote" ? (s.args?.ids?.length ?? 1) : 1;
        ledger()[kind] += n;
        legacyMessage[kind] += n;
      }
      checkItems();
      continue;
    }
  }

  flush();
  if (projOn()) extraLooks(true);
  // ---- the end: the stores' last word ------------------------------------------------------------------------
  for (const g of trace.final.gaps) {
    if (!gaps.has(g.id)) continue;
    const it = gaps.get(g.id)!;
    if (it.status !== g.status && (g.status === "done" || g.status === "dropped")) {
      // The operator changed it on the page (the store has no time for it): the last act.
      it.status = g.status;
      if (hasItem) call("final status", () => eng.send(itemSid(g.id), "gap/status", { ...envelope(true, "operator"), status: g.status }, { now }));
    }
  }
  checkItems();
  rep.looks.chart = looksStarted.length;
  if (hasItem) for (const g of gaps.keys()) rep.items[g] = eng.configuration(itemSid(g)) ?? [];
  // Stall probe: the stores stayed as they ended; run the charts' clock on to the horizon (every due timer fires
  // at its time) and note when each item stalled. Only a report: nothing real to compare it with.
  if (opts.horizon && hasItem && opts.horizon > now) {
    const phase = (g: string) => (eng.configuration(itemSid(g)) ?? []).filter((x) => LEAVES.has(x) && x !== "stalled" && x !== "live");
    const stalls = [...gaps.keys()].map((g) => ({ item: g, endPhase: phase(g), stalledAt: null as number | null, phaseAtHorizon: [] as string[] }));
    for (let guard = 0; guard < 100000; guard++) {
      const due = eng.nextDueAt();
      if (due === null || due > opts.horizon) break;
      now = Math.max(due, now);
      call("fireDue (horizon)", () => eng.fireDue(now));
      for (const st of stalls) if (st.stalledAt === null && (eng.configuration(itemSid(st.item)) ?? []).includes("stalled")) st.stalledAt = now - T0;
    }
    for (const st of stalls) st.phaseAtHorizon = phase(st.item);
    rep.stalls = stalls;
  }
  return rep;
}

// ---- report (node --import tsx server/org-charts-replay.ts [out.json]) ------------------------------------------

async function main(out?: string): Promise<void> {
  const opened = await openEngineModule();
  const engine = "missing" in opened ? null : opened;
  const reports: Report[] = [];
  // --horizon <ISO>: run each chart's clock on to then after its trace (the stall probe).
  const hi = process.argv.indexOf("--horizon");
  const horizon = hi > 0 ? Date.parse(process.argv[hi + 1]!) : undefined;
  for (const t of loadTraces()) reports.push(await replay(t, engine?.create ?? null, engine?.charts ?? [], { horizon }));
  const byCls: Record<string, number> = {};
  for (const r of reports) for (const d of r.divergences) byCls[d.cls ?? "UNEXPLAINED"] = (byCls[d.cls ?? "UNEXPLAINED"] ?? 0) + 1;
  const summary = {
    engine: engine ? engine.charts : ("missing" in opened ? opened.missing : null),
    traces: reports.length,
    steps: reports.reduce((a, r) => a + r.steps, 0),
    checks: reports.reduce((a, r) => a + r.checks, 0),
    passes: reports.reduce((a, r) => a + r.passes, 0),
    divergences: byCls,
    reports,
  };
  const text = `${JSON.stringify(summary, null, 1)}\n`;
  if (out) (await import("node:fs")).writeFileSync(out, text);
  else process.stdout.write(text);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) void main(process.argv[2]);
