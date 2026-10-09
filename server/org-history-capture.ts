import type {
  ActorBundle,
  ActorRef,
  Authorization,
  DecisionBody,
  EntityRef,
  EvidenceRef,
  HistoryInput,
  HistoryKind,
  HistoryOutcome,
  HistoryRationale,
  PolicyAt,
  RelationType,
  Trigger,
  Unknown,
} from "../shared/org-history";
import { ORG_STEPS } from "../shared/org-history";
import type { ComposeContext, Effect } from "./org-host";
import type { InvocationRecord, Step } from "./statecharts";

/**
 * The org's capture adapters: what one committed engine call says happened,
 * as history inputs. Pure and synchronous: the org host calls it inside its commit, so the events join the
 * same journal as the statechart change. It reads only the steps the engine
 * returned (each step's data is its payload merged with the envelope the host stamped) and the call's own
 * invocations and effects; it never reads a transcript, a file or the history itself.
 *
 * Links are set when they are made, never inferred: every trigger below names a
 * handle the engine itself put on the step (a hold's id on its re-delivered act, an effect's key on its
 * answer, a look's run id on the act made in it, a decision id an act declared for the decision it starts, the
 * spawner the engine names on a settle gathering whose conflict's start declared that session).
 * Two steps sharing a call, a time or a session are never linked for that. The other relations come from ids
 * the step itself carries: the session an act was addressed to (its gap, gathering, build, decision or
 * conflict: `named-target`, a decision `recorded-in` its gathering), the decisions a promotion asked for and
 * the ones it promoted (`adopts`), the decisions a build's start data names and the gap item its act names,
 * the two decisions a conflict's start data names as its sides, the preview a send's link or a gathering's
 * start names (the preview its answer made, by id), and the decision a superseded one's statechart names. A relation is never a cause; one whose event was recorded before capture started is
 * kept as a reference to its entity.
 *
 * Privacy: an input's structural fields carry ids, kinds and outcomes only. A statechart's sentence, a held
 * act's `what`, a reason someone wrote and the words of a decision go in `rationale`, read only by
 * the history's readers; a quote, a prompt, a message, a contact value and a link never go anywhere here.
 */

export const ADAPTER = ORG_STEPS.adapter;
export const ADAPTER_VERSION = ORG_STEPS.version;

/** What a caller knew about its act that the engine doesn't (record_decision's quote check, sova_decide's
    words, a recovery's real author). It applies to the call's own act only. */
export interface Provenance {
  actors?: Partial<ActorBundle>;
  triggeredBy?: Trigger[];
  parentKeys?: HistoryInput["parentKeys"];
  relationKeys?: HistoryInput["relationKeys"];
  evidence?: EvidenceRef[];
  rationale?: HistoryInput["rationale"];
  decision?: DecisionBody;
  /** Replaces the kind's own outcome (a decision's disposition). */
  outcome?: HistoryOutcome;
  /** Replaces the step's source key (a decision's `decision:<id>`, so a recovery and the call converge). */
  sourceKey?: string;
}

/** The host's compose context (server/org-host ComposeContext); tests give only what they need. */
export type CaptureContext = Pick<ComposeContext, "orgId" | "journalId"> &
  Partial<Omit<ComposeContext, "orgId" | "journalId" | "provenance" | "invocations" | "outbox" | "onProblem">> & {
    invocations?: readonly InvocationRecord[];
    outbox?: readonly Effect[];
    provenance?: Provenance;
    onProblem?: (why: string) => void;
  };

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);
const unknown = (why: string): Unknown => ({ unknown: true, why });

// ---- actors -------------------------------------------------------------------------------------------------

const LEVELS = ["L0", "L1", "L2", "L3"];

/** The level in force as the envelope gives its parts: paused is L0, a lower ceiling caps the setting. */
export function inForceOf(d: Record<string, unknown>): string | undefined {
  const chosen = str(d.autonomy);
  if (d.paused === true) return "L0";
  const ceiling = isObj(d.ceiling) ? str(d.ceiling.autonomy) : undefined;
  if (chosen && ceiling && LEVELS.indexOf(ceiling) >= 0 && LEVELS.indexOf(ceiling) < LEVELS.indexOf(chosen)) return ceiling;
  return chosen;
}

/** The policy the act was evaluated under, from its own envelope (never the chain's). */
export function policyOf(d: Record<string, unknown>): PolicyAt | undefined {
  if (typeof d.attended !== "boolean" && !str(d.autonomy)) return undefined;
  const released = str(d["sova/released"]);
  return {
    attended: d.attended === true,
    ...(str(d.autonomy) ? { autonomy: str(d.autonomy) } : {}),
    ...(inForceOf(d) ? { inForce: inForceOf(d) } : {}),
    ...(typeof d.paused === "boolean" ? { paused: d.paused } : {}),
    ...(released ? { hold: released } : {}),
    ...(cardRef(d) ? { card: cardRef(d) } : {}),
  };
}

/** The confirm card an act rests on. A card has no id of its own: it is named by the targets the operator
    confirmed (ids only), which is what the engine checked the act against. */
function cardRef(d: Record<string, unknown>): string | undefined {
  if (!isObj(d.card)) return undefined;
  const ids = (k: string) => (Array.isArray((d.card as Record<string, unknown>)[k]) ? ((d.card as Record<string, unknown>)[k] as unknown[]).filter((x) => typeof x === "string").join(",") : "");
  return `card:people=${ids("people")};projects=${ids("projects")};sessions=${ids("sessions")}`;
}

/**
 * The five actor facts of a step as its envelope recorded them. Each is what the
 * runtime knew: an unattended overseer act was decided by the overseer, never the operator, whatever
 * started the look it ran in; who started a chain shows through its trigger, not by copying an initiator.
 */
