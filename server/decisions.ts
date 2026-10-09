import { OWNER_AREA_NONE, type Conflict, type DecisionRow, type DecisionState, type OwnerAreaChange, type Provenance, type ReconcileRun } from "../shared/decisions";
import type { OrgProject, Person } from "../shared/orgs";
import type { AttentionItem } from "../shared/protocol";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { HEntry } from "../shared/harness";
import { BATON_DECISION_ENTRY, OPERATOR, type BatonDecisionData } from "../shared/baton";
import type { ActorRef, EvidenceRef, QuoteCheck } from "../shared/org-history";
import { allBatons, batonFileOf, batonSid, sessionPathOf } from "./baton";
import { messageSenders } from "./baton-view";
import { joinedText, parsePi } from "./harness/pi/reader";
import { envelopeFor, hostOf, isOrgHostOpen, type OrgHostApi, type SessionInfo } from "./org-engine";
import { addWorkspaceProblems, isoOf, operatorName, orgDir, OrgError, placementSid, readIndex, readOrg, readProjects, readRoster } from "./orgs";

/**
 * The decision index (§app.requirements/decisions), read from the statecharts (q1: no decisions.json, no
 * conflicts.json): each recorded decision is a `decision` statechart (born by its gathering session's
 * record_decision, or a conflict settled by hand), each conflict a `conflict` statechart, the last run the
 * project's `reconciler`. The rows below are projections of their data in today's wire shapes.
 */

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const strs = (v: unknown): string[] | undefined => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : undefined);

export const decisionSid = (orgId: string, projectId: string, id: string) => `decision/${orgId}/${projectId}/${id}`;
export const conflictSid = (orgId: string, projectId: string, id: string) => `conflict/${orgId}/${projectId}/${id}`;
export const reconcilerSid = (orgId: string, projectId: string) => `reconciler/${orgId}/${projectId}`;

/** The project, or a 404. */
export function projectOf(orgId: string, projectId: string) {
  const p = readProjects(orgId).find((x) => x.id === projectId);
  if (!p) throw new OrgError("Unknown project", 404);
  return p;
}

// ---- the statecharts, as rows ------------------------------------------------------------------------------

export interface DecisionStore {
  decisions: DecisionRow[];
  lastRun: ReconcileRun | null;
  /** specHash of the project's spec right after the reconciler last wrote it (frozen check). */
  lastPromotedSpec?: string;
}

const isoOr = (v: unknown, fallback = new Date(0).toISOString()): string => (typeof v === "number" ? isoOf(v) : typeof v === "string" ? v : fallback);

/** A decision statechart as today's DecisionRow. A promoted one whose record went missing or differs is
    promotable again: it reads `drafted`, as before. */
