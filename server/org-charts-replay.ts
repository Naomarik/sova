/**
 * Replays the mined organization traces (server/fixtures/org-charts/*.json: the e2e lanes' real runs,
 * anonymised, and the synthetic edge cases) through a real org host (server/org-host/) running the
 * refit's charts, on a virtual clock, and compares every step with what really happened:
 *
 * - the stores' facts are driven as the charts' own acts and events (a person added or leaving, a
 *   gathering started, a message, hand_to, goal_done, a decision recorded, a reconciler run's results,
 *   a promotion, a build's turns and merge), so every link is the charts' own;
 * - every sova_* tool call the real overseer made is routed to the act it is now (design §7.1: the
 *   gap's item, a session, the reconciler, the project) and trialled under the same envelope (who,
 *   attended, level, allowances), and today's rule (`autonomyRefusal` + `TOOL_NEEDS`) is the oracle
 *   both must agree with;
 * - after every step, each item's configuration is checked against a projection of the stores' facts
 *   written here, independently of the charts;
 * - the watch chart's looks, and the reasons each carried, are checked against the real ones;
 * - a restart closes the host and opens it again from its journal and snapshots.
 *
 * A difference is a divergence. Each is classified with the evidence that explains it (version drift,
 * a host check the charts don't hold, a link the stores don't have, the chart catching what today
 * dropped, an operator ruling), or left unexplained. The tests require zero unexplained divergences.
 * The traces predate holds (q10): the world's hold is 0, so every act goes at once, as it did.
 *
 * Shadow only: nothing here changes Sova's behaviour.
 */

import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { autonomyRefusal, overRefusal, TOOL_NEEDS, type Need } from "./project-overseer-tools";
import { DEFAULT_PO_CAPS, type Autonomy, type ProjectOverseerSettings } from "../shared/project-overseer";
import { OrgHost, type ActResult, type Effect as HostEffect, type InvocationReport, type InvocationRunner } from "./org-host";
import { stampEnvelope } from "./org-stamp";
import type { ActBy, Envelope } from "./org-envelope";

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

export function loadTraces(dir = FIXTURES): Trace[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")) as Trace);
}

// ---- today's rule, the oracle -----------------------------------------------------------------------------

/** What `act()` needs for a call: TOOL_NEEDS, with sova_roster approve/decline at L2 (checked per op). */
export function needOf(name: string, op?: string): Need {
  if (name === "sova_roster" && (op === "approve" || op === "decline")) return "L2";
  return TOOL_NEEDS[name] ?? "operator";
}

export interface OracleEnvelope {
  by: "overseer" | "operator" | "system";
  attended: boolean;
  autonomy: Level;
  paused: boolean;
  rosterActive: boolean;
  allowance: Record<Kinds, { used: number; max: number | null }>;
  atOnce: { gatheringsOpen: number; gatheringsCap: number | null; codingRunning: number; codingCap: number | null };
}

