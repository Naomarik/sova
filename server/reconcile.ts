import { createHash, randomUUID } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { OPERATOR, type BatonOwner } from "../shared/baton";
import {
  CONFLICT_P,
  OWNER_AREA_NONE,
  RECONCILE_DEFAULT,
  RECONCILE_OFF,
  REQUIREMENTS_NS,
  foldedRows,
  type Conflict,
  type ConflictResolveInput,
  type DecisionRow,
  type DecisionsInfo,
  type PromoteCommit,
  type PromoteResult,
  type SpecStatus,
} from "../shared/decisions";
import type { Person } from "../shared/orgs";
import { namesOf, offHoursOf, targetOfPerson } from "./baton";
import { commitSpec, specSnapshot } from "./project-worktrees";
import { projectOverseerPaths, readPoSettings } from "./project-overseer-store";
import type { CostStarter } from "../shared/costs";
import { DecisionError, type DecisionProvider, type DecisionResult, type Question } from "./decide";
import { appendUsage, ledgerPaths } from "./project-costs-ledger";
import { isExcluded } from "./decide-settings";
import {
  areaKeyOf,
  conflictSid,
  decisionSid,
  isLive,
  operatorDecision,
  ownerAreaChoices,
  pickOwnerArea,
  projectOf,
  projectOf as projectRow,
  readConflicts,
  readDecisionStore,
  reconcilerSid,
  type DecisionStore,
} from "./decisions";
import { heldAt, hostOf, isOrgHostOpen, onOrgHostOpened, refusalError, type ActResult, type Effect, type OrgHostApi } from "./org-engine";
import type { Envelope } from "./org-envelope";
import { envelopeFor } from "./org-engine";
import { withUsageContext } from "../pi-config/extensions/llm-inflight/attribution.ts";
import { operatorEnvelope, operatorName, OrgError, placementSid, readHistory, readProjects, readRoster, shortId } from "./orgs";
import {
  PROJECT_DRAFT,
  areaId,
  currentClaims,
  currentBlock,
  currentRecordIds,
  decisionPart,
  manifestRecord,
  proseHash,
  renderRecord,
  projectDraftExists,
  promoteEdit,
  recordIdOf,
  recordSlug,
  specDirOf,
  specExists,
  SpecToolError,
  writeProjectDraft,
  type SpecEdit,
} from "./spec-draft-writer";

/**
 * The reconciler (§app.requirements/reconciler, /promotion). Per project:
 *
 * 1. Sync the decision index from the transcripts (server/decisions.ts).
 * 2. Settle routed conflicts: a decision recorded in a conflict's baton session is its resolution;
 *    the decide seam says which side it keeps, and the loser is superseded by it.
 * 3. File each new decision under an existing area when it belongs there (decide: choice).
 * 4. Compare every unchecked pair of live decisions in one area (decide: boolean, "do these
 *    contradict?"); p ≥ CONFLICT_P is a conflict, routed to the roster person who decides that
 *    area (not either author when someone else does), else to the operator. A `decides` entry the
 *    operator did not write is self-asserted and routes to the operator. Routing = a baton session
 *    to that person, owned by the operator or the project overseer.
 * 5. Every decision compared clean with its whole area is `drafted`: written into the project's
 *    draft. Promotion is separate and explicit (promoteDecisions).
 *
 * The decide seam gets decision text only (statements, quotes, names, areas), never a transcript;
 * a project whose root is in Settings → Decisions' excluded folders is never sent.
 */

export interface ReconcileDeps {
  provider: () => DecisionProvider | null;
  /** Settings → Decisions exclusions for the project root. */
  excluded: (root: string) => boolean;
  /** Settings → Decisions "Reconcile decisions". */
  enabled: () => boolean;
  now: () => Date;
}

async function defaultProvider(): Promise<Pick<ReconcileDeps, "excluded" | "enabled"> & { provider: DecisionProvider | null }> {
  const rt = await import("./decide-runtime");
  return {
    provider: rt.decisionsReady() ? rt.decisions() : null,
    excluded: (root) => isExcluded(rt.decisionSettings(), root),
    enabled: () => rt.decisionSettings().features.reconcile ?? RECONCILE_DEFAULT,
  };
}

let deps: ReconcileDeps | null = null;
/** Tests replace the provider and the clock. */
export function setReconcileDeps(d: Partial<ReconcileDeps> | null): void {
  deps = d === null ? null : { ...baseDeps(), ...d };
}
function baseDeps(): ReconcileDeps {
  return {
    provider: () => null,
    excluded: () => false,
    enabled: () => true,
    now: () => new Date(),
  };
}
async function currentDeps(): Promise<ReconcileDeps> {
  if (deps) return deps;
  const live = await defaultProvider();
  return { ...baseDeps(), provider: () => live.provider, excluded: live.excluded, enabled: live.enabled };
}

// ---- the statecharts ------------------------------------------------------------------------------------------

/** Send an act; a refusal throws as the route answers it. */
async function act(orgId: string, sid: string, event: string, payload: Record<string, unknown>, envelope: Envelope): Promise<ActResult> {
  const out = await hostOf(orgId).act(sid, event, payload, envelope, { settle: true });
  if (!out.taken) throw refusalError(out.refusal ?? { sentence: "That can't be done now." });
  return out;
}

/** Whether the project's reconciler is comparing now (or waits to: a settle session's 2 s). */
function runningNow(orgId: string, projectId: string): boolean {
  if (!isOrgHostOpen(orgId)) return false;
  const conf = hostOf(orgId).configuration(reconcilerSid(orgId, projectId)) ?? [];
  return conf.includes("running") || conf.includes("debouncing");
}

/** Wait until the reconciler's run (and any it queued behind itself) ended. */
async function runEnded(orgId: string, projectId: string, ms = 30 * 60_000): Promise<void> {
  const end = Date.now() + ms;
  while (runningNow(orgId, projectId) && Date.now() < end) await new Promise((r) => setTimeout(r, 20));
}

/** Who asks: the operator (their page, or the global Overseer for them), the project overseer, or Sova. */
export type Asker = "operator" | "overseer" | "sova";
function envelopeOf(orgId: string, projectId: string, by: Asker, attended = true): Envelope {
  return by === "operator" ? operatorEnvelope(orgId, projectId) : envelopeFor(orgId, projectId, { by, attended: by === "sova" ? false : attended });
}

// ---- state --------------------------------------------------------------------------------------------------

const openConflictOf = (conflicts: Conflict[], id: string): Conflict | undefined => conflicts.find((c) => c.state === "open" && (c.a === id || c.b === id));
const pairKey = (x: string, y: string) => (x < y ? `${x}\n${y}` : `${y}\n${x}`);
const checked = (x: DecisionRow, y: DecisionRow) => !!x.checkedWith?.includes(y.id) || !!y.checkedWith?.includes(x.id);
const markChecked = (x: DecisionRow, y: DecisionRow) => {
  x.checkedWith = [...new Set([...(x.checkedWith ?? []), y.id])];
  y.checkedWith = [...new Set([...(y.checkedWith ?? []), x.id])];
};

/** Whether the current spec still has a promoted row's record as the decisions layer would write
    it: only the fields it owns are compared (§app.requirements/decisions), so a builder's
    `evidence`, `code` or relabel never makes it promotable again. */
function upToDate(d: DecisionRow, byId: Map<string, DecisionRow>, current: Record<string, unknown>): boolean {
  if (!d.recordId || !(d.recordId in current)) return false;
  const also = foldedRows(d, byId);
  if (JSON.stringify(decisionPart(current[d.recordId])) !== JSON.stringify(decisionPart(manifestRecord(d, undefined, also)))) return false;
  // Every promoted decision it replaced must say so in the spec, too.
  for (const s of byId.values())
    if (s.supersededBy === d.id && s.promotedAt && s.recordId && s.recordId in current) {
      const rec = current[s.recordId] as { supersededBy?: string } | undefined;
      if (rec?.supersededBy !== d.recordId) return false;
    }
  return true;
}

/**
 * Recompute every row's state from the facts: superseded, in an open conflict, promoted (and the
 * current spec still says what it should; else it is `drafted` again: re-promotable), compared
 * clean with its whole area by a successful run (`drafted`), else `pending`.
 */
/**
 * Who may decide an area of a project: the active people whose `decides` names it (explicit
 * owners), else the project's main stakeholder while they are active (they own every area no one
 * else on the roster decides), else nobody (the operator). Pure over the roster.
 */
export function ownersOf(roster: Person[], areaKey: string, stakeholder?: string | null): { owners: Person[]; via: "decides" | "stakeholder" | null } {
  const explicit = roster.filter((p) => p.status === "active" && p.decides.some((x) => areaKeyOf(x) === areaKey));
  if (explicit.length) return { owners: explicit, via: "decides" };
  const main = stakeholder ? roster.find((p) => p.id === stakeholder && p.status === "active") : undefined;
  return main ? { owners: [main], via: "stakeholder" } : { owners: [], via: null };
}

/** The main stakeholder alone (while active): who decides a decision whose owner area is "none". */
function stakeholderOnly(roster: Person[], stakeholder?: string | null): { owners: Person[]; via: "stakeholder" | null } {
  const main = stakeholder ? roster.find((p) => p.id === stakeholder && p.status === "active") : undefined;
  return main ? { owners: [main], via: "stakeholder" } : { owners: [], via: null };
}