export function decisionRowOf(orgId: string, s: Pick<SessionInfo, "configuration" | "data">, paths: ReadonlyMap<string, string>): DecisionRow {
  const d = s.data;
  const conf = s.configuration;
  const promoted = conf.includes("promoted");
  const state: DecisionState = promoted ? (conf.includes("stale") ? "drafted" : "promoted") : ((str(d.state) as DecisionState | undefined) ?? "pending");
  const sessionId = str(d.sessionId) ?? "";
  const history = Array.isArray(d.ownerAreaHistory)
    ? d.ownerAreaHistory.filter(isObj).map((h): OwnerAreaChange => ({ at: isoOr(h.at), by: str(h.by) ?? OPERATOR, name: str(h.name) ?? "", from: str(h.from) ?? null, to: str(h.to) ?? OWNER_AREA_NONE }))
    : undefined;
  const kept = isObj(d.textKept) ? { at: isoOr(d.textKept.at), by: str(d.textKept.by) ?? OPERATOR, name: str(d.textKept.name) ?? "" } : undefined;
  return {
    id: str(d.id) ?? "",
    orgId,
    projectId: str(d.projectId) ?? "",
    area: str(d.area) ?? "",
    areaKey: str(d.areaKey) ?? areaKeyOf(str(d.area) ?? ""),
    ...(str(d.ownerArea) ? { ownerArea: str(d.ownerArea) } : {}),
    ...(history?.length ? { ownerAreaHistory: history } : {}),
    statement: str(d.statement) ?? "",
    quote: str(d.quote) ?? "",
    by: str(d.by) ?? OPERATOR,
    name: str(d.name) ?? "",
    ...(d.nameAt === "recovery" ? { nameAt: "recovery" as const } : {}),
    at: isoOr(d.at ?? d.recordedAt),
    sessionId,
    entryId: str(d.entryId) ?? str(d.markerId) ?? "",
    markerId: str(d.markerId) ?? "",
    authorOwnsArea: d.authorOwnsArea === true,
    sessionPath: (sessionId && paths.get(sessionId)) || null,
    state,
    ...(str(d.recordId) ? { recordId: str(d.recordId) } : {}),
    ...(str(d.supersededBy) ? { supersededBy: str(d.supersededBy) } : {}),
    ...(strs(d.folded)?.length ? { folded: strs(d.folded) } : {}),
    ...(str(d.resolves) ? { resolves: str(d.resolves) } : {}),
    ...(strs(d.checkedWith) ? { checkedWith: strs(d.checkedWith) } : {}),
    ...(d.promotedAt !== undefined && d.promotedAt !== null ? { promotedAt: isoOr(d.promotedAt) } : {}),
    ...(str(d.promotedText) ? { promotedText: str(d.promotedText) } : {}),
    ...(str(d.promotedCommit) ? { promotedCommit: str(d.promotedCommit) } : {}),
    ...(kept ? { textKept: kept } : {}),
    ...(promoted && d.editedInSpec === true ? { editedInSpec: true } : {}),
    ...(promoted && (d.build === "built" || d.build === "not-built") ? { build: d.build } : {}),
  };
}

/** A conflict statechart as today's Conflict (its settle session's path is this host's, derived on each read). An open
    conflict no session asks about any more (its settle session closed without a re-route: the statechart's `unrouted`)
    names none, so the project page offers the route form again (C17). */
export function conflictOf(orgId: string, s: Pick<SessionInfo, "data" | "configuration">, paths: ReadonlyMap<string, string>): Conflict {
  const d = s.data;
  const side = (v: unknown) => (isObj(v) ? (str(v.id) ?? "") : (str(v) ?? ""));
  const asking = !(d.state !== "resolved" && s.configuration.includes("unrouted"));
  const batonSessionId = asking ? str(d.batonSessionId) : undefined;
  const path = batonSessionId ? paths.get(batonSessionId) : undefined;
  const outcome = str(d.outcome);
  return {
    id: str(d.id) ?? "",
    orgId,
    projectId: str(d.projectId) ?? "",
    areaKey: str(d.areaKey) ?? "",
    ...(str(d.ownerArea) ? { ownerArea: str(d.ownerArea) } : {}),
    a: side(d.a),
    b: side(d.b),
    p: typeof d.p === "number" ? d.p : 0,
    routedTo: str(d.routedTo) ?? OPERATOR,
    routeReason: str(d.routeReason) ?? "",
    ...(d.selfAsserted === true ? { selfAsserted: true } : {}),
    ...(batonSessionId ? { batonSessionId } : {}),
    ...(path ? { batonPath: path } : {}),
    state: d.state === "resolved" ? "resolved" : "open",
    ...(str(d.resolvedBy) ? { resolvedBy: str(d.resolvedBy) } : {}),
    ...(outcome === "a" || outcome === "b" || outcome === "both" || outcome === "neither" ? { outcome } : {}),
    createdAt: isoOr(d.createdAt),
    ...(d.resolvedAt !== undefined && d.resolvedAt !== null ? { resolvedAt: isoOr(d.resolvedAt) } : {}),
  };
}

