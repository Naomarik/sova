// Recording: a capture's inputs become events and the
// journal's history part, inside the org host's step. Pure but for reading the index: no file is written
// here. Ids are minted, never derived; a source key recorded before (in the index or earlier in the
// batch) records nothing new and answers the existing id. Links are taken as given and checked: a
// trigger or relation naming no event of this organization is refused and noted on the event, an
// optional trigger by key that resolves to nothing is left out ("Trigger not recorded"). Only the
// fields a record may hold are copied, so no free text reaches the structural line.
import {
  HISTORY_KINDS,
  HISTORY_OUTCOMES,
  HISTORY_SCHEMA,
  RELATION_TYPES,
  isUnknown,
  type ActorBundle,
  type ActorRef,
  type Authorization,
  type EntityRef,
  type EventId,
  type EvidenceRef,
  type HistoryEvent,
  type HistoryInput,
  type HistoryRationale,
  type RefusedLink,
  type Relation,
  type Trigger,
  type Unknown,
} from "../../shared/org-history";
import type { JournalHistory } from "../org-host/store";
import type { HistoryIndex } from "./index";
import { newEventId, rationaleFile, segmentName, segmentPath, type HistoryPaths } from "./store";

const KINDS = new Set<string>(HISTORY_KINDS);
const OUTCOMES = new Set<string>(HISTORY_OUTCOMES);
const RELATIONS = new Set<string>(RELATION_TYPES);
const VIAS = new Set(["request", "timer", "tool-call", "effect", "spawn", "notification", "operator-act", "invocation"]);
const ACTOR_KINDS = new Set(["operator", "person", "project-overseer", "global-overseer", "model", "sova", "statechart", "system", "worker", "session", "validation-runner", "external"]);
const AUTH_KINDS = new Set(["operator-act", "attended-turn", "autonomy-level", "grant", "confirm-card", "hold-release", "person-decision", "safety", "none"]);
const ENTITY_TYPES = new Set(["org", "project", "person", "gap", "gathering", "decision", "conflict", "build", "hold", "promotion", "session", "commit", "file", "outreach", "owner-update", "setting", "spec-claim", "look", "preview", "instance"]);
const CHECKS = new Set(["checked", "quote-not-found", "speaker-mismatch", "source-unavailable", "unchecked"]);

/** A capture that can't be recorded as given (a bug in its adapter): the step is a save failure. */
export class HistoryInputError extends Error {
  constructor(why: string) {
    super(`A history record is malformed: ${why}`);
    this.name = "HistoryInputError";
  }
}

export interface PrepareContext {
  orgId: string;
  /** The recorded time (the host's clock at the step). */
  at: number;
  /** The journal it is written in. */
  txn: string;
  epoch: string;
  index: HistoryIndex;
  paths: HistoryPaths;
}

export interface Prepared {
  /** Per input: the id recorded, or the id already recorded under its key. */
  ids: EventId[];
  /** The events new in this batch. */
  events: HistoryEvent[];
  rationales: HistoryRationale[];
  history: JournalHistory;
}

const str = (v: unknown, max: number): string | undefined => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : undefined);
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const id = (v: unknown): string | undefined => str(v, 200);

function actor(v: unknown): ActorRef | Unknown {
  if (!v || typeof v !== "object" || isUnknown(v)) {
    const why = isUnknown(v) ? str((v as Unknown).why, 120) : undefined;
    return { unknown: true, ...(why ? { why } : {}) };
  }
  const a = v as ActorRef;
  if (!ACTOR_KINDS.has(a.kind)) throw new HistoryInputError(`unknown actor kind ${String(a.kind)}`);
  const ref: ActorRef = { kind: a.kind };
  if (id(a.id)) ref.id = id(a.id);
  if (a.via === "overseer") ref.via = "overseer";
  if (id(a.model)) ref.model = id(a.model);
  if (id(a.session)) ref.session = id(a.session);
  return ref;
}

function authorization(v: unknown): Authorization | Unknown {
  if (!v || typeof v !== "object" || isUnknown(v)) return actor(v) as Unknown;
  const a = v as Authorization;
  if (!AUTH_KINDS.has(a.kind)) throw new HistoryInputError(`unknown authorization ${String(a.kind)}`);
  const out: Authorization = { kind: a.kind };
  if (id(a.level)) out.level = id(a.level);
  if (typeof a.attended === "boolean") out.attended = a.attended;
  if (id(a.ref)) out.ref = id(a.ref);
  if (a.by) {
    const by = actor(a.by);
    if (!isUnknown(by)) out.by = by;
  }
  return out;
}