/** The area key whose owners decide (§app.requirements/owner-area): the owner area's, null for
    "none", else (recorded before owner areas) the topic's. */
const authorityKey = (ownerArea: string | undefined, areaKey: string): string | null =>
  ownerArea === undefined ? areaKey : areaKeyOf(ownerArea) === OWNER_AREA_NONE ? null : areaKeyOf(ownerArea);

const ownersFor = (roster: Person[], key: string | null, stakeholder?: string | null) => (key === null ? stakeholderOnly(roster, stakeholder) : ownersOf(roster, key, stakeholder));

/** Whether the author may decide the row: the operator; an active person whose operator-set
    `decides` covers its owner area (else, for a decision recorded before owner areas, its topic
    area; a self-asserted say does not count); or the project's main stakeholder, in an area no one
    on the roster decides or for an owner area of "none". */
export function authorOwnsArea(orgId: string, roster: Person[], d: Pick<DecisionRow, "by" | "areaKey" | "ownerArea">, trusted = decidesTrusted, stakeholder?: string | null): boolean {
  if (d.by === OPERATOR) return true;
  const key = authorityKey(d.ownerArea, d.areaKey);
  const { owners, via } = ownersFor(roster, key, stakeholder);
  const p = owners.find((x) => x.id === d.by);
  if (!p) return false;
  return via === "stakeholder" || trusted(orgId, p, key!);
}

/** A conflict's owner area: the one its sides name (one side's when the other was recorded before
    owner areas); two different ones are `differ`; none named, nothing. */
export function ownerAreaOfPair(x: Pick<DecisionRow, "ownerArea">, y: Pick<DecisionRow, "ownerArea">): { ownerArea?: string; differ?: [string, string] } {
  const a = x.ownerArea;
  const b = y.ownerArea;
  if (a === undefined) return b === undefined ? {} : { ownerArea: b };
  if (b === undefined) return { ownerArea: a };
  return areaKeyOf(a) === areaKeyOf(b) ? { ownerArea: a } : { differ: [a, b] };
}

function settleStates(store: DecisionStore, conflicts: Conflict[], root?: string, orgId?: string, stakeholder?: string | null): void {
  if (orgId) {
    const roster = readRoster(orgId);
    for (const d of store.decisions) d.authorOwnsArea = authorOwnsArea(orgId, roster, d, decidesTrusted, stakeholder);
  }
  const live = store.decisions.filter((d) => !d.supersededBy);
  const byId = new Map(store.decisions.map((d) => [d.id, d]));
  const current = root ? currentClaims(root) : null;
  for (const d of store.decisions) {
    if (d.supersededBy) d.state = "superseded";
    else if (openConflictOf(conflicts, d.id)) d.state = "conflict";
    else if (d.promotedAt) d.state = current && !upToDate(d, byId, current) ? "drafted" : "promoted";
    else {
      // Never seen by a successful run (checkedWith unset): its area isn't filed yet.
      const peers = live.filter((o) => o.id !== d.id && o.areaKey === d.areaKey);
      d.state = d.checkedWith && peers.every((o) => checked(d, o)) ? "drafted" : "pending";
    }
    delete d.editedInSpec;
    delete d.build;
    if (d.state === "promoted" && root && current && d.recordId) {
      if (proseHash(currentBlock(root, d.recordId) ?? "") !== expectedText(d, byId)) d.editedInSpec = true;
      d.build = builtOf(current[d.recordId]) ? "built" : "not-built";
    }
  }
}

/** The prose hash a promoted row's record should have: as promoted or kept, else (promoted before
    that was recorded) as the reconciler writes it. */
const expectedText = (d: DecisionRow, byId: Map<string, DecisionRow>): string => d.promotedText ?? proseHash(renderRecord(d, undefined, foldedRows(d, byId)));

/** Built, as the spec layer recorded it: `code` paths and `evidence` reviewed or verified. */
function builtOf(rec: unknown): boolean {
  const r = (rec ?? {}) as { code?: unknown; evidence?: unknown };
  return Array.isArray(r.code) && r.code.length > 0 && (r.evidence === "reviewed" || r.evidence === "verified");
}

/** Give every drafted row a record id, unique in the current spec and among the rows. */
function assignRecordIds(root: string, store: DecisionStore): void {
  const taken = new Map<string, Set<string>>();
  const slugsOf = (areaKey: string) => {
    let s = taken.get(areaKey);
    if (!s) {
      s = new Set<string>();
      const prefix = `§${REQUIREMENTS_NS}.${areaKey}/`;
      for (const id of currentRecordIds(root)) if (id.startsWith(prefix)) s.add(id.slice(prefix.length));
      for (const d of store.decisions) if (d.recordId?.startsWith(prefix)) s.add(d.recordId.slice(prefix.length));
      taken.set(areaKey, s);
    }
    return s;
  };
  for (const d of store.decisions) {
    if (d.recordId || d.state !== "drafted") continue;
    const s = slugsOf(d.areaKey);
    const slug = recordSlug(d.statement, s);
    s.add(slug);
    d.recordId = recordIdOf(d.areaKey, slug);
  }
}

// ---- spec status ------------------------------------------------------------------------------------------

/** SHA-256 over the current spec's manifest and claims (paths + bytes), "" when there is none. */
export function specHash(root: string): string {
  const dir = specDirOf(root);
  if (!existsSync(join(dir, "manifest.json"))) return "";
  const h = createHash("sha256");
  const walk = (rel: string) => {
    const abs = join(dir, rel);
    let st;
    try {
      st = statSync(abs);
    } catch {
      return;
    }
    if (st.isDirectory()) for (const n of readdirSync(abs).sort()) walk(join(rel, n));
    else if (st.isFile()) h.update(`${rel}\0`).update(readFileSync(abs)).update("\0");
  };
  walk("manifest.json");
  walk("claims");
  return h.digest("hex");
}

function specStatus(orgId: string, projectId: string, store: DecisionStore): SpecStatus {
  const project = projectOf(orgId, projectId);
  const root = project.root;
  const current = currentRecordIds(root);
  const frozen = !!(project as { spec?: { frozen?: boolean } }).spec?.frozen;
  const last = store.lastPromotedSpec;
  return {
    specRoot: specDirOf(root),
    exists: specExists(root),
    frozen,
    draft: projectDraftExists(root) ? PROJECT_DRAFT : null,
    promoted: [...current].filter((id) => id.startsWith(`§${REQUIREMENTS_NS}.`)).length,
    drafted: store.decisions.filter((d) => d.state === "drafted").length,
    built: store.decisions.filter((d) => d.state === "promoted" && d.build === "built").length,
    notBuilt: store.decisions.filter((d) => d.state === "promoted" && d.build === "not-built").length,
    ...(frozen && last !== undefined ? { editedOutside: specHash(root) !== last } : {}),
  };
}

function info(orgId: string, projectId: string, store: DecisionStore, conflicts: Conflict[]): DecisionsInfo {
  return {
    decisions: [...store.decisions].sort((a, b) => b.at.localeCompare(a.at)),
    conflicts: [...conflicts].sort((a, b) => (a.state === b.state ? b.createdAt.localeCompare(a.createdAt) : a.state === "open" ? -1 : 1)),
    spec: specStatus(orgId, projectId, store),
    lastRun: store.lastRun,
    running: runningNow(orgId, projectId),
    names: namesOf(orgId),
    ownerAreas: ownerAreaChoices(readRoster(orgId)),
  };
}

/**
 * The spec's facts about each promoted decision (its record there, its owned fields, its prose, its
 * build), as the current spec says them: sent to each decision whose facts changed (C16), so a record
 * that went missing or differs makes it promotable again. Returns whether any was sent.
 */
async function syncSpecFacts(orgId: string, projectId: string): Promise<void> {
  const project = projectOf(orgId, projectId);
  const root = project.root;
  const store = readDecisionStore(orgId, projectId);
  const byId = new Map(store.decisions.map((d) => [d.id, d]));
  const current = currentClaims(root);
  const host = hostOf(orgId);
  const roster = readRoster(orgId);
  // Who may decide each one follows the roster and the main stakeholder as they are now (the promotion's check reads it).
  for (const d of store.decisions) {
    const owns = authorOwnsArea(orgId, roster, d, decidesTrusted, project.stakeholder);
    // A promoted one is past its promotion's check.
    if (owns === d.authorOwnsArea || d.state === "superseded" || d.promotedAt) continue;
    await host.act(decisionSid(orgId, projectId, d.id), "reconcile/result", { state: d.state, authorOwnsArea: owns }, envelopeFor(orgId, projectId, { by: "system", attended: false }), { settle: true });
  }
  for (const d of store.decisions) {
    if (!d.promotedAt || d.supersededBy) continue;
    const facts = specFactsOf(root, d, byId, current);
    const data = host.data(decisionSid(orgId, projectId, d.id)) ?? {};
    if ((Object.keys(facts) as (keyof typeof facts)[]).every((k) => data[k] === facts[k])) continue;
    await host.act(decisionSid(orgId, projectId, d.id), "spec/facts", facts, envelopeFor(orgId, projectId, { by: "system", attended: false }), { settle: true });
  }
}