/** This host's session files of the org's gathering sessions, by session id. */
function sessionPaths(orgId: string): Map<string, string> {
  const dir = orgDir(orgId);
  return new Map(allBatons().filter((b) => b.orgId === orgId).map((b) => [b.sessionId, sessionPathOf(dir, b)]));
}

const ofProject = (projectId: string) => (s: SessionInfo) => s.data.projectId === projectId;

/** The project's decisions, from their statecharts (none while the org's engine is closed). */
export function readDecisionStore(orgId: string, projectId: string): DecisionStore {
  if (!isOrgHostOpen(orgId)) return { decisions: [], lastRun: null };
  const host = hostOf(orgId);
  const paths = sessionPaths(orgId);
  const decisions = host.sessions("decision").filter(ofProject(projectId)).map((s) => decisionRowOf(orgId, s, paths));
  const rec = host.data(reconcilerSid(orgId, projectId)) ?? {};
  const run = isObj(rec.lastRun) ? rec.lastRun : null;
  const lastRun: ReconcileRun | null = run
    ? { at: isoOr(run.at), compared: typeof run.compared === "number" ? run.compared : 0, found: typeof run.found === "number" ? run.found : 0, ...(str(run.error) ? { error: str(run.error) } : {}) }
    : null;
  const lastPromotedSpec = latestHash(rec, host.data(placementSid(orgId, projectId))?.spec);
  return { decisions, lastRun, ...(lastPromotedSpec !== undefined ? { lastPromotedSpec } : {}) };
}

/** The spec's hash as the reconciler last left it: its last promotion's, or the freeze's when that came later. */
function latestHash(rec: Record<string, unknown>, spec: unknown): string | undefined {
  const p = isObj(rec.lastPromote) ? rec.lastPromote : null;
  const f = isObj(spec) ? spec : null;
  const pAt = typeof p?.at === "number" ? p.at : -1;
  const fAt = typeof f?.at === "number" ? f.at : -1;
  if (fAt > pAt) return str(f?.specHash);
  return p ? str(p.specHash) : undefined;
}

/** The project's conflicts, from their statecharts (a settle session's path is this host's, never stored). */
export function readConflicts(orgId: string, projectId: string): Conflict[] {
  if (!isOrgHostOpen(orgId)) return [];
  const paths = sessionPaths(orgId);
  return hostOf(orgId).sessions("conflict").filter(ofProject(projectId)).map((s) => conflictOf(orgId, s, paths));
}

// ---- keys --------------------------------------------------------------------------------------------

/** A spec ID segment: lowercase ASCII letters and single hyphens only (the § grammar allows no
    digits), accents folded, ≤ `max` characters, cut at a word boundary; "" when nothing is left. */
export function specSlug(text: string, max = 40): string {
  const words = text
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z]+/g, " ")
    .trim()
    .split(" ")
    .filter(Boolean);
  let out = "";
  for (const w of words) {
    const next = out ? `${out}-${w}` : w;
    if (next.length > max) break;
    out = next;
  }
  return out || (words[0] ?? "").slice(0, max);
}

/** The spec area a recorded area files under. */
export const areaKeyOf = (area: string): string => specSlug(area, 40) || "general";

// ---- owner areas (§app.requirements/owner-area) --------------------------------------------------------

/** The owner areas a decision may pick, "none" aside: every active person's decision areas, once
    per area key, as first spelled, in roster order. */
export function ownerAreaChoices(roster: readonly Person[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of roster)
    if (p.status === "active")
      for (const a of p.decides) {
        const k = areaKeyOf(a);
        if (seen.has(k) || k === OWNER_AREA_NONE) continue;
        seen.add(k);
        out.push(a);
      }
  return out;
}

const quoted = (xs: string[]) => xs.map((x) => `"${x}"`);
const orList = (xs: string[]) => (xs.length < 2 ? xs.join("") : `${xs.slice(0, -1).join(", ")} or ${xs.at(-1)}`);