function actors(a: Partial<ActorBundle> | undefined): ActorBundle {
  return {
    initiatedBy: actor(a?.initiatedBy),
    decidedBy: actor(a?.decidedBy),
    recordedBy: actor(a?.recordedBy),
    executedBy: actor(a?.executedBy),
    authorization: authorization(a?.authorization),
  };
}

function entity(v: unknown): EntityRef {
  const e = v as EntityRef;
  if (!e || !ENTITY_TYPES.has(e.type) || !id(e.id)) throw new HistoryInputError(`bad entity ${JSON.stringify(v)?.slice(0, 80)}`);
  return { type: e.type, id: id(e.id)! };
}

function evidence(list: EvidenceRef[] | undefined): EvidenceRef[] {
  const out: EvidenceRef[] = [];
  for (const [i, raw] of (list ?? []).entries()) {
    const n = num(raw.n) ?? i + 1;
    switch (raw.kind) {
      case "transcript": {
        if (!id(raw.session) || !id(raw.entry)) throw new HistoryInputError("a transcript citation needs its session and entry");
        const span = Array.isArray(raw.span) && raw.span.length === 2 && raw.span.every((x) => Number.isInteger(x)) ? ([raw.span[0], raw.span[1]] as [number, number]) : undefined;
        const speaker = raw.speaker ? actor(raw.speaker) : undefined;
        const digest = raw.digest && typeof raw.digest.sha === "string" && typeof raw.digest.len === "number" ? { sha: raw.digest.sha.slice(0, 64), len: raw.digest.len } : undefined;
        const check = CHECKS.has(raw.check) ? raw.check : "unchecked";
        // an unchecked quote's reason: a short fixed sentence from the capture
        const why = check === "unchecked" && typeof raw.why === "string" && raw.why.trim() ? raw.why.trim().slice(0, 200) : undefined;
        out.push({ n, kind: "transcript", session: id(raw.session)!, entry: id(raw.entry)!, ...(span ? { span } : {}), ...(speaker && !isUnknown(speaker) ? { speaker } : {}), ...(digest ? { digest } : {}), check, ...(why ? { why } : {}) });
        break;
      }
      case "event":
        if (!id(raw.event)) throw new HistoryInputError("an event citation needs its event");
        out.push({ n, kind: "event", event: id(raw.event)! });
        break;
      case "log-row":
        if (!id(raw.session) || num(raw.at) == null) throw new HistoryInputError("a log row citation needs its session and time");
        out.push({ n, kind: "log-row", session: id(raw.session)!, at: num(raw.at)!, ...(str(raw.k, 80) ? { k: str(raw.k, 80) } : {}) });
        break;
      case "runtime":
        out.push({ n, kind: "runtime", what: str(raw.what, 120) ?? "observation", ...(id(raw.session) ? { session: id(raw.session) } : {}), ...(num(raw.at) != null ? { at: num(raw.at) } : {}) });
        break;
      case "git":
        out.push({ n, kind: "git", repo: raw.repo === "workspace" ? "workspace" : "project", ...(id(raw.project) ? { project: id(raw.project) } : {}), ...(str(raw.commit, 64) ? { commit: str(raw.commit, 64) } : {}), ...(str(raw.branch, 200) ? { branch: str(raw.branch, 200) } : {}) });
        break;
      case "spec":
        if (!id(raw.project) || !id(raw.claim)) throw new HistoryInputError("a spec citation needs its project and claim");
        out.push({ n, kind: "spec", project: id(raw.project)!, claim: id(raw.claim)! });
        break;
      case "validation":
        out.push({ n, kind: "validation", runner: str(raw.runner, 80) ?? "unknown", result: raw.result === "passed" || raw.result === "failed" ? raw.result : "unknown", ...(id(raw.project) ? { project: id(raw.project) } : {}) });
        break;
      default:
        throw new HistoryInputError(`unknown evidence kind ${String((raw as { kind?: unknown }).kind)}`);
    }
  }
  return out;
}