export function actorsOf(step: Pick<Step, "by" | "data" | "sessionId">, projectId: string | null): ActorBundle {
  const d = (step.data ?? {}) as Record<string, unknown>;
  const by = str(d.by) ?? step.by ?? undefined;
  const engine: ActorRef = { kind: "sova" };
  const released = str(d["sova/released"]);
  const level = inForceOf(d);
  switch (by) {
    case "operator": {
      if (d.via !== "overseer") return { initiatedBy: { kind: "operator" }, decidedBy: { kind: "operator" }, recordedBy: engine, executedBy: engine, authorization: { kind: "operator-act", attended: true } };
      // The global Overseer acting in the operator's turn decided the act. A confirm card the operator clicked
      // is the authorization it rests on, never their choice of this act: a card binds only its targets
      // (people, projects, sessions), not the verb, so an act on a confirmed target is still the Overseer's.
      const go: ActorRef = { kind: "global-overseer", ...(str(d.overseerId) ? { id: str(d.overseerId) } : {}) };
      const card = cardRef(d);
      return {
        initiatedBy: { kind: "operator" },
        decidedBy: go,
        recordedBy: go,
        executedBy: engine,
        authorization: card ? { kind: "confirm-card", attended: true, ref: card } : { kind: "attended-turn", attended: true },
      };
    }
    case "overseer": {
      const po: ActorRef = { kind: "project-overseer", ...(projectId ? { id: projectId } : {}), ...(str(d.overseerId) ? { session: str(d.overseerId) } : {}) };
      const attended = d.attended === true;
      const authorization: Authorization = released
        ? { kind: "hold-release", ref: released, attended: false, ...(level ? { level } : {}) }
        : attended
          ? { kind: "attended-turn", attended: true, ...(level ? { level } : {}) }
          : { kind: "autonomy-level", attended: false, ...(level ? { level } : {}) };
      return {
        // An attended turn is the operator's message; an unattended act's start is its trigger (the look).
        initiatedBy: attended && !released ? { kind: "operator" } : unknown("Started by its trigger."),
        decidedBy: po,
        recordedBy: po,
        executedBy: engine,
        authorization,
      };
    }
    case "statechart":
      return {
        initiatedBy: unknown("Started by its trigger."),
        decidedBy: { kind: "statechart" },
        recordedBy: engine,
        executedBy: engine,
        authorization: released ? { kind: "hold-release", ref: released, attended: false, ...(level ? { level } : {}) } : { kind: "autonomy-level", attended: false, ...(level ? { level } : {}) },
      };
    case "model":
      return {
        initiatedBy: unknown("The gathering's turn."),
        decidedBy: { kind: "model" },
        recordedBy: { kind: "model" },
        executedBy: engine,
        authorization: { kind: "none" },
      };
    case "person": {
      const pid = str(d.from) ?? str(d.personId);
      const person: ActorRef = { kind: "person", ...(pid ? { id: pid } : {}) };
      return { initiatedBy: person, decidedBy: person, recordedBy: engine, executedBy: engine, authorization: { kind: "person-decision" } };
    }
    case "wrapup":
    case "sova":
    case "system":
      return { initiatedBy: { kind: "sova" }, decidedBy: { kind: "sova" }, recordedBy: engine, executedBy: engine, authorization: { kind: "none" } };
    default:
      return { initiatedBy: unknown("Not recorded."), decidedBy: unknown("Not recorded."), recordedBy: engine, executedBy: engine, authorization: unknown("Not recorded.") };
  }
}

// ---- the matrix -----------------------------------------------------------------------------------------------

/** What a row may read of the call besides its own step: the call's steps (a session the act started is
    found by the id it declared, never by scanning for one) and the org. */
interface Call {
  steps: readonly Step[];
  orgId: string;
}

type Pick1 = (step: Step, d: Record<string, unknown>, call: Call) => { entities?: EntityRef[]; aliases?: string[]; relationKeys?: NonNullable<HistoryInput["relationKeys"]>; rationale?: HistoryInput["rationale"] } | void;

interface ActRow {
  kind: HistoryKind;
  outcome: HistoryOutcome;
  /** Statecharts the event is taken from (the session id's first segment); absent: any. */
  on?: string[];
  /** Kept only when this holds (a status that moved, an authority field that changed). */
  when?: (step: Step, d: Record<string, unknown>, call: Call) => boolean;
  pick?: Pick1;
}

/** The start step of `sid` in this call (the spawn the act declared), if it is there. */
const startOf = (call: Call, sid: string): Step | undefined => call.steps.find((x) => x.event === "sova/started" && x.sessionId === sid);

/** A relation to the event a key names, kept as `entity` when that event isn't in this history. */
const toKey = (type: RelationType, key: string, entity: EntityRef): NonNullable<HistoryInput["relationKeys"]>[number] => ({ key, type, optional: true, entity });

/** An act's session id field (`sessionId`): the session as an entity. */
const session = (field: string): Pick1 => (_s, d) => {
  const id = str(d[field]);
  return id ? { entities: [{ type: "session", id }] } : undefined;
};

/** An act that starts a gathering (`baton/<org>/<sessionId>`): its start, by the session it declared, and the
    preview it asks about when its act names one (`preview`, by id: `named-target` its `preview.made`). */
const startsGathering: Pick1 = (s, d, call) => {
  const id = str(d.sessionId);
  if (!id) return undefined;
  const sid = `baton/${call.orgId}/${id}`;
  const pv = str(d.preview);
  return {
    entities: [{ type: "session", id }, ...(pv ? [{ type: "preview" as const, id: pv }] : [])],
    ...(startOf(call, sid) ? { aliases: [`sc:${sid}`] } : {}),
    ...(pv ? { relationKeys: [toKey("named-target", `preview:${pv}`, { type: "preview", id: pv })] } : {}),
  };
};

/** An act that starts a coding session (`build/<project>/<sessionId>`): its start, the decisions its build
    statechart was started with (`named-target`), from that start's own data, and the gap a project build was
    started from when its act names that gap's item (`gapItem`, the caller's: an idea's build the gap's own
    statechart wouldn't take). */
const startsBuild: Pick1 = (s, d, call) => {
  const id = str(d.sessionId);
  const p = projectOfStep(s);
  if (!id || !p) return id ? { entities: [{ type: "session", id }] } : undefined;
  const sid = `build/${p}/${id}`;
  const started = startOf(call, sid);
  const decided = started && Array.isArray((started.data as Record<string, unknown> | undefined)?.decisions) ? ((started.data as Record<string, unknown>).decisions as unknown[]).map(str).filter((x): x is string => !!x) : [];
  const gap = str(d.gapItem)?.startsWith("item/") ? ownTarget(str(d.gapItem)!) : undefined;
  const relationKeys = [...(gap ? [toKey("named-target", gap.key, gap.entity)] : []), ...decided.map((did) => toKey("named-target", `decision:${did}`, { type: "decision", id: did }))];
  return {
    entities: [{ type: "session", id }],
    ...(started ? { aliases: [`sc:${sid}`] } : {}),
    ...(relationKeys.length ? { relationKeys } : {}),
  };
};