function specFactsOf(root: string, d: DecisionRow, byId: Map<string, DecisionRow>, current: Record<string, unknown>): { recordPresent: boolean; fieldsMatch: boolean; editedInSpec: boolean; build: "built" | "not-built" } {
  const present = !!d.recordId && d.recordId in current;
  return {
    recordPresent: present,
    fieldsMatch: present && upToDate(d, byId, current),
    editedInSpec: present && proseHash(currentBlock(root, d.recordId!) ?? "") !== expectedText(d, byId),
    build: present && builtOf(current[d.recordId!]) ? "built" : "not-built",
  };
}

/** GET …/decisions: the statecharts' rows; the spec's facts about the promoted ones are brought up to date after. */
export function listDecisions(orgId: string, projectId: string): DecisionsInfo {
  const project = projectOf(orgId, projectId);
  const store = readDecisionStore(orgId, projectId);
  const conflicts = readConflicts(orgId, projectId);
  // What the spec and the roster say now, on this read (the statecharts hear it right after).
  const roster = readRoster(orgId);
  for (const d of store.decisions) d.authorOwnsArea = authorOwnsArea(orgId, roster, d, decidesTrusted, project.stakeholder);
  const byId = new Map(store.decisions.map((d) => [d.id, d]));
  const current = store.decisions.some((d) => d.promotedAt) ? currentClaims(project.root) : {};
  for (const d of store.decisions) {
    if (!d.promotedAt || d.supersededBy || d.state === "conflict") continue;
    const f = specFactsOf(project.root, d, byId, current);
    d.state = f.recordPresent && f.fieldsMatch ? "promoted" : "drafted";
    if (d.state === "promoted") {
      d.build = f.build;
      if (f.editedInSpec) d.editedInSpec = true;
      else delete d.editedInSpec;
    } else {
      delete d.build;
      delete d.editedInSpec;
    }
  }
  if (isOrgHostOpen(orgId)) void syncSpecFacts(orgId, projectId).catch((err) => console.warn(`[reconcile] spec facts ${orgId}/${projectId}: ${err instanceof Error ? err.message : String(err)}`));
  return info(orgId, projectId, store, conflicts);
}

export function specStatusOf(orgId: string, projectId: string): SpecStatus {
  return specStatus(orgId, projectId, readDecisionStore(orgId, projectId));
}

/** PATCH …/spec {frozen}: the placement statechart's spec/freeze, with the spec's hash when it freezes (the frozen check). */
export async function setFrozen(orgId: string, projectId: string, frozen: boolean): Promise<SpecStatus> {
  const project = projectOf(orgId, projectId);
  await act(orgId, placementSid(orgId, projectId), "spec/freeze", { frozen, ...(frozen ? { specHash: specHash(project.root) } : {}) }, operatorEnvelope(orgId, projectId));
  return specStatus(orgId, projectId, readDecisionStore(orgId, projectId));
}

// ---- decide questions ------------------------------------------------------------------------------------

const clipText = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const brief = (d: DecisionRow) => ({ statement: clipText(d.statement, 500), quote: clipText(d.quote, 600), by: d.name, at: d.at.slice(0, 10) });

/** One pair, classified: a contradiction needs the SAME question answered differently; the same
    rule said twice is a restatement; anything else (another subject in the same area, a detail
    added) is neither. Three options, so "different subject" is a real answer, not a low "yes". */
const CLASSIFY: (x: string, y: string) => Question = (x, y) => ({
  type: "choice",
  instructions:
    `Compare decisions ${x} and ${y}. First name the single question each one answers (for example "who approves invoices over what amount?" or "which weekday are payments made?"). ` +
    `Only if both answer the SAME question can they conflict or be the same.`,
  options: {
    conflict: "Both answer the same question, with incompatible answers (a team could not follow both).",
    same: "Both state the same rule (a restatement or confirmation, possibly worded differently).",
    different: "They answer different questions, or one only adds a detail the other does not settle.",
  },
});

const PAIRS_PER_REQUEST = 12;

/** A pair's answer: P(contradiction) and P(same rule restated). */
export interface PairVerdict {
  conflict: number;
  same: number;
}

async function askPairs(provider: DecisionProvider, areaKey: string, area: string, pairs: [DecisionRow, DecisionRow][], dedupe: string): Promise<PairVerdict[]> {
  const out: PairVerdict[] = [];
  for (let i = 0; i < pairs.length; i += PAIRS_PER_REQUEST) {
    const chunk = pairs.slice(i, i + PAIRS_PER_REQUEST);
    const label = new Map<string, string>();
    const decisions: Record<string, ReturnType<typeof brief>> = {};
    for (const [x, y] of chunk)
      for (const d of [x, y])
        if (!label.has(d.id)) {
          const l = `D${label.size + 1}`;
          label.set(d.id, l);
          decisions[l] = brief(d);
        }
    const questions: Record<string, Question> = {};
    chunk.forEach(([x, y], j) => (questions[`pair${j + 1}`] = CLASSIFY(label.get(x.id)!, label.get(y.id)!)));
    const r = await provider.decide({ purpose: "reconcile", state: { area: area || areaKey, decisions }, questions, dedupeKey: `${dedupe}:${areaKey}:${i}` });
    chunk.forEach((_, j) => {
      const a = r.answers[`pair${j + 1}`];
      out.push(a?.type === "choice" ? { conflict: a.probabilities.conflict ?? 0, same: a.probabilities.same ?? 0 } : { conflict: 0, same: 0 });
    });
  }
  return out;
}

/** The same words: one author saying one rule twice needs no model to tell. */
const sameWords = (x: DecisionRow, y: DecisionRow) => {
  const n = (t: string) => t.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  return n(x.statement) === n(y.statement);
};

/** Where a superseded decision's line ends now (the live decision that replaced it, transitively). */
function finalWinner(d: DecisionRow, byId: Map<string, DecisionRow>): DecisionRow | undefined {
  let cur: DecisionRow | undefined = d;
  for (let n = 0; n < 50 && cur?.supersededBy; n++) cur = byId.get(cur.supersededBy);
  return cur && !cur.supersededBy ? cur : undefined;
}

/** `later` says `first` again: it joins `first`'s record (no second one) and shares its fate. */
function fold(first: DecisionRow, later: DecisionRow, byId: Map<string, DecisionRow>): void {
  if (first.supersededBy && finalWinner(first, byId) === later) return markChecked(first, later);
  first.folded = [...new Set([...(first.folded ?? []), later.id])];
  // A restatement of a superseded rule is superseded with it, by what replaced it.
  later.supersededBy = first.supersededBy ? (finalWinner(first, byId)?.id ?? first.supersededBy) : first.id;
  markChecked(first, later);
}

/** Same subject by wording alone: every word of one key is in the other ("payroll-export" ⊂ "payroll-export-format"). */
const FILLER = new Set(["the", "and", "for", "with", "from", "del", "las", "los", "por", "para", "con", "una", "uno", "que"]);
export function sameAreaByWords(x: string, y: string): boolean {
  const words = (k: string) => new Set(k.split("-").filter((w) => w.length > 2 && !FILLER.has(w)));
  const wx2 = words(x);
  const wy = words(y);
  const [small, big] = wx2.size <= wy.size ? [wx2, wy] : [wy, wx2];
  return small.size > 0 && [...small].every((w) => big.has(w));
}

/**
 * New decisions whose area is spelled differently from an earlier one: file them under it when
 * they are the same subject. Anchored by time, so two new spellings never swap: a new area may
 * join a settled area (one a successful run already filed) or a new area first recorded before it. Words
 * decide first; the decide seam judges the rest.
 */
async function fileAreas(provider: DecisionProvider, store: DecisionStore, dedupe: string): Promise<void> {
  const live = store.decisions.filter(isLive).sort((x, y) => x.at.localeCompare(y.at));
  const label = new Map<string, string>();
  for (const d of live) if (!label.has(d.areaKey)) label.set(d.areaKey, d.area);
  // Settled = used by a decision a successful run already filed; only never-filed decisions move.
  const settled = new Set(live.filter((d) => d.checkedWith || d.recordId || d.promotedAt).map((d) => d.areaKey));
  // New area keys in order of first appearance.
  const fresh: string[] = [];
  for (const d of live) if (!settled.has(d.areaKey) && !d.resolves && !fresh.includes(d.areaKey)) fresh.push(d.areaKey);
  if (!fresh.length || label.size < 2) return;
  const mapped = new Map<string, string>();
  const anchorsFor = (i: number) => [...settled, ...fresh.slice(0, i).filter((k) => !mapped.has(k))];
  const toAsk: number[] = [];
  fresh.forEach((k, i) => {
    const byWords = anchorsFor(i).find((a) => sameAreaByWords(k, a));
    if (byWords) mapped.set(k, byWords);
    else if (anchorsFor(i).length) toAsk.push(i);
  });
  const asked = toAsk.slice(0, 20);
  if (asked.length) {
    const questions: Record<string, Question> = {};
    asked.forEach((i, q) => {
      const k = fresh[i]!;
      const options: Record<string, string | null> = {};
      for (const a of anchorsFor(i).slice(0, 200)) options[a] = label.get(a) ?? null;
      options[k] = `${label.get(k) ?? k} (a subject of its own)`;
      questions[`a${q + 1}`] = {
        type: "choice",
        instructions: `Area a${q + 1}, "${label.get(k) ?? k}", was just used for the first time. If it is the same subject as an existing area (even worded differently, more narrowly or in another language), choose that area; otherwise choose "${k}".`,
        options,
      };
    });
    const examples = (k: string) => live.filter((d) => d.areaKey === k).slice(0, 3).map((d) => clipText(d.statement, 200));
    const state = {
      existing: Object.fromEntries([...new Set(asked.flatMap((i) => anchorsFor(i)))].map((a) => [a, { name: label.get(a) ?? a, decisions: examples(a) }])),
      new: Object.fromEntries(asked.map((i, q) => [`a${q + 1}`, { name: label.get(fresh[i]!) ?? fresh[i]!, decisions: examples(fresh[i]!) }])),
    };
    const r = await provider.decide({ purpose: "reconcile", state, questions, dedupeKey: `${dedupe}:areas` });
    asked.forEach((i, q) => {
      const ans = r.answers[`a${q + 1}`];
      const k = fresh[i]!;
      if (ans?.type === "choice" && ans.choice !== k && anchorsFor(i).includes(ans.choice) && ans.confidence >= 0.5) mapped.set(k, ans.choice);
    });
  }
  const final = (k: string): string => {
    let cur = k;
    for (let n = 0; n < 50 && mapped.has(cur); n++) cur = mapped.get(cur)!;
    return cur;
  };
  for (const d of live) if (!d.checkedWith && !d.recordId && !d.promotedAt && mapped.has(d.areaKey)) d.areaKey = final(d.areaKey);
}