/** An owner area as given (the model's, the operator's), against the roster as it is: a roster
    area with the same key, stored as the roster spells it, or "none"; else why not, naming every
    choice. */
export function pickOwnerArea(roster: readonly Person[], value: unknown): { ok: true; ownerArea: string } | { ok: false; error: string } {
  const choices = ownerAreaChoices(roster);
  const given = typeof value === "string" ? value.trim() : "";
  if (given) {
    const k = areaKeyOf(given);
    if (k === OWNER_AREA_NONE) return { ok: true, ownerArea: OWNER_AREA_NONE };
    const hit = choices.find((a) => areaKeyOf(a) === k);
    if (hit) return { ok: true, ownerArea: hit };
  }
  if (!choices.length) return { ok: false, error: `Give the owner area: "${OWNER_AREA_NONE}" (no one on the roster has a decision area yet).` };
  const list = orList(quoted([...choices, OWNER_AREA_NONE]));
  return { ok: false, error: given ? `"${given}" is not an owner area. Use one of: ${list}.` : `Give the owner area. Use one of: ${list}.` };
}

/** The provenance a row carries into the spec. */
export const provenanceOf = (d: DecisionRow): Provenance => ({ by: d.by, name: d.name, ...(d.nameAt ? { nameAt: d.nameAt } : {}), sessionId: d.sessionId, entryId: d.entryId, at: d.at, quote: d.quote });

/** A decision the operator states on the project page (a conflict's resolution): no transcript. */
export function operatorDecision(orgId: string, projectId: string, input: { area: string; areaKey: string; ownerArea?: string; statement: string; now?: Date; markerId: string }): DecisionRow {
  const at = (input.now ?? new Date()).toISOString();
  return {
    id: `operator:${input.markerId}`,
    orgId,
    projectId,
    area: input.area,
    areaKey: input.areaKey,
    ...(input.ownerArea ? { ownerArea: input.ownerArea } : {}),
    statement: input.statement,
    quote: input.statement,
    by: OPERATOR,
    name: operatorName(),
    at,
    sessionId: "",
    entryId: input.markerId,
    markerId: input.markerId,
    sessionPath: null,
    state: "pending",
    authorOwnsArea: true,
  };
}

/** Live = still a candidate for the spec (not superseded). */
export const isLive = (d: DecisionRow): boolean => d.state !== "superseded";

export const STATES: readonly DecisionState[] = ["pending", "drafted", "promoted", "superseded", "conflict"];

/** Open conflicts routed to the operator that no settle session asks about (routing failed, or the
    session closed without a re-route): theirs to route or settle (a Needs-you item, C17). */
export function unroutedConflicts(orgId: string, projectId: string): number {
  return unrouted(orgId, projectId).length;
}

function unrouted(orgId: string, projectId: string): SessionInfo[] {
  if (!isOrgHostOpen(orgId)) return [];
  return hostOf(orgId)
    .sessions("conflict")
    .filter(ofProject(projectId))
    .filter((s) => s.configuration.includes("unrouted") && (s.data.routedTo ?? OPERATOR) === OPERATOR);
}

/**
 * Those conflicts as Needs-you items (C17, §app.requirements/routing): decide tier, kind
 * `conflict-to-operator`, never pushed, opening the project page; one per conflict, so the org card,
 * its tab and Needs you count the same ones.
 */