/** The decisions an act names in `ids` (a promotion's request), as `named-target`. */
const namesDecisions: Pick1 = (_s, d) => {
  const ids = Array.isArray(d.ids) ? d.ids.map(str).filter((x): x is string => !!x) : [];
  return ids.length ? { relationKeys: [...new Set(ids)].map((did) => toKey("named-target", `decision:${did}`, { type: "decision", id: did })) } : undefined;
};

const STATUSES = ["proposed", "active", "left"];
/** A person's status as the step moved it (`changed.status`), when it moved between known statuses. */
const statusMove = (s: Step): string | undefined => {
  const c = s.changed?.status;
  if (!Array.isArray(c)) return undefined;
  const [from, to] = c;
  return typeof to === "string" && STATUSES.includes(to) && from !== to ? to : undefined;
};
const lastPart = (sid: string): string => sid.slice(sid.lastIndexOf("/") + 1);

/**
 * The start of the session an act was addressed to, for the sessions whose start is an event here: its gap
 * (an item), its gathering (a baton), its coding session (a build), its decision or its conflict. Read from
 * the step's own session id; never another session's.
 */
function ownTarget(sid: string): { key: string; entity: EntityRef } | undefined {
  const chart = sid.split("/")[0];
  const last = lastPart(sid);
  if (!last) return undefined;
  switch (chart) {
    case "item":
      return { key: `gap:${last}`, entity: { type: "gap", id: last } };
    case "baton":
      return { key: `sc:${sid}`, entity: { type: "gathering", id: last } };
    case "build":
      return { key: `sc:${sid}`, entity: { type: "build", id: last } };
    case "decision":
      return { key: `decision:${last}`, entity: { type: "decision", id: last } };
    case "conflict":
      return { key: `conflict:${sid}`, entity: { type: "conflict", id: last } };
    default:
      return undefined;
  }
}

/** The acts captured when taken (the matrix). Their refusals and holds are
    captured for every act with an actor (`act.refused`, `hold.created`). */
export const ACTS: Record<string, ActRow> = {
  "operator/run-now": { kind: "request.made", outcome: "started", on: ["watch"] },
  "gap/file": {
    kind: "gap.filed",
    outcome: "recorded",
    on: ["placement"],
    pick: (_s, d) => (str(d.gapId) ? { entities: [{ type: "gap", id: str(d.gapId)! }], aliases: [`gap:${str(d.gapId)}`] } : undefined),
  },
  "gather/plan": { kind: "gap.planned", outcome: "recorded", on: ["item"], pick: session("sessionId") },
  "gap/drop": { kind: "gap.closed", outcome: "done", on: ["item"] },
  "baton/start": { kind: "gathering.started", outcome: "started", on: ["placement"], pick: startsGathering },
  "gather/start": { kind: "gathering.started", outcome: "started", on: ["item"], pick: startsGathering },
  "baton/hand-to": { kind: "gathering.handed-off", outcome: "done", on: ["baton"] },
  "baton/handoff": { kind: "gathering.handed-off", outcome: "done", on: ["baton"] },
  // the operator's Take Back: a hand-off from the holder to the operator
  "baton/take-back": { kind: "gathering.handed-off", outcome: "done", on: ["baton"] },
  "baton/offer": { kind: "gathering.offered", outcome: "done", on: ["baton"] },
  "baton/close": { kind: "gathering.closed", outcome: "done", on: ["baton"] },
  "baton/goal-done": { kind: "gathering.closed", outcome: "done", on: ["baton"] },
  "baton/record-decision": {
    kind: "decision.recorded",
    outcome: "recorded",
    on: ["baton"],
    pick: (_s, d) => (str(d.decisionId) ? { entities: [{ type: "decision", id: str(d.decisionId)! }], aliases: [`decision:${str(d.decisionId)}`] } : undefined),
  },
  // a settle that states the operator's own decision declares that decision's id: the decision it starts answers to it
  "conflict/settle": {
    kind: "conflict.settled",
    outcome: "recorded",
    on: ["conflict"],
    pick: (_s, d) => (str(d.decisionId) ? { entities: [{ type: "decision", id: str(d.decisionId)! }], aliases: [`settle-decision:${str(d.decisionId)}`] } : undefined),
  },
  "decision/promote": { kind: "promotion.made", outcome: "started", on: ["reconciler"], pick: namesDecisions },
  "build/start": { kind: "build.started", outcome: "started", on: ["project", "item"], pick: startsBuild },
  "verbs/onboard": { kind: "build.started", outcome: "started", on: ["project"], pick: startsBuild },
  "build/prompt": { kind: "build.prompted", outcome: "done", on: ["build"] },
  // a prompt to a coding session through its project names that session
  "session/prompt": {
    kind: "build.prompted",
    outcome: "done",
    on: ["project"],
    pick: (s, d) => {
      const id = str(d.sessionId);
      const p = projectOfStep(s);
      return id ? { entities: [{ type: "session", id }], ...(p ? { relationKeys: [toKey("named-target", `sc:build/${p}/${id}`, { type: "build", id })] } : {}) } : undefined;
    },
  },
  "build/merge": { kind: "merge.requested", outcome: "started", on: ["build"] },
  "correct/merged": { kind: "merge.observed", outcome: "recorded", on: ["build"] },
  "owner-update/post": { kind: "owner-update.posted", outcome: "done", on: ["placement"] },
  // A send names its person by id and its outcome, never a number, a note or a link; a preview link it carries,
  // by the preview's id its own data declares (`link.preview`).
  "outreach/send": {
    kind: "outreach.sent",
    outcome: "started",
    on: ["placement"],
    pick: (_s, d) => {
      const person: EntityRef[] = isObj(d.target) && str(d.target.id) ? [{ type: "person", id: str(d.target.id)! }] : [];
      const pv = isObj(d.link) && d.link.kind === "preview" ? str(d.link.preview) : undefined;
      return { entities: [...person, ...(pv ? [{ type: "preview" as const, id: pv }] : [])], ...(pv ? { relationKeys: [toKey("named-target", `preview:${pv}`, { type: "preview", id: pv })] } : {}) };
    },
  },
  // A preview link asked for: the coding session it serves, or the running copy shared, by id. Never its purpose,
  // its address, its endpoint's link or anything the effect mints.
  "preview/start": {
    kind: "preview.started",
    outcome: "started",
    on: ["project"],
    pick: (s, d) => {
      const id = str(d.codingSession);
      const p = projectOfStep(s);
      return id ? { entities: [{ type: "session", id }], ...(p ? { relationKeys: [toKey("named-target", `sc:build/${p}/${id}`, { type: "session", id })] } : {}) } : undefined;
    },
  },
  "services/share": { kind: "preview.started", outcome: "started", on: ["project"], pick: (_s, d) => (str(d.instance) ? { entities: [{ type: "instance", id: str(d.instance)! }] } : undefined) },
  "project/archive": { kind: "project.archived", outcome: "done", on: ["project"] },
  "project/unarchive": { kind: "project.unarchived", outcome: "done", on: ["project"] },
  // placed: the act started the project's placement (placing a placed project again starts nothing)
  "project/place": {
    kind: "project.placed",
    outcome: "done",
    on: ["org"],
    when: (_s, d, call) => !!str(d.projectId) && !!startOf(call, `placement/${call.orgId}/${str(d.projectId)}`),
    pick: (_s, d) => ({ entities: [{ type: "project", id: str(d.projectId)! }] }),
  },
  // a person by id only: the act's `person` (their profile, contact included) is never read
  "person/add": { kind: "person.added", outcome: "done", on: ["org"], pick: (_s, d) => (str(d.personId) ? { entities: [{ type: "person", id: str(d.personId)! }] } : undefined) },
  ...Object.fromEntries(
    ["person/approve", "person/decline", "person/leave", "person/revert"].map((ev) => [
      ev,
      {
        kind: "person.status-changed" as const,
        outcome: "done" as const,
        on: ["person"],
        when: (s: Step) => !!statusMove(s),
        pick: (s: Step) => ({ entities: [{ type: "person" as const, id: lastPart(s.sessionId) }], rationale: { what: `Status: ${statusMove(s)}` } }),
      },
    ]),
  ),
  "owner/set": { kind: "setting.changed", outcome: "done", on: ["org"] },
  "stakeholder/set": { kind: "setting.changed", outcome: "done", on: ["placement"] },
  "spec/freeze": { kind: "setting.changed", outcome: "done", on: ["placement"] },
  "operator/level-set": { kind: "setting.changed", outcome: "done", on: ["watch"] },
  "decision/owner-area": { kind: "setting.changed", outcome: "done", on: ["decision"] },
  // a person's decision areas (their authority), never another profile field and never its values
  "person/edit": {
    kind: "setting.changed",
    outcome: "done",
    on: ["person"],
    when: (s) => Object.keys(s.changed ?? {}).some((k) => k === "decides" || k.startsWith("decides.")),
    pick: (s) => ({ entities: [{ type: "person", id: lastPart(s.sessionId) }] }),
  },
  "services/down": { kind: "stop.made", outcome: "done", on: ["project"] },
  "hold/cancel": { kind: "hold.cancelled", outcome: "cancelled" },
  "hold/approve": { kind: "hold.released", outcome: "released" },
};