// ---- routing ------------------------------------------------------------------------------------------------

export interface Route {
  to: string;
  reason: string;
  selfAsserted?: boolean;
}

/**
 * Whether this person's `decides` entry for the area is operator-set (else: self-asserted). The
 * change that introduced it decides: the operator's counts; a referral's counts only once the
 * operator approved the person afterwards (status → active by the operator; an overseer's approval
 * does not count); any other writer never counts.
 */
export function decidesTrusted(orgId: string, person: Person, areaKey: string): boolean {
  const all = readHistory(orgId, person.id);
  const history = all.filter((c) => c.field === "decides");
  if (!history.length) return true; // a hand-edited roster: the operator's own file
  const has = (v: unknown) => Array.isArray(v) && v.some((x) => typeof x === "string" && areaKeyOf(x) === areaKey);
  // The change that introduced the entry most recently.
  for (let i = history.length - 1; i >= 0; i--) {
    const c = history[i]!;
    if (!has(c.to) || has(c.from)) continue;
    if (c.by.kind === "operator") return true;
    if (c.by.kind === "referral") return all.some((x) => x.field === "status" && x.to === "active" && x.by.kind === "operator" && x.at > c.at);
    return false;
  }
  return true;
}

/**
 * Who settles a conflict in `areaKey`: the area's owner other than the authors when there is one;
 * in an area no one on the roster decides, the project's main stakeholder (even when they wrote a
 * side: one person contradicting themselves); else the operator. Pure over the roster.
 */
export function routeConflict(
  orgId: string,
  roster: Person[],
  areaKey: string,
  area: string,
  authors: string[],
  trusted = decidesTrusted,
  stakeholder?: string | null,
  owner: { ownerArea?: string; differ?: [string, string] } = {},
): Route {
  if (owner.differ) return { to: OPERATOR, reason: `The two decisions name different owner areas: ${owner.differ[0]} and ${owner.differ[1]}.` };
  const key = authorityKey(owner.ownerArea, areaKey);
  const label = key === null || owner.ownerArea === undefined ? area : owner.ownerArea;
  const { owners, via } = ownersFor(roster, key, stakeholder);
  if (!owners.length) return { to: OPERATOR, reason: `Nobody on the roster decides ${label}.` };
  if (via === "stakeholder") return { to: owners[0]!.id, reason: `${owners[0]!.name} is this project's main stakeholder.` };
  const pick = owners.find((p) => !authors.includes(p.id)) ?? owners[0]!;
  if (!trusted(orgId, pick, key!)) return { to: OPERATOR, reason: `${pick.name}'s say over ${label} was not set by ${operatorName()} (self-asserted).`, selfAsserted: true };
  return { to: pick.id, reason: `${pick.name} decides ${label}.` };
}

// ---- the run -------------------------------------------------------------------------------------------------

export interface ReconcileOptions {
  /** Who owns those sessions (default the operator). */
  owner?: BatonOwner;
  /** Started by Sova itself (a routed conflict's answer): with the switch off it is skipped and
      recorded in lastRun.error instead of refused. */
  auto?: boolean;
  /** The settle sessions' model and thinking (the project overseer passes its gathering choice);
      default: the project's gathering model (settleChoice). */
  model?: string;
  thinking?: string;
  /** The caller's own envelope (the project overseer's turn), else the operator's. */
  envelope?: Envelope;
  attended?: boolean;
}

/**
 * The model and thinking of a settle session (the person talks to it, like any gathering
 * session): the project's `gatheringModel`/`gatheringThinking`, else the overseer's own setting,
 * else nothing (the new-session default). For every settle session, the operator's included.
 */
export function settleChoice(orgId: string, projectId: string): { model?: string; thinking?: string } {
  try {
    const s = readPoSettings(projectOverseerPaths(projectId));
    const model = s.gatheringModel ?? s.model;
    const thinking = s.gatheringThinking ?? s.thinking;
    return { ...(model ? { model } : {}), ...(thinking ? { thinking } : {}) };
  } catch {
    return {};
  }
}

type Outcome = "a" | "b" | "both" | "neither";

/** What a resolution does, and whether it only says the kept side again (then it is folded into
    that record; otherwise it is a decision of its own, and never evidence for the other rule). */
function decisionOutcome(provider: DecisionProvider, c: Conflict, a: DecisionRow, b: DecisionRow, r: DecisionRow): Promise<{ outcome: Outcome; restates: boolean }> {
  return provider
    .decide({
      purpose: "reconcile",
      state: { conflict: { A: brief(a), B: brief(b) }, resolution: brief(r) },
      questions: {
        outcome: {
          type: "choice",
          instructions: "A and B contradicted each other; the resolution was then decided by the person who owns the area. What does the resolution do?",
          options: { a: "It keeps A (B no longer holds).", b: "It keeps B (A no longer holds).", neither: "It replaces both with something else.", both: "It says both hold; they do not really contradict." },
        },
        restates: {
          type: "boolean",
          instructions: "Does the resolution state the same rule as A or as B (the same question with the same answer), rather than something else?",
          criteria: { true: "Its rule is A's or B's, said again.", false: "It is about something else, or adds a rule neither A nor B states." },
        },
      },
      dedupeKey: `reconcile:${c.id}:outcome`,
    })
    .then((res) => {
      const ans = res.answers.outcome;
      const outcome = ans?.type === "choice" && (ans.choice === "a" || ans.choice === "b" || ans.choice === "both" || ans.choice === "neither") ? ans.choice : "neither";
      const re = res.answers.restates;
      return { outcome, restates: re?.type === "boolean" && re.p >= 0.5 };
    });
}

function applyOutcome(c: Conflict, a: DecisionRow, b: DecisionRow, resolver: DecisionRow | null, outcome: Outcome, now: Date, restates = true): void {
  const kept = outcome === "a" ? a : outcome === "b" ? b : null;
  const lost = outcome === "a" ? b : outcome === "b" ? a : null;
  if (kept && lost) {
    lost.supersededBy = kept.id;
    // A resolution that keeps a side says it again: its words join that record, not a second one.
    // One that says something else stays a decision of its own.
    if (resolver && restates) {
      resolver.supersededBy = kept.id;
      kept.folded = [...new Set([...(kept.folded ?? []), resolver.id])];
    }
  } else if (outcome === "neither" && resolver) {
    a.supersededBy = resolver.id;
    b.supersededBy = resolver.id;
  } else if (outcome === "both") markChecked(a, b);
  if (resolver) {
    resolver.resolves = c.id;
    resolver.areaKey = c.areaKey;
    markChecked(resolver, a);
    markChecked(resolver, b);
  }
  c.state = "resolved";
  c.outcome = outcome;
  c.resolvedBy = (resolver ?? kept ?? a).id;
  c.resolvedAt = now.toISOString();
}

/** The usage ref a decide answer is priced by: pi's own "provider/model"; Claude Code's resolved id
    (else its alias, which the price table maps); Jev as itself (it has no public price). Pure. */
export function usageRefOf(r: Pick<DecisionResult, "provider" | "model" | "usage">): { provider: string; model: string } {
  if (r.provider === "claude-code") return r.usage?.model ? { provider: "claude", model: r.usage.model } : { provider: "claude-code-cli", model: r.model };
  if (r.provider === "pi") {
    const slash = r.model.indexOf("/");
    if (slash > 0) return { provider: r.model.slice(0, slash), model: r.usage?.model ?? r.model.slice(slash + 1) };
  }
  return { provider: r.provider, model: r.model };
}

/** The provider, with every answer's usage appended to the project's usage.jsonl
    (§app.project-costs/ledger). A failed answer reports none, so it records nothing. */
