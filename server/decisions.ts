import { OPERATOR } from "../shared/baton";
import { OWNER_AREA_NONE, type Conflict, type DecisionRow, type DecisionState, type OwnerAreaChange, type Provenance, type ReconcileRun } from "../shared/decisions";
import type { OrgProject, Person } from "../shared/orgs";
import type { AttentionItem } from "../shared/protocol";
import { allBatons, sessionPathOf } from "./baton";
import { hostOf, isOrgHostOpen, type SessionInfo } from "./org-engine";
import { isoOf, operatorName, orgDir, OrgError, readIndex, readOrg, readProjects, readRoster } from "./orgs";

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
  const lastPromotedSpec = latestHash(rec, host.data(`project/${orgId}/${projectId}`)?.spec);
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
export const provenanceOf = (d: DecisionRow): Provenance => ({ by: d.by, name: d.name, sessionId: d.sessionId, entryId: d.entryId, at: d.at, quote: d.quote });

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
          href: `#/orgs/${encodeURIComponent(o.id)}/projects/${encodeURIComponent(p.id)}`,
          org: { orgId: o.id, orgName, projectId: p.id, projectName: p.name, ...(p.archived ? { projectArchived: true as const } : {}) },
        });
      }
    }
  }
  return out;
}