/** Effects whose answer is a delivery observation: the effect kind → the observed kind. */
const EFFECT_RESULTS: Record<string, HistoryKind> = {
  merge: "merge.observed",
  promote: "promotion.made",
  "outreach-send": "outreach.sent",
  conform: "validation.observed",
  "make-worktree": "build.started",
  preview: "preview.made",
  "services-share": "preview.made",
};

/** Host events that are a milestone themselves. */
const OBSERVED: Record<string, { kind: HistoryKind; on: string[] }> = {
  "turn/ended": { kind: "build.finished", on: ["build"] },
};

/** The kinds this adapter writes (the matrix's rows, `CAPTURE_MATRIX` in shared/org-history.ts). */
export const CAPTURED_KINDS: readonly HistoryKind[] = [
  ...new Set<HistoryKind>([
    ...Object.values(ACTS).map((r) => r.kind),
    ...Object.values(EFFECT_RESULTS),
    ...Object.values(OBSERVED).map((r) => r.kind),
    "look.started",
    "decision.superseded",
    "hold.created",
    "hold.released",
    "act.refused",
    "conflict.opened",
  ]),
];

/** Who acted, among those whose acts the history keeps (an engine-internal or host event has none). */
const ACTORS = new Set(["operator", "overseer", "statechart", "model", "person", "wrapup", "sova"]);

const statechartOf = (s: Step): string => s.statechart ?? s.sessionId.split("/")[0] ?? "";

/** A step's project: its own, else its envelope's. */
const projectOfStep = (s: Step): string | null => s.projectId ?? str((s.data as Record<string, unknown> | undefined)?.projectId) ?? null;

/** The hold a step's id names, as the server names it (`<session>:<hold id>`, org-engine holdRef). */
const holdKey = (sid: string, id: string) => `hold:${sid}:${id}`;

/** The answered effect of an `effect/done|failed` step: its kind, from the pending entry the step removed. */
function answeredEffect(s: Step): { key: string; kind: string | undefined } | null {
  const d = (s.data ?? {}) as Record<string, unknown>;
  const key = str(d.key);
  if (!key) return null;
  // The engine delivers the answer with the pending effect it answers (engine core.cljs answer-effect!: the
  // event's data gets `kind` and `effect`); a step the statechart ignored also says it as
  // `changed["sova/pending.<key>"] = [<kind>, null]`.
  const effect = isObj(d.effect) ? str(d.effect.kind) : undefined;
  const one = s.changed?.[`sova/pending.${key}`];
  const before = Array.isArray(one) ? one[0] : undefined;
  return { key, kind: effect ?? str(d.kind) ?? (typeof before === "string" ? before : undefined) };
}

const isActStep = (s: Step, act: CaptureContext["act"]): boolean => !!act && s.sessionId === act.sessionId && s.event === act.event;

/** A statechart's sentence or a held act's description, private: only in the rationale. */
const said = (what: string | null | undefined): HistoryInput["rationale"] | undefined => (what ? { what } : undefined);

// ---- headlines ------------------------------------------------------------------------------------------------

/** A name or title as the step's data holds it, on one line and short; never anything else. */
/** The commit an effect's answer names: a merge answers its sha, a promotion `{ sha }`. */
const commitOf = (result: Record<string, unknown>): string | undefined => str(result.commit) ?? (isObj(result.commit) ? str(result.commit.sha) : undefined);