function recordingUsage(inner: DecisionProvider, orgId: string, projectId: string, by: CostStarter, now: () => Date): DecisionProvider {
  return {
    id: inner.id,
    label: inner.label,
    async decide(req) {
      // The usage ledger's record of this call (llm-inflight attribution.ts): the project's, no session's.
      const r = await withUsageContext({ owner: null, project: projectId, purpose: "reconcile", kind: "oneshot", starter: by }, () => inner.decide(req));
      const u = r.usage;
      if (u && u.inputTokens + u.outputTokens + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0) > 0) {
        try {
          appendUsage(ledgerPaths(projectId), {
            at: now().toISOString(),
            kind: "reconcile",
            by,
            ...usageRefOf(r),
            input: u.inputTokens,
            output: u.outputTokens,
            cacheRead: u.cacheRead ?? 0,
            cacheWrite: u.cacheWrite ?? 0,
            ...(u.cacheWrite1h ? { cacheWrite1h: u.cacheWrite1h } : {}),
          });
        } catch (err) {
          console.warn(`[reconcile] usage not recorded: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      return r;
    },
  };
}

/**
 * POST …/reconcile, and the project overseer's sova_reconcile: a request to the project's reconciler
 * (it runs one comparison at a time; one asked for meanwhile runs once more after), then its rows once
 * that run ended. With the switch off the statechart refuses (an automatic request records why).
 */
export async function reconcileProject(orgId: string, projectId: string, opts: ReconcileOptions = {}): Promise<DecisionsInfo> {
  projectOf(orgId, projectId);
  const by: Asker = opts.auto ? "sova" : typeof opts.owner === "object" && opts.owner.overseerOf === projectId ? "overseer" : "operator";
  const choice = opts.model || opts.thinking ? { ...(opts.model ? { model: opts.model } : {}), ...(opts.thinking ? { thinking: opts.thinking } : {}) } : null;
  if (choice) settleChoices.set(`${orgId}/${projectId}`, choice);
  // Settings → Decisions as it is now (the statechart refuses while the switch is off).
  await syncReconcileSwitch(orgId);
  // The statechart's own refusal answers "That can't be done now." while off (inbox-charts/server3-p3-findings.md 1).
  if (by !== "sova" && hostOf(orgId).configuration(reconcilerSid(orgId, projectId))?.includes("off")) throw new OrgError(RECONCILE_OFF, 409);
  await act(orgId, reconcilerSid(orgId, projectId), "reconcile/request", { delayMs: 0, by: by === "sova" ? "sova" : by, ...(opts.owner ? { owner: opts.owner } : {}) }, opts.envelope ?? envelopeOf(orgId, projectId, by, opts.attended ?? true));
  await runEnded(orgId, projectId);
  return listDecisions(orgId, projectId);
}

/** The settle sessions' model and thinking a caller asked for (the project overseer's gathering choice), for the next run. */
const settleChoices = new Map<string, { model?: string; thinking?: string }>();

/** What one run reports to the reconciler statechart (`reconcile/finished`). */
export interface RunResult {
  decisions: Record<string, unknown>[];
  conflicts: Record<string, unknown>[];
  resolved: { id: string; outcome: string; resolvedBy: string }[];
  compared: number;
  draftedIds: string[];
  error?: string;
}

/** The fields a run may change on a decision (the statechart's `reconcile/result`). */
const RESULT_KEYS = ["recordId", "supersededBy", "folded", "checkedWith", "authorOwnsArea", "areaKey", "resolves"] as const;
const resultOf = (d: DecisionRow): Record<string, unknown> => ({
  id: d.id,
  // A promoted decision stays promoted: the run only brings its fields (the spec's facts say whether it is current).
  state: d.promotedAt && (d.state === "promoted" || d.state === "drafted") ? "drafted" : d.state,
  ...Object.fromEntries(RESULT_KEYS.filter((k) => d[k] !== undefined).map((k) => [k, d[k]])),
});
const changedSince = (before: Map<string, string>, d: DecisionRow) => before.get(d.id) !== JSON.stringify(resultOf(d));
/** The run's changed decisions, each superseded one naming its superseding decision's statement (`title`, its
    history headline: that statement is already the history's own headline for that decision). */
const resultsSince = (before: Map<string, string>, store: DecisionStore): Record<string, unknown>[] =>
  store.decisions
    .filter((x) => changedSince(before, x))
    .map((x) => {
      const by = x.supersededBy ? store.decisions.find((y) => y.id === x.supersededBy)?.statement : undefined;
      return { ...resultOf(x), ...(by ? { title: by } : {}) };
    });

/**
 * One comparison (the reconciler statechart's :sova/reconcile): settle the routed conflicts whose sessions
 * recorded an answer, file new areas, compare every unchecked pair, route each new conflict (its
 * settle session is the conflict statechart's), draft the clean decisions. Reads the statecharts; writes only the
 * project's draft; its results go back to the statechart, which moves each decision and spawns the conflicts.
 */
export async function runReconcile(orgId: string, projectId: string, params: { by: CostStarter; owner?: BatonOwner }): Promise<RunResult> {
  const d = await currentDeps();
  const project = projectOf(orgId, projectId);
  const store = readDecisionStore(orgId, projectId);
  const conflicts = readConflicts(orgId, projectId);
  const known = new Set(conflicts.map((c) => c.id));
  settleStates(store, conflicts, project.root, orgId, project.stakeholder);
  // A decision recorded in a settle session names its conflict from birth; the run decides whether it
  // settles it (the first one) or restates the kept side (a later one), as before.
  for (const x of store.decisions) if (x.resolves && !x.checkedWith) delete x.resolves;
  const before = new Map(store.decisions.map((x) => [x.id, JSON.stringify(resultOf(x))]));
  const now = d.now();
  const byId = new Map(store.decisions.map((x) => [x.id, x]));
  const run = { at: now.toISOString(), compared: 0, found: 0 } as NonNullable<DecisionStore["lastRun"]>;
  const newConflicts: string[] = [];
  const resolved: string[] = [];
  settleStates(store, conflicts, project.root, orgId, project.stakeholder);
  try {
    if (d.excluded(project.root)) throw new DecisionError("unavailable", "This project's folder is excluded in Settings → Decisions.");
    const chain = d.provider();
    if (!chain) throw new DecisionError("unavailable", "No decision provider is ready (Settings → Decisions).");
    const provider = recordingUsage(chain, orgId, projectId, params.by, d.now);
    const dedupe = `reconcile:${projectId}`;

    // 2. Resolutions: the first decision recorded in an open conflict's baton session.
    for (const c of conflicts) {
      if (c.state !== "open" || !c.batonSessionId) continue;
      const a = byId.get(c.a);
      const b = byId.get(c.b);
      const r = store.decisions
        .filter((x) => x.sessionId === c.batonSessionId && !x.resolves && x.state === "pending")
        .sort((x, y) => x.at.localeCompare(y.at))[0];
      if (!a || !b || !r) continue;
      const { outcome, restates } = await decisionOutcome(provider, c, a, b, r);
      applyOutcome(c, a, b, r, outcome, now, restates);
      resolved.push(c.id);
    }
    settleStates(store, conflicts, project.root, orgId, project.stakeholder);

    // 3. Areas.
    await fileAreas(provider, store, dedupe);
    settleStates(store, conflicts, project.root, orgId, project.stakeholder);

    // 4. Pairs.
    const inConflict = new Set(conflicts.map((c) => pairKey(c.a, c.b)));
    const live = store.decisions.filter((x) => !x.supersededBy);
    const areas = [...new Set(live.map((x) => x.areaKey))];
    for (const areaKey of areas) {
      // Restatements first: a pending decision that says again what its author said before
      // shares that statement's fate (superseded with it), so a losing author repeating their
      // rule never reopens the settled conflict.
      const again: [DecisionRow, DecisionRow][] = [];
      const before = store.decisions.filter((x) => x.areaKey === areaKey).sort((x, y) => x.at.localeCompare(y.at));
      for (const y of before) {
        if (y.supersededBy || y.state !== "pending" || y.promotedAt || y.resolves) continue;
        for (const x of before) {
          if (x === y || x.by !== y.by || x.at > y.at || checked(x, y) || y.supersededBy) continue;
          if (!x.supersededBy && !sameWords(x, y)) continue; // a live pair is asked below
          if (sameWords(x, y)) fold(x, y, byId);
          else again.push([x, y]);
        }
      }
      if (again.length) {
        const vs = await askPairs(provider, areaKey, again[0]![0].area, again, `${dedupe}:again`);
        run.compared += again.length;
        again.forEach(([x, y], k) => {
          if (y.supersededBy) return;
          if ((vs[k]?.same ?? 0) >= CONFLICT_P) fold(x, y, byId);
          else markChecked(x, y);
        });
        settleStates(store, conflicts, project.root, orgId, project.stakeholder);
      }
      const group = store.decisions.filter((x) => !x.supersededBy && x.areaKey === areaKey).sort((x, y) => x.at.localeCompare(y.at));
      const pairs: [DecisionRow, DecisionRow][] = [];
      for (let i = 0; i < group.length; i++)
        for (let j = i + 1; j < group.length; j++) {
          const x = group[i]!;
          const y = group[j]!;
          if (x.state !== "pending" && y.state !== "pending") continue;
          if (checked(x, y) || inConflict.has(pairKey(x.id, y.id))) continue;
          // A side already in an open conflict waits for its resolution (which may supersede it).
          if (openConflictOf(conflicts, x.id) || openConflictOf(conflicts, y.id)) continue;
          pairs.push([x, y]);
        }
      if (!pairs.length) continue;
      const area = group.find((x) => x.recordId)?.area ?? group[0]!.area;
      const ps = await askPairs(provider, areaKey, area, pairs, dedupe);
      run.compared += pairs.length;
      const roster = readRoster(orgId);
      for (let k = 0; k < pairs.length; k++) {
        const [x, y] = pairs[k]!;
        if (x.supersededBy || y.supersededBy) continue;
        const v = ps[k] ?? { conflict: 0, same: 0 };
        const p = v.conflict;
        // The same rule said twice (a confirmation, a second person agreeing): one record, both quotes.
        if (v.same >= CONFLICT_P && p < CONFLICT_P && !y.promotedAt && !y.resolves) {
          fold(x, y, byId);
          continue;
        }
        if (p < CONFLICT_P || openConflictOf(conflicts, x.id) || openConflictOf(conflicts, y.id)) {
          if (p < CONFLICT_P) markChecked(x, y);
          continue;
        }
        const owner = ownerAreaOfPair(x, y);
        const route = routeConflict(orgId, roster, areaKey, area, [x.by, y.by], decidesTrusted, project.stakeholder, owner);
        const c: Conflict = {
          id: shortId("cf_"),
          orgId,
          projectId,
          areaKey,
          ...(owner.ownerArea ? { ownerArea: owner.ownerArea } : {}),
          a: x.id,
          b: y.id,
          p,
          routedTo: route.to,
          routeReason: route.reason,
          ...(route.selfAsserted ? { selfAsserted: true } : {}),
          state: "open",
          createdAt: now.toISOString(),
        };
        conflicts.push(c);
        inConflict.add(pairKey(x.id, y.id));
        newConflicts.push(c.id);
        run.found++;
        settleStates(store, conflicts, project.root, orgId, project.stakeholder);
      }
    }
    // Every live decision has now been filed and compared (or is in a conflict).
    for (const x of store.decisions) x.checkedWith ??= [];
  } catch (err) {
    run.error = err instanceof Error ? err.message : String(err);
  }
  settleStates(store, conflicts, project.root, orgId, project.stakeholder);

  settleStates(store, conflicts, project.root, orgId, project.stakeholder);
  assignRecordIds(project.root, store);
  const draftedIds = await refreshDraft(orgId, projectId, store).catch((err) => {
    run.error = `${run.error ? `${run.error}; ` : ""}draft: ${err instanceof Error ? err.message : String(err)}`;
    return [] as string[];
  });
  // Each new conflict's route and settle session (the conflict statechart starts it).
  const choice = settleChoices.get(`${orgId}/${projectId}`) ?? settleChoice(orgId, projectId);
  settleChoices.delete(`${orgId}/${projectId}`);
  const byIdNow = new Map(store.decisions.map((x) => [x.id, x]));
  const names = namesOf(orgId);
  const side = (x: DecisionRow) => ({ id: x.id, by: x.by, name: x.name, statement: x.statement, quote: x.quote, at: Date.parse(x.at) });
  const fresh = conflicts
    .filter((c) => !known.has(c.id))
    .map((c) => {
      const a = byIdNow.get(c.a)!;
      const b = byIdNow.get(c.b)!;
      return {
        id: c.id,
        a: side(a),
        b: side(b),
        area: a.area,
        areaKey: c.areaKey,
        ...(c.ownerArea ? { ownerArea: c.ownerArea } : {}),
        p: c.p,
        routedTo: c.routedTo,
        routedToName: c.routedTo === OPERATOR ? operatorName() : (names[c.routedTo] ?? c.routedTo),
        routeReason: c.routeReason,
        ...(c.selfAsserted ? { selfAsserted: true } : {}),
        batonSessionId: randomUUID(),
        operatorName: operatorName(),
        ...choice,
      };
    });
  return {
    decisions: resultsSince(before, store),
    conflicts: fresh,
    resolved: conflicts.filter((c) => resolved.includes(c.id)).map((c) => ({ id: c.id, outcome: c.outcome ?? "neither", resolvedBy: c.resolvedBy ?? "" })),
    compared: run.compared,
    draftedIds,
    ...(run.error ? { error: run.error } : {}),
  };
}

/** The rows to write, the promoted records they supersede (rewritten as superseded), and the
    decisions folded into each. */
function editFor(store: DecisionStore, rows: DecisionRow[], root: string): SpecEdit {
  const byId = new Map(store.decisions.map((x) => [x.id, x]));
  const current = currentRecordIds(root);
  const chosen = new Map(rows.map((r) => [r.id, r]));
  const out: DecisionRow[] = [...rows];
  const supersededBy = new Map<string, string>();
  for (const s of store.decisions) {
    const winner = s.supersededBy ? chosen.get(s.supersededBy) : undefined;
    if (!winner?.recordId || !s.promotedAt || !s.recordId || !current.has(s.recordId)) continue;
    supersededBy.set(s.recordId, winner.recordId);
    out.push(s);
  }
  const also = new Map<string, DecisionRow[]>();
  // A fold of a fold too: a confirmation folded into a resolution that was itself folded here.
  for (const r of rows) if (r.recordId && r.folded?.length) also.set(r.recordId, foldedRows(r, byId));
  return { rows: out, supersededBy, also };
}

/** Rewrite the project draft: every drafted row not yet promoted. Returns the ids that changed. */
async function refreshDraft(orgId: string, projectId: string, store: DecisionStore): Promise<string[]> {
  const root = projectOf(orgId, projectId).root;
  const rows = store.decisions.filter((x) => x.state === "drafted" && x.recordId);
  const { changed } = await writeProjectDraft(root, editFor(store, rows, root));
  const byRecord = new Map(store.decisions.map((x) => [x.recordId, x.id]));
  return changed.map((id) => byRecord.get(id)).filter((x): x is string => !!x);
}

/** POST …/draft: rewrite the draft from the rows without comparing anything (the reconciler's draft/rewrite; effect `draft`). */
export async function draftProject(orgId: string, projectId: string): Promise<DecisionsInfo> {
  projectOf(orgId, projectId);
  // The spec as it is now first: a promoted decision its record no longer matches (a quote folded in since) is drafted again.
  await syncSpecFacts(orgId, projectId);
  await act(orgId, reconcilerSid(orgId, projectId), "draft/rewrite", {}, operatorEnvelope(orgId, projectId));
  return listDecisions(orgId, projectId);
}

/** The effect `draft`: the project's draft rewritten from the drafted decisions. */
async function draftEffect(orgId: string, projectId: string): Promise<{ drafted: string[] }> {
  const project = projectOf(orgId, projectId);
  const store = readDecisionStore(orgId, projectId);
  assignRecordIds(project.root, store);
  const ids = await refreshDraft(orgId, projectId, store);
  return { drafted: ids };
}

// ---- conflicts by hand -----------------------------------------------------------------------------------

/** A conflict's open statechart, or the route's refusal. */
function openConflict(orgId: string, projectId: string, conflictId: string): Conflict {
  const c = readConflicts(orgId, projectId).find((x) => x.id === conflictId);
  if (!c) throw new OrgError("Unknown conflict", 404);
  if (c.state !== "open") throw new OrgError("That conflict is resolved", 409);
  return c;
}

/** The target of a route, as the statechart checks it (an active person or the operator). */
function routeTarget(orgId: string, to: string): Record<string, unknown> | null {
  if (to === OPERATOR) return null;
  const p = readRoster(orgId).find((x) => x.id === to);
  // r7: with their zone and hours, so a settle session to someone off hours waits for their window.
  return p ? targetOfPerson(p) : { id: to, name: to, status: "unknown" };
}

/** POST …/conflicts/:cid/route {to?}: its settle session again, to `to` (else where it goes): the
    conflict statechart closes the earlier one first, so two people are never asked the same thing. */
export async function routeConflictNow(orgId: string, projectId: string, conflictId: string, to?: string, _owner?: BatonOwner, envelope?: Envelope): Promise<DecisionsInfo & { offHours?: string }> {
  projectOf(orgId, projectId);
  const c = openConflict(orgId, projectId, conflictId);
  const target = to ?? c.routedTo;
  const out = await act(
    orgId,
    conflictSid(orgId, projectId, c.id),
    "conflict/reroute",
    { to: target, sessionId: randomUUID(), ...(to ? {} : { routeReason: c.routeReason, ...(c.selfAsserted ? { selfAsserted: true } : {}) }), ...(routeTarget(orgId, target) ? { target: routeTarget(orgId, target) } : {}) },
    envelope ?? operatorEnvelope(orgId, projectId, undefined, { operatorName: operatorName() }),
  );
  return { ...listDecisions(orgId, projectId), ...offHoursOf(out) };
}

/**
 * PATCH …/decisions/:did {ownerArea}: the operator says who decides a decision
 * (§app.requirements/owner-area). The decision statechart keeps it with who and when; its authority is
 * recomputed here, and an open conflict it is a side of is routed again (the reconciler's
 * `route-conflict-of`): to someone else, the session asking is closed and a new one starts.
 */
export async function setOwnerArea(orgId: string, projectId: string, decisionId: string, value: unknown): Promise<DecisionsInfo> {
  const project = projectOf(orgId, projectId);
  const row = readDecisionStore(orgId, projectId).decisions.find((x) => x.id === decisionId);
  if (!row) throw new OrgError("Unknown decision", 404);
  const roster = readRoster(orgId);
  const pick = pickOwnerArea(roster, value);
  const owns = pick.ok ? authorOwnsArea(orgId, roster, { ...row, ownerArea: pick.ownerArea }, decidesTrusted, project.stakeholder) : false;
  await act(
    orgId,
    decisionSid(orgId, projectId, decisionId),
    "decision/owner-area",
    { ownerArea: typeof value === "string" ? value : "", ownerAreas: ownerAreaChoices(roster), authorOwnsArea: owns, operatorName: operatorName() },
    operatorEnvelope(orgId, projectId),
  );
  return listDecisions(orgId, projectId);
}

/** The effect `route-conflict-of`: the open conflict the decision is a side of, routed again by its owner areas. */
async function rerouteOf(orgId: string, projectId: string, decisionId: string): Promise<{ rerouted: string | null }> {
  const project = projectOf(orgId, projectId);
  const c = readConflicts(orgId, projectId).find((x) => x.state === "open" && (x.a === decisionId || x.b === decisionId));
  if (!c) return { rerouted: null };
  const byId = new Map(readDecisionStore(orgId, projectId).decisions.map((x) => [x.id, x]));
  const a = byId.get(c.a);
  const b = byId.get(c.b);
  if (!a || !b) return { rerouted: null };
  const owner = ownerAreaOfPair(a, b);
  const route = routeConflict(orgId, readRoster(orgId), c.areaKey, a.area, [a.by, b.by], decidesTrusted, project.stakeholder, owner);
  const target = routeTarget(orgId, route.to);
  const out = await hostOf(orgId).act(
    conflictSid(orgId, projectId, c.id),
    "conflict/reroute",
    { to: route.to, sessionId: randomUUID(), routeReason: route.reason, ...(route.selfAsserted ? { selfAsserted: true } : {}), keepIfSame: true, ...(owner.ownerArea ? { ownerArea: owner.ownerArea } : {}), ...(target ? { target } : {}) },
    envelopeFor(orgId, projectId, { by: "system", attended: false }),
    { settle: true },
  );
  return { rerouted: out.taken ? c.id : null };
}

/** POST …/conflicts/:cid/resolve: the operator keeps a side, both, or states the decision (the conflict statechart's settle). */
export async function resolveConflict(orgId: string, projectId: string, conflictId: string, input: ConflictResolveInput): Promise<DecisionsInfo> {
  projectOf(orgId, projectId);
  const c = readConflicts(orgId, projectId).find((x) => x.id === conflictId);
  if (!c) throw new OrgError("Unknown conflict", 404);
  const statement = "statement" in input ? input.statement : undefined;
  // What it settled on, for its history headline: the decision stated, the side kept, or (both kept) their area.
  const sides = readDecisionStore(orgId, projectId).decisions;
  const kept = "keep" in input && input.keep !== "both" ? sides.find((x) => x.id === c[input.keep as "a" | "b"]) : undefined;
  const title = statement?.trim() || kept?.statement || ("keep" in input && input.keep === "both" ? sides.find((x) => x.id === c.a)?.area : undefined);
  await act(
    orgId,
    conflictSid(orgId, projectId, conflictId),
    "conflict/settle",
    { ...("keep" in input ? { keep: input.keep } : {}), ...(statement !== undefined ? { statement, decisionId: `operator:${shortId("")}` } : {}), ...(title ? { title } : {}) },
    operatorEnvelope(orgId, projectId),
  );
  return listDecisions(orgId, projectId);
}

/**
 * The effect `settle`: the operator's decision (when they stated one) is born as a decision of its own,
 * the kept and lost sides and the resolution are worked out as before, and the draft rewritten; the
 * decisions' new facts go back through the reconciler (`settle/results`).
 */
async function settleEffect(orgId: string, projectId: string, e: Effect): Promise<{ decisions: Record<string, unknown>[] }> {
  const project = projectOf(orgId, projectId);
  const d = await currentDeps();
  const now = d.now();
  const conflicts = readConflicts(orgId, projectId);
  const c = conflicts.find((x) => x.id === String(e.id));
  if (!c) throw new Error("Unknown conflict");
  const store = readDecisionStore(orgId, projectId);
  const a = store.decisions.find((x) => x.id === c.a);
  const b = store.decisions.find((x) => x.id === c.b);
  if (!a || !b) throw new Error("The conflict's decisions are gone");
  const before = new Map(store.decisions.map((x) => [x.id, JSON.stringify(resultOf(x))]));
  let resolver: DecisionRow | null = null;
  if (typeof e.statement === "string") {
    const markerId = String(e.decisionId ?? "").replace(/^operator:/, "") || shortId("");
    resolver = operatorDecision(orgId, projectId, { area: a.area, areaKey: c.areaKey, ...(c.ownerArea ? { ownerArea: c.ownerArea } : {}), statement: e.statement.trim(), now, markerId });
    await hostOf(orgId).settle(
      await hostOf(orgId).start(
        decisionSid(orgId, projectId, resolver.id),
        "decision",
        { orgId, projectId, id: resolver.id, area: resolver.area, areaKey: resolver.areaKey, ...(resolver.ownerArea ? { ownerArea: resolver.ownerArea } : {}), statement: resolver.statement, quote: resolver.quote, by: OPERATOR, name: resolver.name, sessionId: "", entryId: markerId, markerId, resolves: c.id, recordedAt: now.getTime() },
        { by: "operator" },
      ),
    );
    store.decisions.push(resolver);
    before.set(resolver.id, "");
  }
  const outcome = resolver ? "neither" : e.keep === "a" || e.keep === "b" || e.keep === "both" ? e.keep : "neither";
  applyOutcome(c, a, b, resolver, outcome, now);
  settleStates(store, conflicts, project.root, orgId, project.stakeholder);
  assignRecordIds(project.root, store);
  await refreshDraft(orgId, projectId, store).catch(() => []);
  return { decisions: resultsSince(before, store) };
}

// ---- promotion ------------------------------------------------------------------------------------------------

function verificationFor(store: DecisionStore, id: string, conflicts: Conflict[]): string {
  const d = store.decisions.find((x) => x.recordId === id);
  if (!d) return `Area heading for decisions in ${id} (written by the reconciler).`;
  if (d.supersededBy) {
    const w = store.decisions.find((x) => x.id === d.supersededBy);
    return `Superseded by ${w?.recordId ?? d.supersededBy} (${w?.name ?? "?"}, ${w?.at.slice(0, 10) ?? "?"}); kept as history.`;
  }
  const where = d.sessionId ? `in baton session ${d.sessionId}, entry ${d.entryId}` : "on the project page";
  const c = d.resolves ? conflicts.find((x) => x.id === d.resolves) : undefined;
  return (
    `Decision by ${d.name} (${d.by}) on ${d.at.slice(0, 10)} ${where}: "${clipText(d.quote.replace(/\s+/g, " "), 200)}". ` +
    `Reconciled against ${d.checkedWith?.length ?? 0} other decision(s) in ${d.area}; no open conflict.` +
    (c ? ` Settles conflict ${c.id}.` : "")
  );
}

/** Who asked for a promotion: only the operator naming ids one by one may promote a decision made
    outside its author's decision area. */
export type PromoteMode = "operator-explicit" | "bulk" | "overseer";

/**
 * POST …/promote {ids}: piecemeal, the operator's (or the project overseer's at L2, its own hold's
 * rules aside): the reconciler checks each id (drafted, or promoted and stale; in its author's area
 * unless the operator named it), then the effect `promote` writes the spec and commits.
 */
export async function promoteDecisions(orgId: string, projectId: string, ids: string[], opts: { by: PromoteMode; envelope?: Envelope } = { by: "operator-explicit" }): Promise<PromoteResult> {
  projectOf(orgId, projectId);
  await syncSpecFacts(orgId, projectId);
  const rows = new Map(listDecisions(orgId, projectId).decisions.map((d) => [d.id, d]));
  const refused: PromoteResult["refused"] = [];
  for (const id of [...new Set(ids)]) {
    const row = rows.get(id);
    if (!row) refused.push({ id, reason: "unknown decision" });
    else if (row.state !== "drafted") refused.push({ id, reason: `it is ${row.state}; only a reconciled (drafted) decision can be promoted` });
    else if (!row.authorOwnsArea && opts.by !== "operator-explicit") refused.push({ id, reason: `outside ${row.name}'s decision area: promote it explicitly by id` });
  }
  if (refused.length === new Set(ids).size) return { info: listDecisions(orgId, projectId), promoted: [], refused };
  const envelope = opts.envelope ?? (opts.by === "overseer" ? envelopeOf(orgId, projectId, "overseer") : operatorEnvelope(orgId, projectId));
  const out = await hostOf(orgId).act(reconcilerSid(orgId, projectId), "decision/promote", { ids: [...new Set(ids)], ...(opts.by === "bulk" ? { bulk: true } : {}) }, envelope, { settle: true });
  if (!out.taken) throw refusalError(out.refusal ?? { sentence: "That can't be done now." });
  if (out.held) return { info: listDecisions(orgId, projectId), promoted: [], refused, held: heldAt(reconcilerSid(orgId, projectId), out.held) } as PromoteResult;
  const res = (out.effects ?? []).find((x) => x.kind === "promote");
  if (res?.error) return { info: listDecisions(orgId, projectId), promoted: [], refused: [...new Set(ids)].map((id) => ({ id, reason: res.error! })) };
  const r = (res?.result ?? {}) as { promoted?: string[]; refused?: PromoteResult["refused"]; draft?: string; commit?: PromoteResult["commit"] };
  return { info: listDecisions(orgId, projectId), promoted: r.promoted ?? [], refused: r.refused ?? refused, ...(r.draft ? { draft: r.draft } : {}), ...(r.commit ? { commit: r.commit } : {}) };
}

/** The effect `promote`: the checked ids written into the spec (their records, the ones they supersede,
    the quotes folded in), committed, and each one's prose hash kept (the statechart's promote/done). */
async function promoteEffect(orgId: string, projectId: string, e: Effect): Promise<Record<string, unknown>> {
  const project = projectOf(orgId, projectId);
  const d = await currentDeps();
  const store = readDecisionStore(orgId, projectId);
  const conflicts = readConflicts(orgId, projectId);
  settleStates(store, conflicts, project.root, orgId, project.stakeholder);
  assignRecordIds(project.root, store);
  const want = new Set(Array.isArray(e.ids) ? e.ids.map(String) : []);
  const refused = Array.isArray(e.refused) ? (e.refused as PromoteResult["refused"]) : [];
  const rows = store.decisions.filter((x) => want.has(x.id));
  let promoted: string[] = [];
  let draft: string | undefined;
  let commit: PromoteCommit | undefined;
  const textHashes: Record<string, string> = {};
  if (rows.length) {
    const edit = editFor(store, rows, project.root);
    // What git sees in the root's spec before the promotion, so the commit takes only its own changes.
    const snap = await specSnapshot(project.root).catch(() => null);
    try {
      const out = await promoteEdit(project.root, edit, (rid) => verificationFor(store, rid, conflicts), d.now());
      if (out.draft) draft = out.draft;
      const done = new Set(out.promoted);
      const current = currentRecordIds(project.root);
      const byId = new Map(store.decisions.map((x) => [x.id, x]));
      for (const r of rows)
        if (r.recordId && (done.has(r.recordId) || current.has(r.recordId))) {
          promoted.push(r.id);
          textHashes[r.id] = proseHash(currentBlock(project.root, r.recordId) ?? renderRecord(r, undefined, foldedRows(r, byId)));
        }
      if (snap && promoted.length) commit = await commitSpec(snap, promotionMessage(rows.filter((r) => promoted.includes(r.id)))).catch((err) => ({ skipped: `Not committed: ${err instanceof Error ? err.message : String(err)}` }));
    } catch (err) {
      const reason = err instanceof SpecToolError || err instanceof Error ? err.message : String(err);
      for (const r of rows) refused.push({ id: r.id, reason });
      promoted = [];
    }
  }
  const by = e.by === "overseer" || e.by === "bulk" ? e.by : "operator-explicit";
  const sha = commit && "sha" in commit ? commit.sha : undefined;
  return { promoted, refused, textHashes, ...(sha ? { commit: { sha } } : {}), ...(commit ? { commitInfo: commit } : {}), ...(draft ? { draft } : {}), specHash: specHash(project.root), at: d.now().getTime() };
}

/**
 * POST …/decisions/:did/text {action}: a promoted decision whose record's prose was edited in the
 * spec (§app.requirements/decisions). `keep`: the spec's words stand (the decision takes their hash,
 * and who kept them). `restore`: the person's words are promoted again, prose only (effect
 * `restore-text`), committed like any promotion.
 */
export async function settleSpecText(orgId: string, projectId: string, decisionId: string, action: unknown): Promise<DecisionsInfo> {
  const project = projectOf(orgId, projectId);
  if (action !== "keep" && action !== "restore") throw new OrgError('Expected { action: "keep" | "restore" }');
  await syncSpecFacts(orgId, projectId);
  const row = readDecisionStore(orgId, projectId).decisions.find((x) => x.id === decisionId);
  if (!row) throw new OrgError("Unknown decision", 404);
  const textHash = row.recordId ? proseHash(currentBlock(project.root, row.recordId) ?? "") : "";
  await act(orgId, decisionSid(orgId, projectId, decisionId), "decision/settle-text", { action, textHash, operatorName: operatorName() }, operatorEnvelope(orgId, projectId));
  // A restore rewrote the spec: its facts now say the words are as promoted.
  if (action === "restore") await syncSpecFacts(orgId, projectId);
  return listDecisions(orgId, projectId);
}

/** The effect `restore-text`: the decision's prose promoted again, committed; the spec's facts then say it is as promoted. */
async function restoreEffect(orgId: string, projectId: string, e: Effect): Promise<Record<string, unknown>> {
  const project = projectOf(orgId, projectId);
  const d = await currentDeps();
  const store = readDecisionStore(orgId, projectId);
  const conflicts = readConflicts(orgId, projectId);
  const row = store.decisions.find((x) => x.id === String(e.id));
  if (!row?.recordId) throw new Error("Unknown decision");
  const byId = new Map(store.decisions.map((x) => [x.id, x]));
  const also = foldedRows(row, byId);
  const edit: SpecEdit = { rows: [row], supersededBy: new Map(), also: new Map(also.length ? [[row.recordId, also]] : []) };
  const snap = await specSnapshot(project.root).catch(() => null);
  const verification = () => `${verificationFor(store, row.recordId!, conflicts)} Restored: its prose had been edited in the spec since it was promoted.`;
  const out = await promoteEdit(project.root, edit, verification, d.now(), { proseOnly: true });
  const commit = out.promoted.length && snap ? await commitSpec(snap, promotionMessage([row])).catch(() => undefined) : undefined;
  void syncSpecFacts(orgId, projectId).catch(() => {});
  // The words now in the spec (their words again): the promoted text the statechart compares against from here on.
  const textHash = proseHash(currentBlock(project.root, row.recordId) ?? "");
  return { restored: out.promoted.length > 0, textHash, ...(commit && "sha" in commit ? { commit: commit.sha } : {}) };
}

/** The promotion commit's message (§app.requirements/promotion-commit): "Promote 2 decisions: payroll
    export — Exports run on Fridays; approvals — …", each item cut to 72 characters, at most 10 then
    "and k more". */
export function promotionMessage(rows: Pick<DecisionRow, "statement" | "area">[]): string {
  const items = rows.slice(0, 10).map((r) => clipText(`${r.area.toLowerCase()} — ${r.statement.replace(/\s+/g, " ").trim().replace(/[.;]+$/, "")}`, 72));
  const more = rows.length > 10 ? ` and ${rows.length - 10} more` : "";
  const line = `Promote ${rows.length} decision${rows.length === 1 ? "" : "s"}: ${items.join("; ")}${more}`;
  return /[.…]$/.test(line) ? line : `${line}.`;
}

// ---- the host: the reconciler's run and effects -----------------------------------------------------------

/** The org's reconcilers: the :sova/reconcile run, the effects, and the Settings switch as it is now. */
function registerReconcile(host: OrgHostApi, orgId: string): void {
  const pidOf = (e: { sessionId: string }) => e.sessionId.split("/")[2] ?? "";
  host.invocations.register("sova/reconcile", {
    start(inv, report) {
      const projectId = pidOf(inv);
      const p = (inv.params ?? {}) as { by?: string; owner?: BatonOwner };
      const by: CostStarter = p.by === "sova" ? "sova" : p.by === "overseer" || p.by === "statechart" ? "overseer" : "operator";
      void runReconcile(orgId, projectId, { by, ...(p.owner && p.owner !== "operator" ? { owner: p.owner } : {}) })
        .then((r) => report("finished", undefined, r as unknown as Record<string, unknown>))
        .catch((err) => report("stopped", err instanceof Error ? err.message : String(err)));
    },
    stop() {},
  });
  host.effects.register("promote", async (e) => promoteEffect(orgId, pidOf(e), e));
  host.effects.register("draft", async (e) => draftEffect(orgId, pidOf(e)));
  host.effects.register("route-conflict-of", async (e) => rerouteOf(orgId, pidOf(e), String(e.decisionId ?? "")));
  host.effects.register("settle", async (e) => settleEffect(orgId, pidOf(e), e));
  host.effects.register("restore-text", async (e) => restoreEffect(orgId, pidOf(e), e));
  void syncReconcileSwitch(orgId).catch((err) => console.warn(`[reconcile] ${orgId}: ${err instanceof Error ? err.message : String(err)}`));
}
onOrgHostOpened(registerReconcile);

/** Settings → Decisions "Reconcile decisions", told to every reconciler of the org (at open, and when it changes). */
export async function syncReconcileSwitch(orgId: string): Promise<void> {
  if (!isOrgHostOpen(orgId)) return;
  const on = (await currentDeps()).enabled();
  const host = hostOf(orgId);
  for (const p of readProjects(orgId)) {
    const sid = reconcilerSid(orgId, p.id);
    const data = host.data(sid);
    if (!data || (data.enabled !== false) === on) continue;
    await host.act(sid, "settings/reconcile", { on }, envelopeFor(orgId, p.id, { by: "system", attended: false }), { settle: true });
  }
}

export { areaId };