/** The level in force (effectiveAutonomy) and today's sentence for this call, or null. */
export function oracle(name: string, op: string | undefined, env: OracleEnvelope): string | null {
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
  | "ruling" // the operator's rulings changed this on purpose (decisions.md / coverage.md): the evidence names the ruling
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

// ---- the world: one real org host (server/org-host/) with the refit's charts, on a virtual clock ----------

const ORG = "org_replay";
const PROJECT = "prj_replay";
const S = {
  org: `org/${ORG}`,
  project: `project/${ORG}/${PROJECT}`,
  watch: `watch/${ORG}/${PROJECT}`,
  reconciler: `reconciler/${ORG}/${PROJECT}`,
  person: (p: string) => `person/${ORG}/${p}`,
  item: (g: string) => `item/${ORG}/${PROJECT}/${gapIdOf(g)}`,
  baton: (b: string) => `baton/${ORG}/${b}`,
  decision: (d: string) => `decision/${ORG}/${PROJECT}/${d}`,
  build: (c: string) => `build/${ORG}/${PROJECT}/${c}`,
};
/** A fixture's gap (`§gap/g1`) as the item chart's id (`g_g1`). */
export const gapIdOf = (g: string) => `g_${g.replace(/^§gap\//, "").replace(/[^a-zA-Z0-9_-]/g, "_")}`;

/** What the replay keeps of a look the watch invoked: when, the reasons it carried, how to end it. */
interface ChartLook {
  at: number;
  kinds: string[];
  rows: { kind: string; at: number; item: string | null }[];
  matched: boolean;
  report: InvocationReport | null;
}

/** The replay's facts about the world the envelope is stamped from (the settings file, as the trace had it). */
interface Settings {
  autonomy: Level;
  caps: Record<string, number | null>;
  watch: boolean;
  watchGapMin: number;
  soonLookSec: number | null;
}

/** Effect results the charts need to go on: the host's side, in the shape it answers (nothing leaves the world). */
function stubEffect(e: HostEffect, now: number): Record<string, unknown> {
  switch (e.kind) {
    case "read-holder":
      return { local: null, remote: null };
    case "commit":
    case "push":
      return { committed: false, headAt: now, pushFailed: false };
    case "make-worktree":
      return { branch: `sova/${String(e.sessionId ?? "b").slice(-8)}`, base: "main", target: "main" };
    case "merge":
      return { commit: "c0ffee" };
    case "promote": {
      const ids = Array.isArray(e.ids) ? (e.ids as string[]) : [];
      return { promoted: ids, refused: [], commit: "c0ffee", textHashes: Object.fromEntries(ids.map((id) => [id, "h"])) };
    }
    case "settle":
      return { decisions: [] };
    default:
      return {};
  }
}

class World {
  host!: OrgHost;
  looks: ChartLook[] = [];
  /** Reconciler runs waiting for their results (the facts of the instant give them). */
  reconcileRuns: { report: InvocationReport }[] = [];
  private stateDir: string;
  constructor(
    readonly dir: string,
    private readonly clock: () => number,
    private readonly facts: () => { settings: Settings; paused: boolean; rosterActive: boolean; archived: boolean },
  ) {
    this.stateDir = join(dir, "state");
  }

  /** The envelope of an act, from the charts and the trace's settings as they stand. */
  envelope(who: { by: ActBy; attended: boolean; extra?: Record<string, unknown> }): Envelope {
    const f = this.facts();
    const settings = { autonomy: f.settings.autonomy, caps: capsOf(f.settings.caps), holdMin: 0, confirmKinds: [] };
    const e = stampEnvelope(this.host, ORG, PROJECT, { by: who.by, attended: who.attended }, () => settings, settings);
    return { ...e, paused: f.paused, rosterActive: f.rosterActive, archived: f.archived, ...(who.extra ?? {}) };
  }

  async open(): Promise<void> {
    mkdirSync(join(this.dir, "ws", "sessions"), { recursive: true });
    const self = this;
    this.host = await OrgHost.open({
      orgId: ORG,
      workspaceDir: join(this.dir, "ws"),
      stateDir: this.stateDir,
      clock: this.clock,
      durable: false,
      // The traces predate holds (q10): every act goes at once (hold 0), as it did.
      stamp: (_sid, _event, _payload, who) => self.envelope({ by: ((who?.by as ActBy | undefined) ?? "chart") as ActBy, attended: false }),
    });
    const kinds = ["read-holder", "commit", "push", "pause-overseers", "revoke-owner-links", "revoke-person-links", "roster-history", "create-session", "mint-link", "mint-links", "revoke-links", "stop-reply", "baton-entry", "make-worktree", "set-mode", "first-prompt", "worktree-note", "merge", "remove-worktree", "promote", "draft", "route-conflict-of", "restore-text", "settle", "idea-status", "owner-update", "hold/started"];
    for (const k of kinds) this.host.effects.register(k, async (e) => stubEffect(e, this.clock()));
    const look: InvocationRunner = {
      start: (inv, report) => {
        const p = (inv.params ?? {}) as { reasons?: unknown[] };
        const rows = ((this.host.data(S.watch)?.runReasons as { kind?: string; at?: number; params?: { item?: string } }[] | undefined) ?? []).map((r) => ({ kind: String(r.kind), at: Number(r.at), item: r.params?.item ?? null }));
        this.looks.push({ at: this.clock(), kinds: rows.length ? rows.map((r) => r.kind) : (p.reasons ?? []).map(String), rows, matched: false, report });
      },
      stop: () => {},
    };
    const reconcile: InvocationRunner = { start: (_inv, report) => void this.reconcileRuns.push({ report }), stop: () => {} };
    const wrapup: InvocationRunner = { start: (_inv, report) => report("finished", undefined, { applied: 0, refused: [] }), stop: () => {} };
    for (const [type, runner] of [["sova/look", look], ["sova/reconcile", reconcile], ["sova/wrapup", wrapup]] as const) {
      this.host.invocations.register(type, runner);
      this.host.invocations.register(type.replace("sova/", ""), runner);
    }
  }

  async close(): Promise<void> {
    await this.host.close();
  }

  // The host's timer follows real time; the replay's clock is virtual, so it fires the due sends itself.
  private get engine(): { nextDueAt(): number | null } {
    return (this.host as unknown as { engine: { nextDueAt(): number | null } }).engine;
  }
  nextDueAt(): number | null {
    return this.engine.nextDueAt();
  }
  fireDue(): void {
    (this.host as unknown as { fire(): void }).fire();
  }

  configuration(sid: string): string[] {
    return this.host.configuration(sid) ?? [];
  }
  data(sid: string): Record<string, unknown> {
    return this.host.data(sid) ?? {};
  }
  exists(sid: string): boolean {
    return this.host.data(sid) !== null;
  }
}

/** The trace's caps (null = Unlimited) as the settings file keeps them. */
function capsOf(c: Record<string, number | null>): ProjectOverseerSettings["caps"] {
  const out = { ...DEFAULT_PO_CAPS } as Record<string, unknown>;
  for (const [k, v] of Object.entries(c)) if (k in out) out[k] = v === null ? "unlimited" : v;
  return out as unknown as ProjectOverseerSettings["caps"];
}

// ---- the replay ------------------------------------------------------------------------------------------

export async function replay(trace: Trace, opts: { horizon?: number } = {}): Promise<Report> {
  const T0 = Date.parse(trace.t0);
  let now = T0;
  const rep: Report = { trace: trace.id, steps: trace.events.length, checks: 0, passes: 0, divergences: [], skipped: [], looks: { real: 0, chart: 0 }, items: {}, coverage: { trials: 0, itemChecks: 0, lookChecks: 0, expects: 0, restarts: 0, maxMicrosteps: 0 } };
  const F = trace.sova.features;
  let curDt = 0;
  const diverge = (check: string, expected: unknown, got: unknown, cls: Cls | null, why: string, evidence?: Record<string, unknown>) => {
    rep.checks++;
    rep.divergences.push({ trace: trace.id, dt: curDt, check, expected, got, cls, why, ...(evidence ? { evidence } : {}) });
  };
  const pass = () => {
    rep.checks++;
    rep.passes++;
  };
  const leaves = (conf: string[]) => conf.filter((x) => LEAVES.has(x));

  // ---- the stores, as of now --------------------------------------------------------------------------
  const caps: Record<string, number | null> = { ...(trace.final.caps ?? {}) };
  const syncedCaps = new Set<string>();
  let autonomy: Level = trace.final.autonomy ?? "L1";
  let paused = false;
  let archived = false;
  let watchOn = trace.final.watch ?? true;
  const people = new Map<string, string>();
  const gaps = new Map<string, ItemFacts>();
  const batons = new Map<string, { id: string; state: string; own: boolean; wrote: boolean; settle: boolean }>();
  const decisions = new Map<string, { id: string; baton: string; state: string; authorOwnsArea: boolean; build: string | null; supersededBy?: string; editedInSpec?: boolean }>();
  const builds = new Map<string, { sessionId: string; running: boolean; lastFailed: boolean; merged: boolean; newSinceMerge: number; startedBy: string; state: string }>();
  const batonGap = new Map<string, string>();
  const buildGap = new Map<string, string>();
  const finalBuild = new Map(trace.final.decisions.map((d) => [d.id, d.build]));
  const rosterActive = () => (people.size ? [...people.values()].some((s) => s === "active") : trace.final.rosterActive > 0);
  const settings = (): Settings => ({
    autonomy,
    caps,
    watch: watchOn,
    watchGapMin: trace.final.watchGapMin ?? 10,
    soonLookSec: F.codingSettledReason === false ? null : trace.final.soonLookSec === undefined ? 60 : trace.final.soonLookSec,
  });

  // Allowance ledgers: per operator message (attended) and per local day (unattended), as the trace's code kept them.
  let turn: { attended: boolean; by: string; used: Record<Kinds, number>; look: boolean } | null = null;
  let legacyMessage: Record<Kinds, number> = { gather: 0, promote: 0, create: 0, prompt: 0 };
  const day = new Map<string, Record<Kinds, number>>();
  const dayKey = () => {
    const d = new Date(now);
    return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
  };
  const zero = (): Record<Kinds, number> => ({ gather: 0, promote: 0, create: 0, prompt: 0 });
  const ledger = () => (turn?.attended ? turn.used : (day.get(dayKey()) ?? (day.set(dayKey(), zero()), day.get(dayKey())!)));
  const oracleEnvelope = (attended: boolean): OracleEnvelope => {
    const L = ledger();
    const al = {} as OracleEnvelope["allowance"];
    for (const k of ["gather", "promote", "create", "prompt"] as Kinds[]) al[k] = { used: L[k], max: (attended ? caps[PER_TURN[k]] : caps[PER_DAY[k]]) ?? null };
    return {
      by: "overseer",
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

  // ---- the world ---------------------------------------------------------------------------------------------
  const dir = mkdtempSync(join(tmpdir(), `sova-replay-${trace.id}-`));
  const world = new World(dir, () => now, () => ({ settings: settings(), paused, rosterActive: rosterActive(), archived }));
  await world.open();
  /** The envelope of the replay's own act: the operator's click, the model's step, a person's message, the host. */
  const env = (by: ActBy, attended = by === "operator", extra?: Record<string, unknown>) => world.envelope({ by, attended, extra });
  /** The overseer's envelope for a tool call: the trace's own ledger (the one its commit kept) for the allowance. */
  const toolEnvelope = (s: Step, extra?: Record<string, unknown>): Envelope => {
    const e = world.envelope({ by: "overseer", attended: !!s.attended, extra });
    const o = oracleEnvelope(!!s.attended);
    const allowance = Object.fromEntries(Object.entries(o.allowance).map(([k, v]) => [k, { used: v.used, max: v.max === null ? "unlimited" : v.max }]));
    return { ...e, allowance: allowance as Envelope["allowance"] };
  };
  const errorsOf = (r: { errors?: { message: string }[] } | null | undefined) => r?.errors ?? [];
  /** One act or event, stepped for real. An engine throw is never a divergence to explain away. */
  const send = async (what: string, sid: string, event: string, payload: Record<string, unknown>, envelope: Envelope | { by: ActBy }): Promise<ActResult | null> => {
    try {
      const out = await world.host.act(sid, event, payload, envelope as Envelope, { settle: true });
      const r = out.result as { steps?: { microsteps?: number }[]; errors?: { message: string }[] } | null;
      for (const st of r?.steps ?? []) rep.coverage.maxMicrosteps = Math.max(rep.coverage.maxMicrosteps, st.microsteps ?? 0);
      if (errorsOf(r).length) diverge(`engine:${what}`, "no chart error", errorsOf(r).map((e) => e.message), null, "an action or guard threw inside the chart");
      return out;
    } catch (err) {
      diverge(`engine:${what}`, "no throw", err instanceof Error ? err.message : String(err), null, "the engine threw");
      return null;
    }
  };
  /** A host fact (no act): sent as the system. */
  const fact = (what: string, sid: string, event: string, payload: Record<string, unknown> = {}) => (world.exists(sid) ? send(what, sid, event, payload, { by: "system" }) : Promise.resolve(null));
  const start = async (what: string, sid: string, chart: string, data: Record<string, unknown>) => {
    try {
      await world.host.start(sid, chart, data, { by: "operator" });
    } catch (err) {
      diverge(`engine:${what}`, "no throw", err instanceof Error ? err.message : String(err), null, "the engine threw");
    }
  };

  await start("start org", S.org, "org", { id: ORG, name: "Replay", slug: "replay", createdAt: now });
  await send("project/add", S.org, "project/add", { projectId: PROJECT, name: "Replay", root: "/nowhere" }, env("operator"));
  await fact("settings", S.watch, "settings/changed", { settings: { ...settings(), caps: capsOf(caps), holdMin: 0 } });
  await fact("roster", S.watch, "facts/changed", { rosterActive: rosterActive() });
  let overseerOn = false;
  const startOverseer = async () => {
    if (overseerOn) return;
    overseerOn = true;
    await send("overseer/start", S.project, "overseer/start", { conversationId: "o" }, env("operator"));
  };
  // The watch notes reasons once the overseer's conversation exists; older fixtures date none: at once.
  if (!trace.events.some((e) => e.entity === "overseer")) await startOverseer();

  // ---- the item facts projection (independent of the charts) -------------------------------------------------
  const factsOf = (g: string): ItemFacts => {
    const it = gaps.get(g)!;
    const bid = [...batonGap].filter(([, x]) => x === g).map(([b]) => b).at(-1);
    it.baton = bid ? (batons.get(bid) ?? null) : null;
    it.starting = !!bid && !batons.has(bid);
    it.followUp = !!bid && followUps.has(bid);
    const bids = new Set([...batonGap].filter(([, x]) => x === g).map(([b]) => b));
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
  const followUps = new Set<string>();
  const everPromoted = new Set<string>();
  const bugItems = new Set<string>();

  const checkItems = () => {
    for (const g of gaps.keys()) {
      const sid = S.item(g);
      if (!world.exists(sid)) continue;
      rep.coverage.itemChecks++;
      const conf = world.configuration(sid);
      const facts = factsOf(g);
      const want = expectedPhases(facts);
      if (conf.some((x) => x.includes("follow-up"))) {
        const fu = followUpPhase(facts);
        if (conf.includes(fu)) pass();
        else diverge("item-follow-up", fu, conf.filter((x) => x.includes("follow-up")), null, "the chart's follow-up region differs from the stores' latest gathering");
      }
      if (want.some((p) => conf.includes(p)) || (want.includes("dropped") && conf.length === 0) || conf.includes("on-hold")) {
        pass();
        continue;
      }
      if (bugItems.has(g)) {
        diverge("item-position", want, leaves(conf), "chart-bug", "follows from the chart bug on this item's refused act (reported to charts)");
        continue;
      }
      const it = gaps.get(g)!;
      const promotedAll = it.decisions.length > 0 && it.decisions.filter((d) => d.state !== "superseded").every((d) => d.state === "promoted");
      if (it.build && !promotedAll && !["done", "dropped"].some((p) => want.includes(p)))
        diverge("item-position", want, leaves(conf), "cannot-express", it.decisions.some((d) => everPromoted.has(d.id))
          ? "its promoted decisions flipped back to drafted (a reconciler re-run, lane e2e-2 NEW-MS2-1) while their build exists; the item follows its decisions back, and the build shows again once they are re-promoted"
          : "a coding session serves the gap before its decisions are promoted (the operator coded first); the item follows its decisions, and the build shows only once they are promoted",
          { item: g, build: it.build.sessionId, decisions: it.decisions.map((d) => `${d.id}:${d.state}`) });
      else diverge("item-position", want, leaves(conf), null, "the chart's position differs from the projection of the stores' facts");
    }
  };

  // ---- people, batons, decisions and builds, as the stores' facts say -----------------------------------------
  const activePeople = () => [...people].filter(([, s]) => s === "active").map(([id]) => id);
  const ensurePerson = async (id: string, status: string) => {
    const prev = people.get(id);
    people.set(id, status);
    if (!prev) {
      const person = { name: `Person ${id}`, role: "Staff", status, contact: { email: `${id}@example.com` }, ...(status === "proposed" ? { referral: { why: "knows it", referredBy: "operator" } } : {}) };
      await send("person/add", S.org, "person/add", { personId: id, person, namesTaken: [...people.keys()].filter((p) => p !== id).map((p) => `person ${p}`) }, env("operator"));
    } else if (prev !== status) {
      if (prev === "proposed" && status === "active") await send("person/approve", S.person(id), "person/approve", {}, env("operator"));
      else if (prev === "proposed" && status === "left") await send("person/decline", S.person(id), "person/decline", {}, env("operator"));
      else await send("person/edit", S.person(id), "person/edit", { patch: { status } }, env("operator"));
    }
    await fact("roster", S.watch, "facts/changed", { rosterActive: rosterActive() });
  };
  /** The first holder of a gathering the stores show: the operator when nobody on the roster is active. */
  const firstHolder = (offer: boolean): Record<string, unknown> => {
    const act = activePeople();
    if (offer && act.length >= 2) return { targets: act.slice(0, 2), offerId: `off_${act.length}` };
    return act.length ? { to: act[0] } : { to: "operator" };
  };
  const batonStart = (id: string, offer: boolean) => ({ sessionId: id, ...firstHolder(offer), publicTitle: `Title ${id}`, goal: "Find out", question: "What?", briefing: "", messagesMax: 60, mintLink: false });
  const ensureItem = async (g: string, by: ActBy = "overseer") => {
    if (gaps.has(g)) return;
    gaps.set(g, { status: "open", baton: null, decisions: [], build: null });
    if (!world.exists(S.item(g))) await send("gap/file", S.project, "gap/file", { gapId: gapIdOf(g), ideaId: g }, env(by, true));
  };
  const batonFact = async (s: Step) => {
    const id = s.id!;
    const prev = batons.get(id);
    const b = { id, state: s.state!, own: prev?.own ?? s.by === "overseer", wrote: prev?.wrote || !!s.wrote, settle: prev?.settle || !!s.settle };
    batons.set(id, b);
    const sid = S.baton(id);
    if (!world.exists(sid)) await send("baton/start", S.project, "baton/start", batonStart(id, (s as { offer?: boolean }).offer === true), env(b.own ? "overseer" : "operator", true));
    if (!world.exists(sid)) return;
    const d = world.data(sid);
    const holder = typeof d.holder === "string" ? d.holder : null;
    const course = String(d.course ?? "open");
    if (s.wrote && !prev?.wrote) {
      const from = holder && holder !== "operator" ? holder : (((d.offers as { to?: string[] }[] | undefined) ?? []).at(-1)?.to?.[0] ?? holder ?? "operator");
      await send("baton/message", sid, "baton/message", { from, active: true }, env(from === "operator" ? "operator" : "person"));
    }
    if (s.state === prev?.state && prev) return;
    if (s.state === "needs-you" && course === "open" && holder !== "operator")
      await send("baton/hand-to", sid, "baton/hand-to", { target: { id: "operator", name: "Operator", status: "active" }, chosen: true, question: "Over to you", briefing: "" }, env("model"));
    else if (s.state === "open" && d.needsYou === true) await send("baton/message", sid, "baton/message", { from: "operator", active: true }, env("operator"));
    else if (s.state === "done" && course === "open") await send("baton/goal-done", sid, "baton/goal-done", { summary: "Established." }, env("model"));
    else if (s.state === "closed" && course !== "closed") await send("baton/close", sid, "baton/close", {}, env("operator"));
  };
  /** Decision state changes of this instant: one reconciler run reports them (the reconciler's own path). */
  const pendingResults: Record<string, unknown>[] = [];
  const decisionFact = async (s: Step) => {
    const id = s.id!;
    const prev = decisions.get(id);
    const baton = s.baton ?? prev?.baton ?? "";
    decisions.set(id, { id, baton, state: s.state!, authorOwnsArea: s.ownerArea ?? prev?.authorOwnsArea ?? false, build: s.state === "promoted" ? (s.build ?? finalBuild.get(id) ?? null) : null, supersededBy: s.supersededBy ?? prev?.supersededBy, editedInSpec: s.edited ?? prev?.editedInSpec ?? false });
    if (s.state === "promoted") everPromoted.add(id);
    const sid = S.decision(id);
    if (!world.exists(sid)) {
      if (!world.exists(S.baton(baton))) {
        rep.skipped.push(`${s.dt}: decision ${id} of a gathering the charts don't have (${baton || "none"})`);
        return;
      }
      await send("record-decision", S.baton(baton), "baton/record-decision", { decisionId: id, area: "area", areaKey: "area", ownerArea: "none", statement: `Decision ${id}`, quote: "their words", entryId: `e_${id}`, markerId: `m_${id}`, ownerAreas: [] }, env("model"));
    }
    if (!world.exists(sid)) return;
    const conf = world.configuration(sid);
    if (s.state === "promoted") {
      if (!conf.includes("promoted")) await send("promote/done", sid, "promote/done", { textHash: "h", commit: "c0ffee" }, { by: "system" });
      const built = s.build ?? finalBuild.get(id) ?? null;
      if (built || s.edited !== undefined) await fact("spec/facts", sid, "spec/facts", { recordPresent: true, fieldsMatch: true, editedInSpec: !!s.edited, build: built });
    } else if (s.state && s.state !== "pending" && !conf.includes(s.state === "conflict" ? "conflicted" : s.state)) {
      pendingResults.push({ id, state: s.state, ...(s.supersededBy ? { supersededBy: s.supersededBy } : {}), authorOwnsArea: s.ownerArea ?? false });
    }
  };
  const flushResults = async () => {
    if (!pendingResults.length) return;
    const results = pendingResults.splice(0);
    // A run of the project's reconciler: its request (the host's, as the operator's click or the auto-run), its results.
    await send("reconcile/request", S.reconciler, "reconcile/request", { delayMs: 0, by: "operator" }, env("operator"));
    const run = world.reconcileRuns.shift();
    if (run) {
      run.report("finished", undefined, { decisions: results, conflicts: [], resolved: [], compared: results.length, draftedIds: results.filter((r) => r.state === "drafted").map((r) => r.id) });
      await settleWorld();
    } else for (const r of results) await fact("reconcile/result", S.decision(String(r.id)), "reconcile/result", r);
  };
  const buildFact = async (s: Step) => {
    const id = s.id!;
    const prev = builds.get(id);
    const b = { sessionId: id, running: s.running ?? prev?.running ?? false, lastFailed: s.lastFailed ?? prev?.lastFailed ?? false, merged: s.merged ?? prev?.merged ?? false, newSinceMerge: s.newSinceMerge ?? prev?.newSinceMerge ?? 0, startedBy: s.by ?? prev?.startedBy ?? "operator", state: "open" };
    if (s.newSinceMerge) b.merged = false;
    builds.set(id, b);
    const sid = S.build(id);
    if (!world.exists(sid)) await send("build/start", S.project, "build/start", { sessionId: id, title: `Build ${id}`, prompt: "Build it" }, env(b.startedBy === "overseer" ? "overseer" : "operator", true));
    if (!world.exists(sid)) return;
    if (s.running === true && !prev?.running) await fact("turn/started", sid, "turn/started");
    if (s.running === false && prev?.running) await fact("turn/ended", sid, "turn/ended", { failed: !!s.lastFailed });
    if (s.merged && !prev?.merged) await send("build/merge", sid, "build/merge", {}, env("operator"));
    if (s.newSinceMerge) await fact("git/probe", sid, "git/probe", { newSinceMerge: s.newSinceMerge });
  };
  /** Let every effect and invocation report of the last steps land. */
  const settleWorld = async () => {
    for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
  };

  // ---- tools: the chart's verdict on each real call ----------------------------------------------------------
  interface Verdict {
    sid: string;
    event: string;
    payload: Record<string, unknown>;
    envelope: Envelope;
    item: string | null;
    taken: boolean;
    refusal: string | null;
    before: string[];
  }
  const trialOn = (sid: string, event: string, payload: Record<string, unknown>, envelope: Envelope, item: string | null): Verdict | null => {
    if (!world.exists(sid)) return null;
    const before = world.configuration(sid);
    try {
      const tr = world.host.trial(sid, event, payload, envelope);
      rep.coverage.trials++;
      return { sid, event, payload, envelope, item, taken: tr.taken, refusal: tr.refusal?.sentence ?? null, before };
    } catch (err) {
      diverge(`engine:trial ${event}`, "no throw", err instanceof Error ? err.message : String(err), null, "the engine threw");
      return null;
    }
  };
  const checkSentence = (s: Step, o: OracleEnvelope, v: Verdict) => {
    const said = v.refusal ?? "";
    let want: string | null = null;
    let driftWhy: string | null = null;
    if (s.refusal === "autonomy" || s.refusal === "operator-only") want = oracle(s.name!, s.args?.op, o);
    else if ((s.refusal === "cap-day" || s.refusal === "cap-message") && s.cap?.max != null && KIND_OF[s.name!]) {
      want = overRefusal({ ledger: s.refusal === "cap-day" ? "day" : "message", kind: KIND_OF[s.name!]!, used: s.cap.used, max: s.cap.max }, new Date(now)).said;
      if (F.allowanceHeld === false) driftWhy = "the allowance sentences were rewritten in 80a785ca";
    } else if (s.refusal === "cap-open" && s.cap?.max != null) {
      want = `${s.cap.used} of its ${s.cap.of === "coding" ? "coding sessions are running" : "gathering sessions are open"}, and the limit is ${s.cap.max} at once.`;
      if (F.allowanceHeld === false) driftWhy = "the at-once sentence was rewritten in 80a785ca";
    }
    if (want === null) return;
    if (said.startsWith(want)) return pass();
    diverge("refusal-sentence", want, said, driftWhy ? "drift" : null, driftWhy ?? "the chart refuses with a sentence other than today's", driftWhy ? { commits: ["80a785ca"] } : undefined);
  };
  const checkTool = (s: Step, vs: Verdict[]): void => {
    const o = oracleEnvelope(!!s.attended);
    const oracleSays = oracle(s.name!, s.args?.op, o);
    const realAutonomy = s.refusal === "autonomy" || s.refusal === "operator-only";
    if (!!oracleSays === realAutonomy) pass();
    else if (s.name === "sova_todos" && F.mergeReasonAndTodosOperatorOnly === false) diverge("oracle-vs-real", "refused", s.verdict, "drift", "sova_todos became operator-only in 77f3cdbf; this trace ran an older commit", { commits: ["77f3cdbf"] });
    else diverge("oracle-vs-real", oracleSays ? "refused" : "allowed", { verdict: s.verdict, refusal: s.refusal, level: o.autonomy, attended: o.attended, paused: o.paused, roster: o.rosterActive }, null, "the reconstructed envelope (level, attended, pause, roster) disagrees with the real verdict");
    if (!vs.length) return;
    if (s.verdict === "unanswered") return void rep.skipped.push(`${s.dt}: ${s.name} unanswered (its turn was aborted before the tool returned)`);
    const realOk = s.verdict === "ok" || s.verdict === "partial";
    const chartOk = s.verdict === "partial" ? vs.some((v) => v.taken) : vs.every((v) => v.taken);
    const refused = vs.find((v) => !v.taken) ?? null;
    if (chartOk === realOk) {
      pass();
      if (!realOk && refused) checkSentence(s, o, refused);
      return;
    }
    if (!chartOk && realOk) {
      const v = refused!;
      const got = { event: v.event, refusal: v.refusal, at: leaves(v.before) };
      if (s.name === "sova_todos" && F.mergeReasonAndTodosOperatorOnly === false)
        return diverge("chart-vs-real", "taken", got, "drift", "sova_todos became operator-only in 77f3cdbf; this trace ran an older commit", { commits: ["77f3cdbf"] });
      // q7: an unlinked build starts only in a turn the operator started; today's unattended ones needed no gap.
      if (v.event === "build/start" && v.sid === S.project && !s.attended)
        return diverge("chart-vs-real", "taken", got, "ruling", "q7: nothing is built that no one agreed on; an unattended build names its gap (C20), and this call named none", { ruling: "q7", act: v.event, attended: false });
      if (v.event === "gather/start" && v.before.some((x) => ["awaiting-build", "build-starting", "working", "idle", "failed", "merged", "done", "spec-edited"].includes(x)))
        return diverge("chart-vs-real", "taken", got, "cannot-express", `a gathering named for a gap past its decisions (${got.at.join("/")}): today gathers at any time; the chart gathers only while the gap is open or deciding`, { act: v.event, at: got.at, link: s.link ?? null });
      if (v.event === "gather/start" && v.before.some((x) => ["asking", "needs-operator", "gather-starting", "unreconciled", "conflicted", "drafted"].includes(x)))
        return diverge("chart-vs-real", "taken", got, "cannot-express", `a second gathering for a gap that already has one (${got.at.join("/")}): the chart gathers from open, or as a follow-up`, { act: v.event, at: got.at, link: s.link ?? null });
      if (v.event === "build/start" && v.item && v.before.some((x) => ["open", "asking", "gather-starting", "unreconciled", "drafted", "conflicted"].includes(x)))
        return diverge("chart-vs-real", "taken", got, s.attended ? "cannot-express" : "chart-better", s.attended ? "the operator asked for a build before any decision on the gap was promoted; the chart builds only from promoted decisions" : "an unattended build before the gap's decisions were promoted: the chart holds the pipeline order the prompt only asks for", { act: v.event, at: got.at, attended: !!s.attended });
      diverge("chart-vs-real", "taken", got, null, "the chart refused what really ran");
      return;
    }
    if (s.refusal && HOST_CHECKS.has(s.refusal)) return diverge("chart-vs-real", "refused", "taken", "host-check", `real refusal by a host check (${s.refusal}) the chart holds no fact for`);
    if (s.refusal === "budget-legacy") return diverge("chart-vs-real", "refused", "taken", "drift", "the coding token budget was removed in 320042f0", { commits: ["320042f0"] });
    if (s.refusal === "cap-message" && !s.attended && F.allowanceHeld === false)
      return diverge("chart-vs-real", "refused", "taken", "drift", "before 80a785ca an unattended run drew on the operator's per-message allowance (lane r3-R1 bug 3); the chart draws on the day's", { commits: ["80a785ca"] });
    diverge("chart-vs-real", `refused (${s.refusal})`, "taken", null, "the chart took what really was refused");
  };

  /** A tool call as the chart act it is (design §7.1): on the gap's item, a session, the reconciler, or the project. */
  const routeTool = async (s: Step): Promise<{ sid: string; event: string; payload: Record<string, unknown>; item: string | null }[]> => {
    const name = s.name!;
    const g = s.link?.gap ?? null;
    const item = g && gaps.has(g) ? g : null;
    if (name === "sova_idea" && s.args?.op === "add" && s.args.id?.startsWith("§gap/")) {
      if (s.verdict === "ok") await ensureItem(s.args.id);
      return [];
    }
    if (name === "sova_idea" && s.args?.op === "status" && s.args.id?.startsWith("§gap/") && s.args.status === "dropped" && gaps.has(s.args.id))
      return [{ sid: S.item(s.args.id), event: "gap/drop", payload: { fromIdea: true }, item: s.args.id }];
    if (name === "sova_start_gathering" || name === "sova_offer") {
      const payload = batonStart(s.args?.baton ?? `b_${s.dt}`, name === "sova_offer");
      return [item ? { sid: S.item(item), event: "gather/start", payload, item } : { sid: S.project, event: "baton/start", payload: { ...payload, gap: "none" }, item: null }];
    }
    if (name === "sova_close_gathering" && s.args?.session) return [{ sid: S.baton(s.args.session), event: "baton/close", payload: { reason: "stale", ownerProject: PROJECT }, item: batonGap.get(s.args.session) ?? null }];
    if (name === "sova_create_session") {
      const waiting = [...gaps.keys()].filter((x) => world.configuration(S.item(x)).includes("awaiting-build"));
      const pick = item && waiting.includes(item) ? item : waiting.length === 1 ? waiting[0]! : item;
      const payload = { sessionId: s.args?.build ?? `c_${s.dt}`, title: "Build", prompt: "Build it" };
      return [pick ? { sid: S.item(pick), event: "build/start", payload, item: pick } : { sid: S.project, event: "build/start", payload: { ...payload, gap: "none" }, item: null }];
    }
    if (name === "sova_send" && (s.args?.session || s.args?.build)) {
      const id = s.args.build ?? s.args.session!;
      return world.exists(S.build(id)) ? [{ sid: S.build(id), event: "build/prompt", payload: { text: "Go on" }, item: buildGap.get(id) ?? null }] : [];
    }
    if (name === "sova_promote") return [{ sid: S.reconciler, event: "decision/promote", payload: { ids: (s.args?.ids ?? []).filter((id) => world.exists(S.decision(id))) }, item: null }];
    if (name === "sova_reconcile") return [{ sid: S.reconciler, event: "reconcile/request", payload: { delayMs: 0, by: "overseer" }, item: null }];
    if (name === "sova_roster" && (s.args?.op === "approve" || s.args?.op === "decline") && s.args.id) return [{ sid: S.person(s.args.id), event: `person/${s.args.op}`, payload: {}, item: null }];
    if (name === "sova_owner_update") return [{ sid: S.project, event: "owner-update/post", payload: { text: "An update." }, item: null }];
    return [];
  };

  // ---- time -----------------------------------------------------------------------------------------------
  const advance = async (to: number) => {
    for (let guard = 0; guard < 100000; guard++) {
      const due = world.nextDueAt();
      if (due === null || due > to) break;
      now = Math.max(due, now);
      try {
        world.fireDue();
      } catch (err) {
        diverge("engine:fireDue", "no throw", err instanceof Error ? err.message : String(err), null, "the engine threw");
        break;
      }
      await settleWorld();
    }
  };

  // ---- looks ---------------------------------------------------------------------------------------------------
  const realLook = async (s: Step) => {
    rep.coverage.lookChecks++;
    const realKinds = (s.reasons ?? []).map((r) => REASON_KIND[r.kind] ?? r.kind);
    if (s.runAll) await send("run-now", S.watch, "operator/run-now", {}, env("operator"));
    const match = world.looks.find((l) => !l.matched && l.at >= now - LOOK_EARLY && l.at <= now);
    if (!match) {
      const d = world.data(S.watch);
      const pendingKinds = ((d.reasons as { kind?: string }[] | undefined) ?? []).map((r) => String(r.kind));
      const conf = world.configuration(S.watch);
      const drift = realKinds.length > 0 && realKinds.every((k) => k.startsWith("drift:"));
      const explained = realKinds.filter((k) => k.startsWith("drift:") || pendingKinds.includes(k));
      if (drift) diverge("look-started", "a chart look", leaves(conf), "drift", `the look's reasons (${realKinds.join(", ")}) are ones only older commits emit`, driftEvidence(realKinds));
      else if (realKinds.length && realKinds.every((k) => k === "held/raised"))
        diverge("look-started", "a chart look", leaves(conf), "store-shape", `the operator raised a limit (settings PATCH); no store dates that change, so the replay could not send it. ${PROPOSE.dated}`);
      else if (explained.length === realKinds.length && pendingKinds.length && !conf.includes("running"))
        diverge("look-started", "a chart look", { at: leaves(conf), reasons: pendingKinds }, "store-shape", `a look before any rule allows one, carrying reasons the chart holds: a Run Now with reasons pending (no store records the click); resynced as one. ${PROPOSE.dated}`);
      else if (conf.includes("running") && realKinds.every((k) => k === "run-now"))
        diverge("look-started", "a chart look", leaves(conf), "store-shape", `a Run Now while the previous look still runs in the chart: that look's end is missing from its session (cut off); resynced. ${PROPOSE.dated}`);
      else diverge("look-started", "a chart look", { at: leaves(conf), reasons: pendingKinds }, null, "a real look started where the chart started none");
      // Resync: the look happened; the chart takes it as a Run Now.
      if (!world.configuration(S.watch).includes("running")) await send("resync look", S.watch, "operator/run-now", {}, env("operator"));
      const l = world.looks.at(-1);
      if (l && !l.matched) l.matched = true;
      return;
    }
    match.matched = true;
    pass();
    for (const k of new Set(realKinds)) {
      if (k === "run-now") continue;
      if (match.kinds.includes(k)) pass();
      else if (k.startsWith("drift:")) diverge("look-reasons", k, match.kinds, "drift", "a reason only older commits emit", driftEvidence([k]));
      else if (k === "baton/proposal") diverge("look-reasons", k, match.kinds, "store-shape", `no store dates a referral, so the replay cannot send it. ${PROPOSE.dated}`);
      else diverge("look-reasons", k, match.kinds, null, "the real look carried a reason the chart's look lacks");
    }
    for (const k of new Set(match.kinds)) {
      if (realKinds.includes(k)) continue;
      if (k.startsWith("item/")) diverge("look-reasons", `no ${k}`, k, "chart-better", "an item's own reason (stall, reopen, answered-nothing, built) today has no reason for", { lookAt: match.at - T0, reasons: match.rows.filter((r) => r.kind === k).map((r) => ({ ...r, at: r.at - T0 })) });
      else diverge("look-reasons", `no ${k}`, k, null, "the chart's look carried a reason the real look lacks");
    }
  };
  const endLook = async (l: ChartLook, stop: string) => {
    l.report?.(stop === "stop" ? "finished" : "stopped", stop === "stop" ? undefined : stop);
    l.report = null;
    await settleWorld();
  };
  /** Chart looks no real look matched: taken as finished, and classified. */
  const extraLooks = async (end = false) => {
    for (const l of world.looks) {
      if (l.matched || (!end && now - l.at <= LOOK_EARLY)) continue;
      l.matched = true;
      if (trace.source !== "synthetic") {
        if (l.kinds.some((k) => k.startsWith("item/"))) diverge("chart-look-extra", "no look", l.kinds, "chart-better", "the chart looked for an item's own reason (stall, reopen, answered-nothing, built) today has no reason for", { lookAt: l.at - T0 });
        else diverge("chart-look-extra", "no look", l.kinds, null, "the chart started a look where none really started");
      }
      await endLook(l, "stop");
    }
  };

  // ---- the events -----------------------------------------------------------------------------------------
  const instantEnd = async () => {
    await flushResults();
    await settleWorld();
  };
  for (const s of trace.events) {
    if (s.dt !== curDt) await instantEnd();
    curDt = s.dt;
    const at = T0 + s.dt;
    if (at > now) {
      await advance(at);
      now = at;
    }
    await extraLooks();
    if (s.kind === "setting") {
      if (s.key === "autonomy") {
        autonomy = s.value as Level;
        paused = false;
        await send("level-set", S.watch, "operator/level-set", { autonomy }, env("operator"));
      } else {
        if (s.key === "caps") Object.assign(caps, s.value as object);
        if (s.key === "watch") watchOn = s.value !== false;
        await fact(`setting ${s.key}`, S.watch, "settings/changed", { settings: { ...settings(), caps: capsOf(caps), holdMin: 0 } });
      }
      continue;
    }
    if (s.kind === "fact") {
      if (s.entity === "overseer") await startOverseer();
      else if (s.entity === "person") await ensurePerson(s.id!, s.status!);
      else if (s.entity === "gap") {
        await ensureItem(s.id!, "operator");
        if (s.status === "dropped" && world.exists(S.item(s.id!)) && !world.configuration(S.item(s.id!)).includes("dropped")) await send("gap/drop", S.item(s.id!), "gap/drop", {}, env("operator"));
        if (s.status) gaps.get(s.id!)!.status = s.status;
      } else if (s.entity === "baton") await batonFact(s);
      else if (s.entity === "decision") await decisionFact(s);
      else if (s.entity === "build") await buildFact(s);
      // conflict facts: their decisions' `conflict` results carry them.
      await settleWorld();
      checkItems();
      continue;
    }
    if (s.kind === "turn") {
      const prev = turn as { look: boolean } | null;
      turn = { attended: !!s.attended, by: s.by!, used: zero(), look: s.by === "watch" || (!!s.joins && !!prev?.look) };
      if (s.by === "operator" && !s.joins) legacyMessage = zero();
      if (!s.levelWhy && s.level) autonomy = s.level;
      paused = s.levelWhy === "paused";
      if (s.by === "watch") {
        rep.looks.real++;
        await realLook(s);
      }
      await fact("turn/started", S.watch, "turn/started", { look: s.by === "watch" });
      if (s.attended) await fact("turn/user-entered", S.watch, "turn/user-entered");
      continue;
    }
    if (s.kind === "turn-end") {
      if (turn?.look) {
        const l = world.looks.filter((x) => x.matched && x.report).at(-1);
        if (l) await endLook(l, s.stop ?? "stop");
      }
      await fact("turn/ended", S.watch, "turn/ended");
      turn = null;
      continue;
    }
    if (s.kind === "restart") {
      rep.coverage.restarts++;
      const before = world.host.sessions().map((x) => x.id).sort();
      await world.close();
      world.looks = world.looks.filter((l) => l.matched);
      world.reconcileRuns = [];
      await world.open();
      await settleWorld();
      const after = world.host.sessions().map((x) => x.id).sort();
      before.every((sid) => after.includes(sid)) ? pass() : diverge("restart", before, after, null, "a session did not come back from its snapshot");
      turn = null;
      continue;
    }
    if (s.kind === "operator") {
      const g = s.id ? (buildGap.get(s.id) ?? null) : null;
      if (s.act === "run-now") {
        if (overseerOn) await send("run-now", S.watch, "operator/run-now", {}, env("operator"));
      } else if (s.act === "attach") {
        paused = true;
        await fact("attach", S.watch, "org/attached-here");
      } else if (s.act === "archive" || s.act === "unarchive") {
        archived = s.act === "archive";
        await send(s.act, S.project, `project/${s.act}`, {}, env("operator", true, { blockers: { gatherings: [], coding: [], overseerWorking: false } }));
      } else if (s.act === "watch-off" || s.act === "watch-on") {
        watchOn = s.act === "watch-on";
        await fact(s.act, S.watch, "settings/changed", { settings: { ...settings(), caps: capsOf(caps), holdMin: 0 } });
      } else if (s.act === "limit-raised") {
        Object.assign(caps, s.value as object);
        await fact("limit-raised", S.watch, "settings/changed", { settings: { ...settings(), caps: capsOf(caps), holdMin: 0 } });
      } else if ((s.act === "merge" || s.act === "merge-refused") && s.id && world.exists(S.build(s.id))) {
        const v = trialOn(S.build(s.id), "build/merge", {}, env("operator"), g);
        if (v && (s.act === "merge" || s.cause === "busy")) v.taken === (s.act === "merge") ? pass() : diverge("merge-click", s.act === "merge" ? "taken" : "refused", v.taken ? "taken" : v.refusal, null, "the chart's Merge Branch guard disagrees with the real outcome");
      } else if (s.act === "reconcile") await send("reconcile", S.reconciler, "reconcile/request", { delayMs: 0, by: "operator" }, env("operator"));
      else if ((s.act === "hold" || s.act === "resume" || s.act === "settle-text") && s.gap && gaps.has(s.gap)) {
        const sid = S.item(s.gap);
        const event = s.act === "hold" ? "item/hold" : s.act === "resume" ? "item/resume" : "decision/settle-text";
        const target = s.act === "settle-text" ? (factsOf(s.gap).decisions.find((d) => d.editedInSpec)?.id ?? null) : null;
        const on = target ? S.decision(target) : sid;
        const payload = s.act === "settle-text" ? { action: s.value, textHash: "h" } : {};
        const v = trialOn(on, event, payload, env("operator"), s.gap);
        if (v) v.taken === (s.ok !== false) ? pass() : diverge(`operator ${s.act}`, s.ok !== false ? "taken" : "refused", v.taken ? "taken" : v.refusal, null, "the chart's guard on the operator's click disagrees with the design");
        if (v?.taken) await send(event, on, event, payload, env("operator"));
      }
      await settleWorld();
      checkItems();
      continue;
    }
    if (s.kind === "expect") {
      await instantEnd();
      rep.coverage.expects++;
      const sid = s.session === "project" || !s.session ? S.watch : S.item(s.session);
      const conf = world.configuration(sid);
      for (const st of s.in ?? []) conf.includes(st) ? pass() : diverge(`expect in ${st}`, st, conf, null, "the design's expectation for this edge case");
      for (const st of s.notIn ?? []) !conf.includes(st) ? pass() : diverge(`expect not in ${st}`, `not ${st}`, conf, null, "the design's expectation for this edge case");
      if (s.reasonKinds || s.noReasonKinds) {
        const d = world.data(sid);
        const kinds = [...((d.reasons as { kind?: string }[] | undefined) ?? []), ...((d.runReasons as { kind?: string }[] | undefined) ?? [])].map((r) => r.kind);
        for (const k of s.reasonKinds ?? []) kinds.includes(k) ? pass() : diverge(`expect reason ${k}`, k, kinds, null, "the design's expectation for this edge case");
        for (const k of s.noReasonKinds ?? []) !kinds.includes(k) ? pass() : diverge(`expect no reason ${k}`, `no ${k}`, kinds, null, "the design's expectation for this edge case");
      }
      if (s.lookStarted !== undefined) (world.looks.length > 0) === s.lookStarted ? pass() : diverge("expect look", s.lookStarted, world.looks.length, null, "the design's expectation for this edge case");
      continue;
    }
    if (s.kind === "obs" && s.what === "pending" && overseerOn) {
      // Today's memo (the lab's view): every reason today noted. One the chart lacks is classified, then fed in.
      const ahead = world.looks.some((l) => !l.matched);
      const d = world.data(S.watch);
      const chartKinds = [...((d.reasons as { kind?: string }[] | undefined) ?? []), ...(ahead ? ((d.runReasons as { kind?: string }[] | undefined) ?? []) : [])].map((r) => String(r.kind));
      const count = (xs: string[], k: string) => xs.filter((x) => x === k).length;
      const realKinds = (s.pending ?? []).map((k) => REASON_KIND[k] ?? k).filter((k) => !k.startsWith("drift:"));
      for (const k of new Set(realKinds)) {
        const missing = count(realKinds, k) - count(chartKinds, k);
        if (missing <= 0) {
          pass();
          continue;
        }
        diverge("memo-reason", k, chartKinds, null, "today noted this reason and the chart has none");
        for (let i = 0; i < missing; i++) await fact("memo reason", S.watch, "reason/noted", { kind: k, params: { sessionId: `obs${s.dt}-${i}`, title: `obs${s.dt}-${i}`, n: 1 }, key: `${k}:obs${s.dt}-${i}`, by: "system" });
      }
      continue;
    }
    if (s.kind === "tool") {
      const name = s.name!;
      const kind = KIND_OF[name];
      if (s.cap && kind && (s.refusal === "cap-day" || s.refusal === "cap-message")) {
        const legacy = s.refusal === "cap-message" && !s.attended && F.allowanceHeld === false;
        const counted = legacy ? legacyMessage[kind] : ledger()[kind];
        if (counted === s.cap.used) pass();
        else diverge("allowance-count", s.cap.used, counted, null, "the ledger reconstructed from the trace differs from the count the refusal named", { counted, named: s.cap.used });
        const key = (s.refusal === "cap-day" ? PER_DAY : PER_TURN)[kind];
        if (s.cap.max != null && caps[key] !== s.cap.max) {
          diverge("allowance-max", s.cap.max, caps[key] ?? null, "mining", `the settings store keeps only its last ${key}; the refusal named the limit in force then; synced`);
          caps[key] = s.cap.max;
          syncedCaps.add(key);
          await fact("setting caps", S.watch, "settings/changed", { settings: { ...settings(), caps: capsOf(caps), holdMin: 0 } });
        }
      }
      if (s.levelAtCall && s.levelAtCall !== autonomy && s.levelWhy === "paused") paused = true;
      const invalid = s.refusal && HOST_CHECKS.has(s.refusal) && s.verdict !== "partial" ? `host:${s.refusal}` : undefined;
      const routes = await routeTool(s);
      const vs = routes.map((r) => trialOn(r.sid, r.event, r.payload, toolEnvelope(s, invalid ? { invalid } : undefined), r.item)).filter((v): v is Verdict => !!v);
      checkTool(s, vs);
      const ran = s.verdict === "ok" || s.verdict === "partial";
      for (const v of vs) if (ran && v.taken) await send(v.event, v.sid, v.event, v.payload, v.envelope);
      const g = vs.find((v) => v.item)?.item ?? null;
      if (s.verdict === "ok" && g && vs.every((v) => v.taken)) {
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
      await settleWorld();
      checkItems();
      continue;
    }
  }

  await instantEnd();
  await extraLooks(true);
  checkItems();
  rep.looks.chart = world.looks.length;
  for (const g of gaps.keys()) rep.items[g] = world.configuration(S.item(g));
  if (opts.horizon && opts.horizon > now) {
    const phase = (g: string) => world.configuration(S.item(g)).filter((x) => LEAVES.has(x) && x !== "stalled" && x !== "live");
    const stalls = [...gaps.keys()].map((g) => ({ item: g, endPhase: phase(g), stalledAt: null as number | null, phaseAtHorizon: [] as string[] }));
    for (let guard = 0; guard < 100000; guard++) {
      const due = world.nextDueAt();
      if (due === null || due > opts.horizon) break;
      now = Math.max(due, now);
      world.fireDue();
      for (const st of stalls) if (st.stalledAt === null && world.configuration(S.item(st.item)).includes("stalled")) st.stalledAt = now - T0;
    }
    for (const st of stalls) st.phaseAtHorizon = phase(st.item);
    rep.stalls = stalls;
  }
  await world.close();
  rmSync(dir, { recursive: true, force: true });
  return rep;
}

// ---- report (node --import tsx server/org-charts-replay.ts [out.json]) ------------------------------------------

async function main(out?: string): Promise<void> {
  const reports: Report[] = [];
  const hi = process.argv.indexOf("--horizon");
  const horizon = hi > 0 ? Date.parse(process.argv[hi + 1]!) : undefined;
  for (const t of loadTraces()) reports.push(await replay(t, { horizon }));
  const byCls: Record<string, number> = {};
  for (const r of reports) for (const d of r.divergences) byCls[d.cls ?? "UNEXPLAINED"] = (byCls[d.cls ?? "UNEXPLAINED"] ?? 0) + 1;
  const summary = {
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