const label = (v: unknown): string | undefined => {
  const t = typeof v === "string" ? v.replace(/\s+/g, " ").trim() : "";
  return t ? (t.length > 120 ? `${t.slice(0, 119)}…` : t) : undefined;
};
const nameOfRef = (v: unknown): string | undefined => (isObj(v) ? label(v.name) : undefined);
const namesOf = (v: unknown): string | undefined => {
  const all = Array.isArray(v) ? v.map(nameOfRef).filter((x): x is string => !!x) : [];
  return all.length ? all.join(", ") : undefined;
};
const joined = (head: string, ...parts: (string | undefined)[]): string => {
  const [object, ...rest] = parts;
  return `${head}${object ? `: ${object}` : ""}${rest.filter(Boolean).map((p) => `, ${p}`).join("")}`;
};

/**
 * An event's headline when nothing more particular says it (a decision's statement, a refusal's sentence, a
 * held act's description): its verb and object, from names and titles the step's own data already holds (a
 * gathering's public title, a person's or a project's name, a gap's or a coding session's title, a commit's short sha). Never a
 * contact, a prompt, a question, a briefing or a message's words.
 */
export function headlineOf(kind: HistoryKind, outcome: HistoryOutcome, d: Record<string, unknown>, event = "", changed?: Step["changed"]): string | undefined {
  const failed = outcome === "failed";
  const person = nameOfRef(d.target);
  const people = namesOf(d.targetPeople) ?? person;
  const title = label(d.publicTitle);
  const result = isObj(d.result) ? d.result : {};
  const sha = label(commitOf(result));
  const commit = sha && /^[0-9a-f]{8,40}$/i.test(sha) ? sha.slice(0, 7) : sha;
  const project = label(d.projectName);
  switch (kind) {
    case "request.made":
      return "Run Now pressed";
    case "look.started":
      return "Project look started";
    case "gap.filed":
      return joined("Gap filed", label(d.title));
    case "gap.planned":
      return joined("Gathering planned", title, people ? `with ${people}` : undefined);
    case "gap.closed":
      return "Gap closed";
    case "gathering.started":
      return joined("Gathering started", title, people ? `with ${people}` : undefined);
    case "gathering.handed-off":
      if (event === "baton/take-back") return "Gathering taken back by the operator";
      return person ? `Gathering handed to ${person}` : "Gathering handed on";
    case "gathering.offered":
      return people ? `Gathering offered to ${people}` : "Gathering offered";
    case "gathering.closed":
      return "Gathering closed";
    case "decision.recorded":
      return "Decision recorded";
    case "decision.superseded":
      return joined("Decision superseded", label(d.title));
    case "conflict.opened":
      return "Conflict opened";
    case "conflict.settled":
      return joined("Conflict settled", label(d.title));
    case "hold.created":
      return "Act held for review";
    case "hold.released":
      return "Held act released";
    case "hold.cancelled":
      return "Held act cancelled";
    case "act.refused":
      return "Act refused";
    case "promotion.made":
      return failed ? "Decision promotion failed" : joined("Decisions promoted", commit);
    case "build.started":
      return failed ? "Coding session failed to start" : joined("Coding session started", label(d.title));
    case "build.prompted":
      return joined("Coding session prompted", label(d.title));
    case "build.finished":
      return failed ? "Coding session turn failed" : joined("Coding session turn finished", label(d.title));
    case "merge.requested":
      return "Branch merge requested";
    case "merge.observed":
      return failed ? "Branch merge failed" : joined("Branch merged", commit);
    case "validation.observed":
      return failed ? "Validation could not run" : result.pass === true ? "Validation passed" : result.pass === false ? "Validation failed" : "Validation ran";
    case "owner-update.posted":
      return "Owner update posted";
    case "outreach.sent":
      return joined(outcome === "done" ? "Message sent" : outcome === "refused" ? "Message refused" : outcome === "failed" ? "Message failed" : outcome === "unknown" ? "Message send unconfirmed" : "Message send started", person ? `to ${person}` : undefined);
    case "project.archived":
      return joined("Project archived", project);
    case "project.unarchived":
      return joined("Project unarchived", project);
    case "project.placed":
      return "Project placed";
    case "person.added":
      return "Person added";
    case "setting.changed":
      if (event === "spec/freeze") return d.frozen === false ? "Spec unfrozen" : "Spec frozen";
      if (event === "owner/set") return joined("Owner set", person);
      if (event === "stakeholder/set") return joined("Main stakeholder set", person);
      if (event === "decision/owner-area") return "Decision area set";
      if (event === "person/edit") return "Decision areas changed";
      if (event === "operator/level-set") {
        const to = Array.isArray(changed?.["settings.autonomy"]) ? changed!["settings.autonomy"][1] : undefined;
        return typeof to === "string" && LEVELS.includes(to) ? `Autonomy level set: ${to}` : "Autonomy level set";
      }
      return "Setting changed";
    case "preview.started":
      return "Preview link requested";
    case "preview.made":
      return failed ? "Preview link not made" : joined("Preview link made", label(result.id));
    case "stop.made":
      return joined("Running copy stopped", label(d.instance));
    default:
      return undefined;
  }
}

/**
 * The history inputs of one committed engine call. Steps the history doesn't keep (quiet bookkeeping,
 * engine events, link mirrors) give none. Each input's key is unique to its step; aliases name the handles
 * later steps answer to (a hold, an effect, a look's run, a session the act started).
 */