export function conflictAttention(): AttentionItem[] {
  const out: AttentionItem[] = [];
  for (const o of readIndex().orgs) {
    if (!isOrgHostOpen(o.id)) continue;
    let orgName = "";
    let projects: OrgProject[] = [];
    try {
      orgName = readOrg(o.id).name;
      projects = readProjects(o.id);
    } catch {
      continue;
    }
    const names = new Map<string, string>();
    try {
      for (const p of readRoster(o.id)) names.set(p.id, p.name);
    } catch {
      // an unreadable roster: the names the decisions were recorded with
    }
    names.set(OPERATOR, operatorName());
    for (const p of projects) {
      const sessions = unrouted(o.id, p.id);
      if (!sessions.length) continue;
      const byId = new Map(readDecisionStore(o.id, p.id).decisions.map((d) => [d.id, d]));
      for (const s of sessions) {
        const c = conflictOf(o.id, s, new Map());
        const a = byId.get(c.a);
        const b = byId.get(c.b);
        const who = (d: DecisionRow | undefined) => (d ? (names.get(d.by) ?? d.name) : "someone");
        out.push({
          id: `conflict-to-operator:${c.id}`,
          path: "",
          title: p.name,
          where: orgName,
          tier: "decide",
          kind: "conflict-to-operator",
          since: Date.parse(c.createdAt) || 0,
          detail: `Settle a conflict in ${p.name}: ${who(a)} and ${who(b)} disagree about ${a?.area ?? b?.area ?? c.areaKey}.`,
          href: `#/projects/${encodeURIComponent(p.id)}`,
          org: { orgId: o.id, orgName, projectId: p.id, projectName: p.name, ...(p.archived ? { projectArchived: true as const } : {}) },
        });
      }
    }
  }
  return out;
}

// ---- a decision's quote, checked against its message ------------------------------------