function rationaleOf(eventId: EventId, r: HistoryInput["rationale"]): HistoryRationale | null {
  if (!r) return null;
  const out: HistoryRationale = { v: HISTORY_SCHEMA, event: eventId };
  const what = str(r.what, 300);
  if (what) out.what = what;
  const reason = str(r.reason?.text, 2000);
  if (reason) out.reason = { text: reason, author: actor(r.reason?.author), contemporaneous: r.reason?.contemporaneous !== false };
  const options = (r.options ?? []).flatMap((o) => {
    const oid = id(o.id);
    const label = str(o.label, 200);
    if (!oid || !label) return [];
    return [{ id: oid, label, ...(str(o.reason, 1000) ? { reason: str(o.reason, 1000) } : {}), ...(str(o.condition, 500) ? { condition: str(o.condition, 500) } : {}) }];
  });
  if (options.length) out.options = options;
  const quotes = (r.quotes ?? []).flatMap((q) => (num(q.n) != null && str(q.text, 1000) ? [{ n: num(q.n)!, text: str(q.text, 1000)! }] : []));
  if (quotes.length) out.quotes = quotes;
  return Object.keys(out).length > 2 ? out : null;
}

/** The inputs of one step, as events and journal parts. Throws HistoryInputError for a malformed input. */
export function prepareHistory(inputs: readonly HistoryInput[], ctx: PrepareContext): Prepared {
  const ids: EventId[] = [];
  const events: HistoryEvent[] = [];
  const rationales: HistoryRationale[] = [];
  const history: JournalHistory = { lines: [], files: [], removes: [] };
  const batchKeys = new Map<string, EventId>();
  const batchIds = new Set<EventId>();
  const known = (eid: EventId): boolean => batchIds.has(eid) || ctx.index.entry(eid)?.ok === true;
  const byKey = (key: string): EventId | undefined => batchKeys.get(key) ?? ctx.index.byKey.get(key);

  for (const input of inputs) {
    if (!input || !KINDS.has(input.kind)) throw new HistoryInputError(`unknown kind ${String(input?.kind)}`);
    if (!OUTCOMES.has(input.outcome)) throw new HistoryInputError(`unknown outcome ${String(input.outcome)}`);
    const key = str(input.source?.key, 300);
    const adapter = str(input.source?.adapter, 60);
    if (!key || !adapter || !Number.isInteger(input.source.version)) throw new HistoryInputError(`${input.kind}: a source needs its adapter, version and key`);
    const existing = byKey(key);
    if (existing) {
      ids.push(existing);
      continue;
    }
    const eid = newEventId();
    const refused: RefusedLink[] = [];
    const triggeredBy: Trigger[] = [];
    const seen = new Set<string>();
    const addTrigger = (target: EventId, via: Trigger["via"]) => {
      if (target === eid) return refused.push({ target, as: "triggeredBy", why: "cycle" });
      if (!seen.has(target)) triggeredBy.push({ event: target, via });
      seen.add(target);
    };
    for (const t of input.triggeredBy ?? []) {
      if (!VIAS.has(t?.via)) throw new HistoryInputError(`${input.kind}: unknown trigger ${String(t?.via)}`);
      if (known(t.event)) addTrigger(t.event, t.via);
      else refused.push({ target: String(t.event).slice(0, 200), as: "triggeredBy", why: "no-such-event" });
    }
    for (const p of input.parentKeys ?? []) {
      if (!VIAS.has(p?.via)) throw new HistoryInputError(`${input.kind}: unknown trigger ${String(p?.via)}`);
      const hit = byKey(p.key);
      if (hit) addTrigger(hit, p.via);
      else if (!p.optional) refused.push({ target: String(p.key).slice(0, 200), as: "triggeredBy", why: "no-such-event" });
    }
    const relations: Relation[] = [];
    for (const r of input.relations ?? []) {
      if (!RELATIONS.has(r?.type)) throw new HistoryInputError(`${input.kind}: unknown relation ${String(r?.type)}`);
      if ("entity" in r.target) relations.push({ type: r.type, target: { entity: entity(r.target.entity) } });
      else if (r.target.event === eid) refused.push({ target: eid, as: r.type, why: "cycle" });
      else if (known(r.target.event)) relations.push({ type: r.type, target: { event: r.target.event } });
      else refused.push({ target: String(r.target.event).slice(0, 200), as: r.type, why: "no-such-event" });
    }
    for (const r of input.relationKeys ?? []) {
      if (!RELATIONS.has(r?.type)) throw new HistoryInputError(`${input.kind}: unknown relation ${String(r?.type)}`);
      const hit = byKey(r.key);
      if (hit) relations.push({ type: r.type, target: { event: hit } });
      // its event isn't in this history: the reference the step carried, kept as that entity
      else if (r.entity) relations.push({ type: r.type, target: { entity: entity(r.entity) } });
      else if (!r.optional) refused.push({ target: String(r.key).slice(0, 200), as: r.type, why: "no-such-event" });
    }
    if (input.about && !known(input.about)) throw new HistoryInputError(`${input.kind}: it is about ${input.about}, which this organization has no record of`);
    const rationale = rationaleOf(eid, input.rationale);
    const primary = input.projects?.primary == null ? null : id(input.projects.primary) ?? null;
    const affected = [...new Set((input.projects?.affected ?? []).map((p) => id(p)).filter((p): p is string => !!p && p !== primary))];
    const occurredAt = num(input.occurredAt);
    const event: HistoryEvent = {
      v: HISTORY_SCHEMA,
      id: eid,
      org: ctx.orgId,
      kind: input.kind,
      outcome: input.outcome,
      projects: { primary, affected },
      entities: (input.entities ?? []).map(entity),
      actors: actors(input.actors),
      times: { recordedAt: ctx.at, ...(occurredAt != null ? { occurredAt } : {}) },
      source: { adapter, version: input.source.version, key, txn: ctx.txn },
      writer: { epoch: ctx.epoch, seq: ctx.index.nextSeq(ctx.epoch) },
      triggeredBy,
      relations,
      evidence: evidence(input.evidence),
      capture:
        input.capture?.origin === "imported"
          ? { origin: "imported", ...(num(input.capture.importedAt) != null ? { importedAt: num(input.capture.importedAt) } : {}), ...(input.capture.importOf ? { importOf: { kind: String(input.capture.importOf.kind).slice(0, 60), id: String(input.capture.importOf.id).slice(0, 200) } } : {}) }
          : input.capture?.origin === "gap"
            ? { origin: "gap" }
            : { origin: "live" },
    };
    const aliases = [...new Set((input.aliases ?? []).map((a) => str(a, 300)).filter((a): a is string => !!a && a !== key && !byKey(a)))];
    if (aliases.length) event.aliases = aliases;
    if (refused.length) event.refusedLinks = refused;
    if (input.decision) {
      const d = input.decision;
      if (!["choose", "reject", "defer", "do-not-do"].includes(d.disposition)) throw new HistoryInputError(`unknown disposition ${String(d.disposition)}`);
      event.decision = {
        disposition: d.disposition,
        options: (d.options ?? []).map((o) => {
          if (!id(o.id) || !["selected", "rejected", "deferred", "do-not-do"].includes(o.outcome)) throw new HistoryInputError("an option needs its id and outcome");
          return { id: id(o.id)!, outcome: o.outcome };
        }),
        ...(d.scope?.length ? { scope: d.scope.map(entity) } : {}),
        authority: actor(d.authority),
        ...(num(d.reviewAt) != null ? { reviewAt: num(d.reviewAt) } : {}),
      };
    }
    if (input.policy) {
      const p = input.policy;
      event.policy = {
        attended: p.attended === true,
        ...(id(p.autonomy) ? { autonomy: id(p.autonomy) } : {}),
        ...(id(p.inForce) ? { inForce: id(p.inForce) } : {}),
        ...(typeof p.paused === "boolean" ? { paused: p.paused } : {}),
        ...(id(p.hold) ? { hold: id(p.hold) } : {}),
        ...(id(p.card) ? { card: id(p.card) } : {}),
        ...(p.grants?.length ? { grants: p.grants.map((g) => id(g)).filter((g): g is string => !!g) } : {}),
      };
    }
    if (input.about) event.about = input.about;
    if (input.correction?.projects) {
      const cp = input.correction.projects;
      event.correction = { projects: { primary: cp.primary == null ? null : id(cp.primary) ?? null, affected: (cp.affected ?? []).map((p) => id(p)).filter((p): p is string => !!p) } };
    }
    if (input.gap && num(input.gap.from) != null && num(input.gap.to) != null) event.gap = { from: num(input.gap.from)!, to: num(input.gap.to)! };
    if (rationale) {
      event.rationale = true;
      rationales.push(rationale);
      history.files.push({ file: rationaleFile(ctx.paths, eid), text: JSON.stringify(rationale) });
    }
    // a purge removes its subject's rationale in the same step that records it
    if (input.kind === "rationale.purged" && input.about) history.removes.push(rationaleFile(ctx.paths, input.about));
    batchKeys.set(key, eid);
    for (const a of aliases) batchKeys.set(a, eid);
    batchIds.add(eid);
    ids.push(eid);
    events.push(event);
    history.lines.push({ file: segmentPath(ctx.paths, segmentName(ctx.at)), id: eid, line: JSON.stringify(event) });
  }
  return { ids, events, rationales, history };
}