export function composeHistory(steps: readonly Step[], ctx: CaptureContext): HistoryInput[] {
  const out: HistoryInput[] = [];
  const keys = new Set<string>();
  const base = (i: number) => `step:${ctx.journalId}:${i}`;
  const push = (input: HistoryInput) => {
    // One key is one happening: a second input under it is the same happening, said once (and reported).
    if (keys.has(input.source.key)) return ctx.onProblem?.(`Two steps of one call gave the key ${input.source.key}; the second was not recorded again.`);
    keys.add(input.source.key);
    out.push(input);
  };
  const actAt = actIndex(steps, ctx);
  // A held act released in this call: by the approval this call's act is, or by its own timer when the
  // host's call is its timer (else its trigger is not recorded: it is related to its hold, never a cause).
  const approved = actAt != null && steps[actAt]!.event === "hold/approve" ? str((steps[actAt]!.data as Record<string, unknown> | undefined)?.id) : undefined;
  const releaseTrigger = (sid: string, holdId: string): { parentKeys?: HistoryInput["parentKeys"]; relationKeys?: HistoryInput["relationKeys"] } => {
    if (actAt != null && approved === holdId && steps[actAt]!.sessionId === sid) return { parentKeys: [{ key: base(actAt), via: "operator-act" }] };
    if (ctx.call === "timers") return { parentKeys: [{ key: holdKey(sid, holdId), via: "timer" }] };
    return { relationKeys: [{ key: holdKey(sid, holdId), type: "related", optional: true }] };
  };
  const approverActors = (): Partial<ActorBundle> | undefined => (actAt != null && approved ? actorsOf(steps[actAt]!, projectOfStep(steps[actAt]!)) : undefined);
  const claimed = new Set<string>();
  const call: Call = { steps, orgId: ctx.orgId };

  steps.forEach((s, i) => {
    // The engine's own release of a hold is a fact even when the statechart has no transition for it.
    if (s.ignored && s.event !== "hold/released" && s.event !== "hold/dropped") return;
    const d = (s.data ?? {}) as Record<string, unknown>;
    const chart = statechartOf(s);
    const by = str(d.by) ?? s.by ?? "";
    const projectId = projectOfStep(s);
    const projects = { primary: projectId, affected: [] as string[] };
    const mine = i === actAt ? ctx.provenance : undefined;
    const released = str(d["sova/released"]);
    // the start of the session the step was addressed to (a session's own start names none)
    const addressed = s.event === "sova/started" ? undefined : ownTarget(s.sessionId);
    const common = (kind: HistoryKind, outcome: HistoryOutcome, key: string, extra: Partial<HistoryInput> = {}, as: RelationType | null = "named-target"): HistoryInput => {
      const fromHold = released ? releaseTrigger(s.sessionId, released) : {};
      // A held act released by a review: its decider stays the act's own; the review is its authorization.
      const own = actorsOf(s, projectId);
      const review = released && approved === released ? approverActors()?.decidedBy : undefined;
      const authorization = review ? { kind: "hold-release" as const, ref: released!, by: review as ActorRef, attended: false, ...(inForceOf(d) ? { level: inForceOf(d) } : {}) } : own.authorization;
      const actors = { ...own, authorization, ...(mine?.actors ?? {}) } as ActorBundle;
      const policy = policyOf(d);
      const parentKeys = [...(extra.parentKeys ?? []), ...(fromHold.parentKeys ?? []), ...(mine?.parentKeys ?? [])];
      const relationKeys = [...(addressed && as ? [toKey(as, addressed.key, addressed.entity)] : []), ...(extra.relationKeys ?? []), ...(fromHold.relationKeys ?? []), ...(mine?.relationKeys ?? [])];
      const look = str(d.lookRun);
      if (look) parentKeys.push({ key: `invoke:${look}`, via: "invocation", optional: true });
      const given = mine?.rationale ?? extra.rationale;
      const headline = given?.what ? undefined : headlineOf(kind, mine?.outcome ?? outcome, d, s.event, s.changed);
      const rationale = headline ? { ...given, what: headline } : given;
      const evidence = [...(extra.evidence ?? []), ...(mine?.evidence ?? [])];
      return {
        kind,
        outcome: mine?.outcome ?? outcome,
        projects,
        entities: [...(extra.entities ?? []), { type: "session", id: s.sessionId }],
        actors,
        occurredAt: s.at,
        source: { adapter: ADAPTER, version: ADAPTER_VERSION, key: mine?.sourceKey ?? key },
        ...(extra.aliases?.length ? { aliases: extra.aliases } : {}),
        ...(mine?.triggeredBy?.length ? { triggeredBy: mine.triggeredBy } : {}),
        ...(parentKeys.length ? { parentKeys } : {}),
        ...(relationKeys.length ? { relationKeys } : {}),
        ...(mine?.decision ? { decision: mine.decision } : {}),
        ...(evidence.length ? { evidence } : {}),
        ...(policy ? { policy } : {}),
        ...(rationale ? { rationale } : {}),
      };
    };
    // the effects this step emitted: handles their answers name
    const emitted = (ctx.outbox ?? []).filter((e) => e.sessionId === s.sessionId && e.key && (s.effects ?? []).includes(e.key)).map((e) => `effect:${e.key}`);

    // a refusal of an act someone made
    if (s.refused) {
      if (!ACTORS.has(by)) return;
      push(common("act.refused", "refused", base(i), { rationale: said(s.refused.sentence) }));
      return;
    }
    // an act that waits in a hold
    if (s.held) {
      if (!ACTORS.has(by)) return;
      push(common("hold.created", "held", holdKey(s.sessionId, s.held.id), { entities: [{ type: "hold", id: `${s.sessionId}:${s.held.id}` }], rationale: said(s.held.what) }));
      return;
    }
    if (s.event === "hold/released" || s.event === "hold/dropped") {
      const id = str(d.id);
      if (!id) return;
      const dropped = s.event === "hold/dropped";
      const how = releaseTrigger(s.sessionId, id);
      const approver = approved === id ? approverActors() : undefined;
      push({
        ...common(dropped ? "act.refused" : "hold.released", dropped ? "refused" : "released", `release:${s.sessionId}:${id}`, {
          entities: [{ type: "hold", id: `${s.sessionId}:${id}` }],
          ...how,
          relationKeys: [...(how.relationKeys ?? []), ...(how.parentKeys?.some((p) => p.key === holdKey(s.sessionId, id)) || how.relationKeys ? [] : [{ key: holdKey(s.sessionId, id), type: "related" as const, optional: true }])],
          ...(dropped ? { rationale: said(str(d.sentence)) } : {}),
        }),
        actors: {
          initiatedBy: unknown("Started by its trigger."),
          decidedBy: approver?.decidedBy ?? (ctx.call === "timers" ? { kind: "statechart" } : unknown("Not recorded.")),
          recordedBy: { kind: "sova" },
          executedBy: { kind: "sova" },
          authorization: { kind: "hold-release", ref: `${s.sessionId}:${id}` },
        },
      });
      return;
    }
    if (s.event === "effect/done" || s.event === "effect/failed") {
      const eff = answeredEffect(s);
      const kind = eff?.kind ? EFFECT_RESULTS[eff.kind] : undefined;
      if (!eff || !kind) return;
      const failed = s.event === "effect/failed";
      const result = isObj(d.result) ? d.result : {};
      const evidence: EvidenceRef[] = [];
      if ((kind === "merge.observed" || kind === "promotion.made") && commitOf(result)) evidence.push({ n: 1, kind: "git", repo: "project", ...(projectId ? { project: projectId } : {}), commit: commitOf(result)! });
      if (kind === "validation.observed")
        evidence.push({ n: 1, kind: "validation", runner: "conform", result: failed ? "unknown" : result.pass === true ? "passed" : result.pass === false ? "failed" : "unknown", ...(projectId ? { project: projectId } : {}) });
      const outcome: HistoryOutcome = kind === "outreach.sent" ? sendOutcome(failed, result) : failed ? "failed" : kind === "build.started" ? "started" : kind === "preview.made" ? "done" : "observed";
      // a preview by the id its answer names (never the link, token or address the effect kept host-local)
      const preview = kind === "preview.made" && !failed ? str(result.id) : undefined;
      // a promotion adopts each decision its result says it promoted, never one it refused
      const promoted = kind === "promotion.made" && !failed && Array.isArray(result.promoted) ? [...new Set(result.promoted.map(str).filter((x): x is string => !!x))] : [];
      push({
        ...common(kind, outcome, `answer:${eff.key}`, {
          parentKeys: [{ key: `effect:${eff.key}`, via: "effect" }],
          evidence,
          ...(promoted.length ? { relationKeys: promoted.map((did) => toKey("adopts", `decision:${did}`, { type: "decision", id: did })) } : {}),
          ...(preview ? { entities: [{ type: "preview" as const, id: preview }], aliases: [`preview:${preview}`] } : {}),
          // a preview's failure text may name its address: not kept
          ...(failed && kind !== "outreach.sent" && kind !== "preview.made" ? { rationale: said(str(d.detail)) } : {}),
        }),
        actors: { initiatedBy: unknown("Started by its trigger."), decidedBy: unknown("An outside result."), recordedBy: { kind: "sova" }, executedBy: { kind: "sova" }, authorization: unknown("An outside result.") },
      });
      return;
    }
    const obs = OBSERVED[s.event];
    if (obs && obs.on.includes(chart) && s.saved) {
      const failed = d.failed === true;
      push({
        ...common(obs.kind, failed ? "failed" : "done", base(i)),
        actors: { initiatedBy: unknown("Started by its trigger."), decidedBy: unknown("An observation."), recordedBy: { kind: "sova" }, executedBy: { kind: "session", id: str(d.sessionId) ?? s.sessionId }, authorization: unknown("An observation.") },
      });
      return;
    }
    // a decision's statechart superseded, naming the decision that supersedes it: that supersession, as the
    // statechart says it (a run's verdict or a settle by hand: who reached it isn't on the step)
    if (chart === "decision" && s.event === "reconcile/result") {
      const old = lastPart(s.sessionId);
      const by = str(d.supersededBy);
      const moved = !!s.changed && ("state" in s.changed || "superseded-by" in s.changed);
      if (d.state !== "superseded" || !by || !moved || !old || by === old || !s.saved) return;
      push({
        ...common(
          "decision.superseded",
          "recorded",
          `superseded:${old}:${by}`,
          {
            entities: [
              { type: "decision", id: old },
              { type: "decision", id: by },
            ],
            relationKeys: [toKey("supersedes", `decision:${old}`, { type: "decision", id: old }), toKey("related", `decision:${by}`, { type: "decision", id: by })],
          },
          null,
        ),
        actors: { initiatedBy: unknown("Started by its trigger."), decidedBy: unknown("The decision statechart's verdict; who reached it is not recorded."), recordedBy: { kind: "sova" }, executedBy: { kind: "sova" }, authorization: unknown("Not recorded.") },
      });
      return;
    }
    // the operator's own decision, stated to settle a conflict: born with no gathering, by the operator, under
    // the id its settle declared (a gathering's decision is recorded from its record_decision instead)
    if (chart === "decision" && s.event === "sova/started" && !str(d.sessionId) && d.by === "operator" && str(d.id)) {
      const did = str(d.id)!;
      const operator: ActorRef = { kind: "operator" };
      push({
        ...common("decision.recorded", "chosen", `decision:${did}`, {
          entities: [{ type: "decision", id: did }],
          parentKeys: [{ key: `settle-decision:${did}`, via: "effect", optional: true }],
          ...(label(d.statement) ? { rationale: { what: str(d.statement)! } } : {}),
        }),
        // the operator typed its statement: they worded it, so it reads as theirs, never "Worded by" anyone else
        actors: { initiatedBy: operator, decidedBy: operator, recordedBy: operator, executedBy: { kind: "sova" }, authorization: { kind: "operator-act" } },
        decision: { disposition: "choose", options: [], authority: operator },
      });
      return;
    }
    if (s.event === "sova/started" && chart === "conflict") {
      // the two decisions its start data names as its sides
      const sides = [d.a, d.b].map((x) => (isObj(x) ? str(x.id) : undefined)).filter((x): x is string => !!x);
      const input = common("conflict.opened", "recorded", `conflict:${s.sessionId}`, {
        entities: [{ type: "conflict", id: s.sessionId }],
        ...(sides.length ? { relationKeys: [...new Set(sides)].map((did) => toKey("named-target", `decision:${did}`, { type: "decision", id: did })) } : {}),
      });
      // the run's request, as its start data carries it (the operator's call, the global Overseer's through it, a
      // project overseer's tool): who called it initiated it, under that call's authorization; the reconciler's
      // comparison decided it. An automatic run carries none and stays as its step says.
      const asked = isObj(d.requestedBy) && (d.requestedBy.by === "operator" || d.requestedBy.by === "overseer") ? actorsOf({ by: null, data: d.requestedBy as Step["data"], sessionId: s.sessionId }, projectId) : null;
      const askedPolicy = asked ? policyOf(d.requestedBy as Record<string, unknown>) : undefined;
      push(
        asked
          ? {
              ...input,
              actors: { initiatedBy: asked.decidedBy, decidedBy: { kind: "system" }, recordedBy: { kind: "sova" }, executedBy: { kind: "sova" }, authorization: asked.authorization },
              ...(askedPolicy ? { policy: askedPolicy } : {}),
            }
          : input,
      );
      return;
    }
    // a conflict's settle gathering, started by the conflict statechart itself (the engine names its spawner): spawned
    // by the conflict's start when that start, in this call, declared this session; else it names its conflict
    const spawner = str(d["sova/spawnedBy"]);
    if (s.event === "sova/started" && chart === "baton" && isObj(d.conflict) && spawner?.startsWith("conflict/") && s.saved) {
      const id = lastPart(s.sessionId);
      const opened = steps.find((x) => x.event === "sova/started" && x.sessionId === spawner);
      const declared = !!opened && str((opened.data as Record<string, unknown> | undefined)?.batonSessionId) === id;
      const to = str(d.to);
      const names = isObj(d.names) ? d.names : {};
      push({
        ...common(
          "gathering.started",
          "started",
          `sc:${s.sessionId}`,
          {
            entities: [{ type: "session", id }],
            ...(declared ? { parentKeys: [{ key: `conflict:${spawner}`, via: "spawn" }] } : { relationKeys: [toKey("named-target", `conflict:${spawner}`, { type: "conflict", id: spawner })] }),
            rationale: { what: joined("Gathering started", label(d.publicTitle), to && label(names[to]) ? `with ${label(names[to])}` : undefined) },
          },
          null,
        ),
        actors: { initiatedBy: unknown("Started by its trigger."), decidedBy: { kind: "statechart" }, recordedBy: { kind: "sova" }, executedBy: { kind: "sova" }, authorization: { kind: "none" } },
      });
      return;
    }
    const row = ACTS[s.event];
    // a matrix act is kept whoever made it (Sova on its own included: a recovered decision); refusals and holds above need an actor
    if (!row || (row.on && !row.on.includes(chart)) || !s.saved || !by || (row.when && !row.when(s, d, call))) return;
    const picked = row.pick?.(s, d, call) ?? {};
    const aliases = [...(picked.aliases ?? []), ...emitted];
    const parentKeys: NonNullable<HistoryInput["parentKeys"]> = [];
    if (s.event === "hold/cancel" || s.event === "hold/approve") {
      const id = str(d.id);
      if (id) parentKeys.push({ key: holdKey(s.sessionId, id), via: by === "operator" ? "operator-act" : "tool-call", optional: true });
    }
    const reason = s.event === "hold/cancel" || s.event === "hold/approve" ? str(d.reason) : undefined;
    const key = picked.aliases?.find((a) => a.startsWith("decision:")) ?? base(i);
    const input = common(
      row.kind,
      row.outcome,
      key,
      {
        entities: [...(picked.entities ?? []), ...(s.event === "hold/cancel" || s.event === "hold/approve") && str(d.id) ? [{ type: "hold" as const, id: `${s.sessionId}:${str(d.id)}` }] : []],
        aliases: aliases.filter((a) => a !== key),
        parentKeys,
        ...(picked.relationKeys?.length ? { relationKeys: picked.relationKeys } : {}),
        ...(reason ? { rationale: { reason: { text: reason, author: actorsOf(s, projectId).decidedBy, contemporaneous: true } } } : picked.rationale ? { rationale: picked.rationale } : {}),
      },
      // a decision was recorded in the gathering it was recorded in; every other act names the session it went to
      s.event === "baton/record-decision" ? "recorded-in" : "named-target",
    );
    push(input);
    if (s.event === "operator/run-now" && i === actAt) {
      // The click is the operator's request; the look it opens runs unattended.
      // Only the act's own transition starts a look in this call on this session: the engine names no step on
      // an invocation, so a look started by any other step is not claimed here.
      // The act's own step entered the state that runs the look (its before/after say so), and no other step of
      // this call on the session did: then this act started it. Anything less is not claimed.
      const enters = (x: Step) => !x.before.includes("running") && x.after.includes("running");
      const runs = looksOf(ctx).filter((r) => r.sessionId === s.sessionId);
      const others = steps.some((x, j) => j !== i && x.sessionId === s.sessionId && !x.ignored && (enters(x) || x.after.includes("running") !== x.before.includes("running")));
      if (runs.length === 1 && enters(s) && !others) {
        claimed.add(runs[0]!.runId!);
        push({
          ...common("look.started", "started", `look:${runs[0]!.runId}`, { aliases: [`invoke:${runs[0]!.runId}`], parentKeys: [{ key: input.source.key, via: "request" }] }),
          actors: { initiatedBy: { kind: "operator" }, decidedBy: { kind: "statechart" }, recordedBy: { kind: "sova" }, executedBy: { kind: "sova" }, authorization: { kind: "autonomy-level", attended: false } },
          policy: { attended: false },
        });
      }
    }
  });
  // every other look started in this call: recorded from its run, its trigger not recorded
  for (const r of looksOf(ctx)) {
    if (claimed.has(r.runId!)) continue;
    push({
      kind: "look.started",
      outcome: "started",
      projects: { primary: r.sessionId.startsWith("watch/") ? r.sessionId.slice("watch/".length) : null, affected: [] },
      entities: [{ type: "session", id: r.sessionId }],
      actors: { initiatedBy: unknown("Trigger not recorded."), decidedBy: { kind: "statechart" }, recordedBy: { kind: "sova" }, executedBy: { kind: "sova" }, authorization: { kind: "autonomy-level", attended: false } },
      source: { adapter: ADAPTER, version: ADAPTER_VERSION, key: `look:${r.runId}` },
      aliases: [`invoke:${r.runId}`],
      policy: { attended: false },
      rationale: { what: headlineOf("look.started", "started", {})! },
    });
  }
  return out;
}