/** Text as a quote is compared: case, spacing, typographic quotes and a trailing ellipsis don't count. */
export function quoteFold(t: string): string {
  return t
    .normalize("NFKC")
    .replace(/[‘’‚‛]/g, "'")
    .replace(/[“”„‟]/g, '"')
    .replace(/(?:…|\.\.\.)\s*$/, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

const WORDS = new Intl.Segmenter(undefined, { granularity: "word" });
/** What a span is made of once punctuation and spacing are taken out. */
const bare = (t: string): string => t.replace(/[\p{P}\s]+/gu, "");

/**
 * Whether a quote is a span of what the message said, on Unicode word boundaries: leaving punctuation and
 * spacing aside, it is exactly a run of the message's whole words (Intl.Segmenter's, so a CJK message without
 * spaces is words too, and an emoji is one). Any length: "Yes", "A", one word or one emoji, when that is what was
 * said. A quote of nothing but punctuation, or one that starts or ends inside a word ("pay" in "payday"), is not.
 */
export function quoteIn(quote: string, message: string): boolean {
  const q = bare(quoteFold(quote));
  if (!q) return false;
  const words = [...WORDS.segment(quoteFold(message))].map((s) => bare(s.segment)).filter(Boolean);
  for (let i = 0; i < words.length; i++) {
    let run = "";
    for (let j = i; j < words.length && q.startsWith(run + words[j]!); j++) {
      run += words[j]!;
      if (run === q) return true;
    }
  }
  return false;
}

/** The nearest user message up the tree from `from` (the decision's marker), at most 200 entries up:
    where the quote was said (quoteEntryOf's rule, over the whole file so a marker off the branch is read too). */
export function nearestUserEntry(byId: ReadonlyMap<string, HEntry>, from: string): HEntry | null {
  let cur = byId.get(from);
  for (let hops = 0; cur && hops < 200; hops++) {
    if (cur.kind === "user" && cur.id) return cur;
    cur = cur.parentId ? byId.get(cur.parentId) : undefined;
  }
  return null;
}

/** The entries from the root to `to`, by parent. */
function pathTo(byId: ReadonlyMap<string, HEntry>, to: string): HEntry[] {
  const out: HEntry[] = [];
  const seen = new Set<string>();
  let cur = byId.get(to);
  while (cur?.id && !seen.has(cur.id)) {
    seen.add(cur.id);
    out.push(cur);
    cur = cur.parentId ? byId.get(cur.parentId) : undefined;
  }
  return out.reverse();
}

/**
 * A decision's quote checked against the message it cites, through the neutral reader: `checked` only when
 * its words are in that message and the message's sender, as its own sender marker records it, is the
 * person the decision names; `unchecked` when no marker recorded the sender; else which it is. Pure.
 */
export function quoteCheckOf(byId: ReadonlyMap<string, HEntry>, input: { markerId: string; entryId: string; quote: string; by: string }): QuoteCheck {
  const entry = byId.get(input.entryId);
  if (!entry || entry.kind !== "user") return "source-unavailable";
  if (!quoteIn(input.quote, joinedText(entry, { images: false }))) return "quote-not-found";
  // the sender as the message's own sender marker records it, on the branch up to the decision's marker; never
  // filled in from the decision's claimed author or the holder: a message whose marker was never written (a stop
  // between the message and its marker) has no recorded sender, so its quote is not checked
  const branch = pathTo(byId, byId.has(input.markerId) ? input.markerId : input.entryId);
  const sender = messageSenders(branch, null).get(input.entryId);
  if (!sender) return "unchecked";
  return sender === input.by ? "checked" : "speaker-mismatch";
}

/** Why a quote found in its message is still not checked: nothing recorded who sent that message. */
export const SENDER_NOT_RECORDED = "The message's sender wasn't recorded.";

/** Who a decision names as its decider, as a history actor. */
export const deciderRef = (by: string): ActorRef => (by === OPERATOR ? { kind: "operator" } : { kind: "person", id: by });

/** The history provenance of a recorded decision: its decider (the person only when the quote checks), its
    recorder (the model), its quote as evidence, and its words as the private rationale. */
export function decisionProvenance(input: {
  decisionId: string;
  sessionId: string;
  entryId: string;
  by: string;
  statement: string;
  quote: string;
  check: QuoteCheck;
  disposition?: DecisionDisposition;
}) {
  const checked = input.check === "checked";
  const evidence: EvidenceRef[] = [
    {
      n: 1,
      kind: "transcript",
      session: input.sessionId,
      entry: input.entryId,
      check: input.check,
      ...(checked ? { speaker: deciderRef(input.by) } : {}),
      ...(input.check === "unchecked" ? { why: SENDER_NOT_RECORDED } : {}),
    },
  ];
  const d = input.disposition;
  const outcome = d ? ({ choose: "chosen", reject: "rejected", defer: "deferred", "do-not-do": "do-not-do" } as const)[d.disposition] : undefined;
  return {
    sourceKey: `decision:${input.decisionId}`,
    actors: {
      // A quote that doesn't check stays the model's.
      decidedBy: checked ? deciderRef(input.by) : ({ kind: "model", session: input.sessionId } as ActorRef),
      recordedBy: { kind: "model", session: input.sessionId } as ActorRef,
      executedBy: { kind: "sova" } as ActorRef,
      authorization: checked ? { kind: "person-decision" as const, by: deciderRef(input.by) } : { kind: "none" as const },
    },
    evidence,
    ...(outcome ? { outcome } : {}),
    ...(d
      ? {
          decision: {
            disposition: d.disposition,
            options: (d.options ?? []).map((o) => ({ id: o.id, outcome: o.outcome })),
            authority: checked ? deciderRef(input.by) : ({ unknown: true, why: "The quote is not checked." } as const),
            ...(d.reviewAt ? { reviewAt: d.reviewAt } : {}),
          },
        }
      : {}),
    rationale: {
      what: input.statement,
      quotes: [{ n: 1, text: input.quote }],
      ...(d?.reason ? { reason: { text: d.reason, author: { kind: "model", session: input.sessionId } as ActorRef, contemporaneous: true } } : {}),
      ...(d?.options?.length ? { options: d.options.map((o) => ({ id: o.id, label: o.label, ...(o.reason ? { reason: o.reason } : {}) })) } : {}),
    },
  };
}

/** A decision's disposition as record_decision takes it. */
export interface DecisionDisposition {
  disposition: "choose" | "reject" | "defer" | "do-not-do";
  options?: { id: string; label: string; outcome: "selected" | "rejected" | "deferred" | "do-not-do"; reason?: string }[];
  reason?: string;
  /** For defer: the condition's words, and the date to look again (ms). */
  review?: string;
  reviewAt?: number;
}

// ---- a marker with no decision ------------------------------------------------------

/** A decision marker the recovery couldn't turn into a decision: said, never dropped silently. */
export interface MarkerProblem {
  sessionId: string;
  markerId: string;
  why: string;
  /** The Workspace tab's sentence for it. */
  sentence: string;
}

const markerProblems = new Map<string, MarkerProblem[]>();

/** The markers of `orgId` that have no decision and couldn't get one at the last open. */
export const decisionMarkerProblems = (orgId: string): MarkerProblem[] => markerProblems.get(orgId) ?? [];

/** Every decision marker in a gathering's file, with its decision id and the message its quote cites. */
export function decisionMarkersOf(sessionId: string, entries: readonly HEntry[]): { decisionId: string; markerId: string; entryId: string; data: BatonDecisionData }[] {
  const byId = new Map<string, HEntry>();
  for (const h of entries) if (h.id) byId.set(h.id, h);
  const out = [];
  for (const h of entries) {
    if (h.kind !== "state" || h.key !== BATON_DECISION_ENTRY || !h.id) continue;
    const data = h.data as BatonDecisionData | null;
    if (!data || typeof data.area !== "string" || typeof data.statement !== "string" || typeof data.quote !== "string") continue;
    out.push({ decisionId: `${sessionId}:${h.id}`, markerId: h.id, entryId: nearestUserEntry(byId, h.id)?.id ?? h.id, data });
  }
  return out;
}

/**
 * Crash recovery: record_decision writes its marker before the act that records the decision, so a server
 * that stopped between the two left a marker with no decision statechart. Each one gets its decision now,
 * through the same act and the same decision id (so it is recorded once, under the same history key), its
 * quote checked again against its message. One the statechart refuses is a problem the org says, never a drop.
 * Runs as the org's engine opens (server/orgs.ts), before any route can list the decisions. Returns the decisions recovered.
 */
export function recoverDecisionMarkers(host: OrgHostApi, orgId: string, dir: string = orgDir(orgId)): string[] {
  const problems: MarkerProblem[] = [];
  const recovered: string[] = [];
  let ownerAreas: string[] = [];
  // null: an unreadable roster, where who took part is left to the participants check and the statechart
  let rosterIds: Set<string> | null = null;
  try {
    const roster = readRoster(orgId);
    ownerAreas = ownerAreaChoices(roster);
    rosterIds = new Set(roster.map((p) => p.id));
  } catch {
    // an unreadable roster: only "none" is a valid owner area, and the statechart says so per marker
  }
  for (const s of host.sessions("baton")) {
    const sessionId = typeof s.data.sessionId === "string" ? s.data.sessionId : "";
    const projectId = typeof s.data.projectId === "string" ? s.data.projectId : "";
    if (!sessionId || !projectId) continue;
    const rel = batonFileOf(dir, sessionId);
    if (!rel) continue;
    let entries: HEntry[];
    try {
      entries = parsePi(readFileSync(join(dir, rel), "utf8")).entries;
    } catch {
      continue;
    }
    const markers = decisionMarkersOf(sessionId, entries);
    if (!markers.length) continue;
    const byId = new Map<string, HEntry>();
    for (const h of entries) if (h.id) byId.set(h.id, h);
    const title = typeof s.data.publicTitle === "string" && s.data.publicTitle ? s.data.publicTitle : sessionId;
    const problem = (markerId: string, why: string, tail: string) => problems.push({ sessionId, markerId, why, sentence: `A decision recorded in ${title} couldn't be recovered: ${tail}` });
    const bsid = batonSid(orgId, sessionId);
    for (const m of markers) {
      if (host.statechartOf(decisionSid(orgId, projectId, m.decisionId))) continue;
      // An author the marker doesn't name, or names as no one known, is never taken to be the operator: not recovered, said.
      const by = typeof m.data.by === "string" ? m.data.by : "";
      if (!by || (by !== OPERATOR && rosterIds && !rosterIds.has(by))) {
        problem(m.markerId, `The marker's author is ${by ? `not a known person (${by})` : "not recorded"}.`, "its author wasn't recorded.");
        continue;
      }
      // the name the marker kept, else today's label (an older marker kept none, and none is made up for it)
      const who = (typeof m.data.name === "string" && m.data.name) || (by === OPERATOR ? operatorName() : (nameIn(orgId, by) ?? by));
      const check = quoteCheckOf(byId, { markerId: m.markerId, entryId: m.entryId, quote: m.data.quote, by });
      const payload = {
        decisionId: m.decisionId,
        area: m.data.area,
        areaKey: areaKeyOf(m.data.area),
        ownerArea: m.data.ownerArea ?? OWNER_AREA_NONE,
        statement: m.data.statement,
        quote: m.data.quote,
        entryId: m.entryId,
        markerId: m.markerId,
        ownerAreas,
        // The guarded recovery (baton.cljc rb/recovery-by): Sova's own act, with the marker's author kept.
        recovery: true,
        recoveryBy: by,
        // the name the marker kept when it was written (an older marker kept none: the statechart says so)
        ...(typeof m.data.name === "string" && m.data.name ? { recoveryName: m.data.name } : {}),
      };
      const disposition = m.data.disposition ? (m.data as DecisionDisposition) : undefined;
      const provenance = decisionProvenance({ decisionId: m.decisionId, sessionId, entryId: m.entryId, by, statement: m.data.statement, quote: m.data.quote, check, disposition });
      try {
        const envelope = envelopeFor(orgId, projectId, { by: "system", attended: false });
        // Asked first: a recovery the statechart refuses is only said, never stepped, so it never becomes a
        // refusal in the history again at every start.
        const refused = host.explain(bsid, "baton/record-decision", payload, envelope);
        if (refused) {
          problem(m.markerId, refused.sentence, refused.sentence === NOT_PART ? `${who} isn't part of that conversation.` : refused.sentence);
          continue;
        }
        const out = host.actNow(bsid, "baton/record-decision", payload, envelope, { provenance: {
          ...provenance,
          actors: { ...provenance.actors, initiatedBy: { unknown: true, why: "Recovered at start: the call that wrote the marker stopped before recording it." } },
        } });
        if (!out.taken) {
          const why = out.refusal?.sentence ?? "The decision could not be recorded.";
          problem(m.markerId, why, why === NOT_PART ? `${who} isn't part of that conversation.` : why);
          continue;
        }
        recovered.push(m.decisionId);
      } catch (err) {
        const why = err instanceof Error ? err.message : String(err);
        problem(m.markerId, why, why);
      }
    }
  }
  markerProblems.set(orgId, problems);
  for (const p of problems) console.warn(`[decisions] ${orgId}: decision marker ${p.sessionId}:${p.markerId}: ${p.why}`);
  return recovered;
}

/** The statechart's refusal of a recovery whose author didn't take part (rules/baton.cljc recovery-refusal). */
const NOT_PART = "Not recovered: the person who decided isn't part of this conversation.";

/** A person's name on the roster, or null. */
function nameIn(orgId: string, personId: string): string | null {
  try {
    return readRoster(orgId).find((p) => p.id === personId)?.name ?? null;
  } catch {
    return null;
  }
}

// The Workspace tab lists a marker that couldn't be recovered (never dropped silently).
addWorkspaceProblems((orgId) => decisionMarkerProblems(orgId).map((p) => p.sentence));