/** The looks a call started (a watch's `sova/look` invocations). */
const looksOf = (ctx: CaptureContext) => (ctx.invocations ?? []).filter((r) => r.op === "start" && r.type === "sova/look" && !!r.runId);

/**
 * The call's own act's step: the one step of the act's session and event that is not a held act
 * re-delivered (`sova/released`). Due timers fire before the act in every call, so position says nothing.
 * None, or more than one candidate: the caller's provenance goes to no step, and that is reported.
 */
function actIndex(steps: readonly Step[], ctx: CaptureContext): number | null {
  if (!ctx.act) return null;
  const hits: number[] = [];
  steps.forEach((s, i) => {
    if (s.sessionId === ctx.act!.sessionId && s.event === ctx.act!.event && !str((s.data as Record<string, unknown> | undefined)?.["sova/released"])) hits.push(i);
  });
  if (hits.length === 1) return hits[0]!;
  if (ctx.provenance) ctx.onProblem?.(`The act ${ctx.act.event} on ${ctx.act.sessionId} matched ${hits.length} steps; its provenance was not attached.`);
  return null;
}

/** An outreach send's answer: sent, refused, or a result that never came back (Unknown, never Failed). */
function sendOutcome(failed: boolean, result: Record<string, unknown>): HistoryOutcome {
  if (failed) return "failed";
  const outcome = str(result.outcome);
  const code = str(result.code);
  if (outcome === "sent") return "done";
  if (outcome === "refused") return "refused";
  if (code === "unknown" || code === "unknown-after-restart") return "unknown";
  // a definite failure says so with its code; a result that says neither is not confirmed either way
  return outcome === "failed" && code ? "failed" : "unknown";
}

export type { RelationType, HistoryRationale };
