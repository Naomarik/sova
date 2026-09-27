import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { OPERATOR, type BatonOwner, type BatonStartInput } from "../shared/baton";
import {
  CONFLICT_P,
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
  type ReconcileEvent,
  type SpecStatus,
} from "../shared/decisions";
import type { Person } from "../shared/orgs";
import { batonById, closeBaton, createBaton, namesOf } from "./baton";
import { commitSpec, specSnapshot } from "./project-worktrees";
import { projectOverseerPaths, readPoSettings } from "./project-overseer-store";
import { onBatonEvent } from "./baton-events";
import { DecisionError, type DecisionProvider, type Question } from "./decide";
import { isExcluded } from "./decide-settings";
import {
  areaKeyOf,
  isLive,
  operatorDecision,
  projectOf,
  readConflicts,
  readDecisionStore,
  syncDecisions,
  writeConflicts,
  writeDecisionStore,
  type DecisionStore,
} from "./decisions";
import { operatorName, OrgError, patchProject, readHistory, readRoster, shortId } from "./orgs";
import {
  PROJECT_DRAFT,
  areaId,
  currentClaims,
  currentRecordIds,
  manifestRecord,
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
  startBaton: (input: BatonStartInput & { owner?: BatonOwner; mintLink?: boolean }) => { sessionId: string; path: string };
  /** Close a baton the way the operator's Close does (share pages told, wrap-up scheduled). */
  endBaton: (sessionId: string) => Promise<void>;
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
/** Tests replace the provider, the baton starter and the clock. */
export function setReconcileDeps(d: Partial<ReconcileDeps> | null): void {
  deps = d === null ? null : { ...baseDeps(), ...d };
}
function baseDeps(): ReconcileDeps {
  return {
    provider: () => null,
    excluded: () => false,
    enabled: () => true,
    startBaton: (input) => createBaton(input),
    endBaton: async (sessionId) => {
      closeBaton(sessionId);
      const [{ refreshShare }, { scheduleWrapup }] = await Promise.all([import("./share/hub"), import("./baton-loadout")]);
      refreshShare(sessionId);
      scheduleWrapup(sessionId);
    },
    now: () => new Date(),
  };
}
async function currentDeps(): Promise<ReconcileDeps> {
  if (deps) return deps;
  const live = await defaultProvider();
  return { ...baseDeps(), provider: () => live.provider, excluded: live.excluded, enabled: live.enabled };
}

// ---- events ---------------------------------------------------------------------------------------------

const listeners = new Set<(e: ReconcileEvent) => void>();
/** In-process: the project overseer's watch loop. Returns the unsubscribe. */
export function onReconcileEvent(fn: (e: ReconcileEvent) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
function emit(e: ReconcileEvent): void {
  if (!e.ids.length) return;
  for (const fn of listeners) {
    try {
      fn(e);
    } catch {
      // a listener's defect is its own
    }
  }
}

// ---- one job per project at a time ------------------------------------------------------------------------

const queues = new Map<string, Promise<unknown>>();
const running = new Set<string>();
function exclusive<T>(orgId: string, projectId: string, fn: () => Promise<T>): Promise<T> {
  const key = `${orgId}/${projectId}`;
  const next = (queues.get(key) ?? Promise.resolve()).then(async () => {
    running.add(key);
    try {
      return await fn();
    } finally {
      running.delete(key);
    }
  });
  queues.set(
    key,
    next.catch(() => undefined),
  );
  return next;
}

// ---- state --------------------------------------------------------------------------------------------------

const openConflictOf = (conflicts: Conflict[], id: string): Conflict | undefined => conflicts.find((c) => c.state === "open" && (c.a === id || c.b === id));
const pairKey = (x: string, y: string) => (x < y ? `${x}\n${y}` : `${y}\n${x}`);
const checked = (x: DecisionRow, y: DecisionRow) => !!x.checkedWith?.includes(y.id) || !!y.checkedWith?.includes(x.id);
const markChecked = (x: DecisionRow, y: DecisionRow) => {
  x.checkedWith = [...new Set([...(x.checkedWith ?? []), y.id])];
  y.checkedWith = [...new Set([...(y.checkedWith ?? []), x.id])];
};

/** The record a promoted row should have in the current spec, and whether the spec has it. */
function upToDate(d: DecisionRow, byId: Map<string, DecisionRow>, current: Record<string, unknown>): boolean {
  if (!d.recordId) return false;
  const also = foldedRows(d, byId);
  if (JSON.stringify(current[d.recordId]) !== JSON.stringify(manifestRecord(d, undefined, also))) return false;
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

/** Whether the author may decide the row's area: the operator; an active person whose operator-set
    `decides` covers it (a self-asserted say does not count); or, in an area no one on the roster
    decides, the project's main stakeholder. */
export function authorOwnsArea(orgId: string, roster: Person[], d: Pick<DecisionRow, "by" | "areaKey">, trusted = decidesTrusted, stakeholder?: string | null): boolean {
  if (d.by === OPERATOR) return true;
  const { owners, via } = ownersOf(roster, d.areaKey, stakeholder);
  const p = owners.find((x) => x.id === d.by);
  if (!p) return false;
  return via === "stakeholder" || trusted(orgId, p, d.areaKey);
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
  }
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
    ...(frozen && last !== undefined ? { editedOutside: specHash(root) !== last } : {}),
  };
}

function info(orgId: string, projectId: string, store: DecisionStore, conflicts: Conflict[]): DecisionsInfo {
  return {
    decisions: [...store.decisions].sort((a, b) => b.at.localeCompare(a.at)),
    conflicts: [...conflicts].sort((a, b) => (a.state === b.state ? b.createdAt.localeCompare(a.createdAt) : a.state === "open" ? -1 : 1)),
    spec: specStatus(orgId, projectId, store),
    lastRun: store.lastRun,
    running: running.has(`${orgId}/${projectId}`),
    names: namesOf(orgId),
  };
}

/** GET …/decisions: the index, synced from the transcripts. */
export function listDecisions(orgId: string, projectId: string): DecisionsInfo {
  const { store } = syncDecisions(orgId, projectId);
  const conflicts = readConflicts(orgId, projectId);
  const project = projectOf(orgId, projectId);
  settleStates(store, conflicts, project.root, orgId, project.stakeholder);
  return info(orgId, projectId, store, conflicts);
}

export function specStatusOf(orgId: string, projectId: string): SpecStatus {
  return specStatus(orgId, projectId, readDecisionStore(orgId, projectId));
}

/** PATCH …/spec {frozen}: stored on the project (projects.json). */
export function setFrozen(orgId: string, projectId: string, frozen: boolean): SpecStatus {
  projectOf(orgId, projectId);
  patchProject(orgId, projectId, { spec: { frozen } });
  const store = readDecisionStore(orgId, projectId);
  if (frozen) {
    store.lastPromotedSpec = specHash(projectOf(orgId, projectId).root);
    writeDecisionStore(orgId, projectId, store);
  }
  return specStatus(orgId, projectId, store);
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
export function routeConflict(orgId: string, roster: Person[], areaKey: string, area: string, authors: string[], trusted = decidesTrusted, stakeholder?: string | null): Route {
  const { owners, via } = ownersOf(roster, areaKey, stakeholder);
  if (!owners.length) return { to: OPERATOR, reason: `Nobody on the roster decides ${area}.` };
  if (via === "stakeholder") return { to: owners[0]!.id, reason: `${owners[0]!.name} is this project's main stakeholder.` };
  const pick = owners.find((p) => !authors.includes(p.id)) ?? owners[0]!;
  if (!trusted(orgId, pick, areaKey)) return { to: OPERATOR, reason: `${pick.name}'s say over ${area} was not set by ${operatorName()} (self-asserted).`, selfAsserted: true };
  return { to: pick.id, reason: `${pick.name} decides ${area}.` };
}

function batonFor(c: Conflict, a: DecisionRow, b: DecisionRow, area: string): BatonStartInput {
  const side = (label: string, d: DecisionRow) => `${label} (${d.name}, ${d.at.slice(0, 10)}): ${d.statement}\n  Their words: "${d.quote}"`;
  return {
    orgId: c.orgId,
    projectId: c.projectId,
    to: c.routedTo,
    publicTitle: clipText(`Settle: ${area}`, 120),
    goal: clipText(
      `Two recorded decisions about ${area} contradict each other. Find out from the person you are talking to which one holds, ` +
        `or what the decision is instead. Record the answer with record_decision in the area "${area}", with their exact words, then finish with goal_done.\n\n` +
        `${side("A", a)}\n${side("B", b)}`,
      2000,
    ),
    question: clipText(`Two decisions about ${area} disagree. ${a.name}: "${a.statement}" ${b.name}: "${b.statement}" Which one holds?`, 1000),
  };
}

// ---- the run -------------------------------------------------------------------------------------------------

export interface ReconcileOptions {
  /** Start a baton session for each new conflict (default true). */
  route?: boolean;
  /** Who owns those sessions (default the operator). */
  owner?: BatonOwner;
  /** Started by Sova itself (a routed conflict's answer): with the switch off it is skipped and
      recorded in lastRun.error instead of refused. */
  auto?: boolean;
  /** The settle sessions' model and thinking (the project overseer passes its gathering choice);
      default: the project's gathering model (settleChoice). */
  model?: string;
  thinking?: string;
}

/**
 * The model and thinking of a settle session (the person talks to it, like any gathering
 * session): the project's `gatheringModel`/`gatheringThinking`, else the overseer's own setting,
 * else nothing (the new-session default). For every settle session, the operator's included.
 */
export function settleChoice(orgId: string, projectId: string): { model?: string; thinking?: string } {
  try {
    const s = readPoSettings(projectOverseerPaths(orgId, projectId));
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

/** POST …/reconcile, and the project overseer's sova_reconcile. */
export function reconcileProject(orgId: string, projectId: string, opts: ReconcileOptions = {}): Promise<DecisionsInfo> {
  return exclusive(orgId, projectId, async () => {
    const d = await currentDeps();
    const project = projectOf(orgId, projectId);
    if (!d.enabled()) {
      if (!opts.auto) throw new OrgError(RECONCILE_OFF, 409);
      const store = readDecisionStore(orgId, projectId);
      store.lastRun = { at: d.now().toISOString(), compared: 0, found: 0, error: RECONCILE_OFF };
      writeDecisionStore(orgId, projectId, store);
      return listDecisions(orgId, projectId);
    }
    const { store } = syncDecisions(orgId, projectId);
    const conflicts = readConflicts(orgId, projectId);
    const now = d.now();
    const byId = new Map(store.decisions.map((x) => [x.id, x]));
    const run = { at: now.toISOString(), compared: 0, found: 0 } as NonNullable<DecisionStore["lastRun"]>;
    const newConflicts: string[] = [];
    const resolved: string[] = [];
    settleStates(store, conflicts, project.root, orgId, project.stakeholder);
    try {
      if (d.excluded(project.root)) throw new DecisionError("unavailable", "This project's folder is excluded in Settings → Decisions.");
      const provider = d.provider();
      if (!provider) throw new DecisionError("unavailable", "No decision provider is ready (Settings → Decisions).");
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
          const route = routeConflict(orgId, roster, areaKey, area, [x.by, y.by], decidesTrusted, project.stakeholder);
          const c: Conflict = {
            id: shortId("cf_"),
            orgId,
            projectId,
            areaKey,
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

    // Route the new conflicts (a failure here leaves the conflict open, routable by hand).
    if (opts.route !== false)
      for (const id of newConflicts) {
        const c = conflicts.find((x) => x.id === id)!;
        try {
          startConflictBaton(d, c, byId, opts.owner, opts.model || opts.thinking ? { ...(opts.model ? { model: opts.model } : {}), ...(opts.thinking ? { thinking: opts.thinking } : {}) } : undefined);
        } catch (err) {
          run.error = `${run.error ? `${run.error}; ` : ""}routing ${c.id}: ${err instanceof Error ? err.message : String(err)}`;
        }
      }

    store.lastRun = run;
    assignRecordIds(project.root, store);
    writeDecisionStore(orgId, projectId, store);
    writeConflicts(orgId, projectId, conflicts);
    const draftedIds = await refreshDraft(orgId, projectId, store).catch((err) => {
      store.lastRun = { ...run, error: `${run.error ? `${run.error}; ` : ""}draft: ${err instanceof Error ? err.message : String(err)}` };
      writeDecisionStore(orgId, projectId, store);
      return [] as string[];
    });
    emit({ type: "resolved", orgId, projectId, ids: resolved });
    emit({ type: "conflict", orgId, projectId, ids: newConflicts });
    emit({ type: "drafted", orgId, projectId, ids: draftedIds });
    return info(orgId, projectId, store, conflicts);
  });
}

function startConflictBaton(d: ReconcileDeps, c: Conflict, byId: Map<string, DecisionRow>, owner?: BatonOwner, choice: { model?: string; thinking?: string } = settleChoice(c.orgId, c.projectId)): void {
  const a = byId.get(c.a);
  const b = byId.get(c.b);
  if (!a || !b) throw new OrgError("The conflict's decisions are gone", 409);
  const area = a.area;
  // No link is minted here (nobody could be shown it): Needs-you asks the operator to send one.
  const created = d.startBaton({ ...batonFor(c, a, b, area), ...choice, ...(owner ? { owner } : {}), mintLink: false });
  c.batonSessionId = created.sessionId;
  c.batonPath = created.path;
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

/** POST …/draft: rewrite the draft from the index without comparing anything. */
export function draftProject(orgId: string, projectId: string): Promise<DecisionsInfo> {
  return exclusive(orgId, projectId, async () => {
    const project = projectOf(orgId, projectId);
    const { store } = syncDecisions(orgId, projectId);
    const conflicts = readConflicts(orgId, projectId);
    settleStates(store, conflicts, project.root, orgId, project.stakeholder);
    assignRecordIds(project.root, store);
    writeDecisionStore(orgId, projectId, store);
    const ids = await refreshDraft(orgId, projectId, store);
    emit({ type: "drafted", orgId, projectId, ids });
    return info(orgId, projectId, store, conflicts);
  });
}

// ---- conflicts by hand -----------------------------------------------------------------------------------

/** POST …/conflicts/:cid/route {to?}: start (or restart) the conflict's baton session. */
export function routeConflictNow(orgId: string, projectId: string, conflictId: string, to?: string, owner?: BatonOwner): Promise<DecisionsInfo> {
  return exclusive(orgId, projectId, async () => {
    const d = await currentDeps();
    const project = projectOf(orgId, projectId);
    const { store } = syncDecisions(orgId, projectId);
    const conflicts = readConflicts(orgId, projectId);
    const c = conflicts.find((x) => x.id === conflictId);
    if (!c) throw new OrgError("Unknown conflict", 404);
    if (c.state !== "open") throw new OrgError("That conflict is resolved", 409);
    if (to) {
      const roster = readRoster(orgId);
      if (to !== OPERATOR && !roster.some((p) => p.id === to && p.status === "active")) throw new OrgError("Route to an active person or the operator");
      c.routedTo = to;
      c.routeReason = `${to === OPERATOR ? operatorName() : roster.find((p) => p.id === to)!.name} chosen by ${operatorName()}.`;
      delete c.selfAsserted;
    }
    const previous = c.batonSessionId;
    startConflictBaton(d, c, new Map(store.decisions.map((x) => [x.id, x])), owner);
    // The earlier session asked someone else: close it so two people are never asked the same thing.
    const old = previous ? batonById(previous)?.row : undefined;
    if (old && old.state !== "closed") await d.endBaton(old.sessionId);
    writeConflicts(orgId, projectId, conflicts);
    settleStates(store, conflicts, project.root, orgId, project.stakeholder);
    return info(orgId, projectId, store, conflicts);
  });
}

/** POST …/conflicts/:cid/resolve: the operator keeps a side, both, or states the decision. */
export function resolveConflict(orgId: string, projectId: string, conflictId: string, input: ConflictResolveInput): Promise<DecisionsInfo> {
  return exclusive(orgId, projectId, async () => {
    const d = await currentDeps();
    const project = projectOf(orgId, projectId);
    const { store } = syncDecisions(orgId, projectId);
    const conflicts = readConflicts(orgId, projectId);
    const c = conflicts.find((x) => x.id === conflictId);
    if (!c) throw new OrgError("Unknown conflict", 404);
    if (c.state !== "open") throw new OrgError("That conflict is resolved", 409);
    const a = store.decisions.find((x) => x.id === c.a);
    const b = store.decisions.find((x) => x.id === c.b);
    if (!a || !b) throw new OrgError("The conflict's decisions are gone", 409);
    const now = d.now();
    if ("statement" in input) {
      const statement = typeof input.statement === "string" ? input.statement.trim() : "";
      if (!statement || statement.length > 500) throw new OrgError("statement must be 1–500 characters");
      const r = operatorDecision(orgId, projectId, { area: a.area, areaKey: c.areaKey, statement, now, markerId: shortId("") });
      store.decisions.push(r);
      applyOutcome(c, a, b, r, "neither", now);
    } else if (input.keep === "a" || input.keep === "b" || input.keep === "both") applyOutcome(c, a, b, null, input.keep, now);
    else throw new OrgError('Expected { keep: "a" | "b" | "both" } or { statement }');
    // Settled by hand: the session still asking someone about it is over, and so is its Needs-you item.
    const asking = c.batonSessionId ? batonById(c.batonSessionId)?.row : undefined;
    if (asking && asking.state !== "closed") await d.endBaton(asking.sessionId);
    settleStates(store, conflicts, project.root, orgId, project.stakeholder);
    assignRecordIds(project.root, store);
    writeDecisionStore(orgId, projectId, store);
    writeConflicts(orgId, projectId, conflicts);
    await refreshDraft(orgId, projectId, store).catch(() => []);
    emit({ type: "resolved", orgId, projectId, ids: [c.id] });
    return info(orgId, projectId, store, conflicts);
  });
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

/** POST …/promote {ids}: piecemeal, operator-triggered (or the project overseer at L2+). */
/** Who asked for a promotion: only the operator naming ids one by one may promote a decision made
    outside its author's decision area. */
export type PromoteMode = "operator-explicit" | "bulk" | "overseer";

export function promoteDecisions(orgId: string, projectId: string, ids: string[], opts: { by: PromoteMode } = { by: "operator-explicit" }): Promise<PromoteResult> {
  return exclusive(orgId, projectId, async () => {
    const d = await currentDeps();
    const project = projectOf(orgId, projectId);
    const { store } = syncDecisions(orgId, projectId);
    const conflicts = readConflicts(orgId, projectId);
    settleStates(store, conflicts, project.root, orgId, project.stakeholder);
    assignRecordIds(project.root, store);
    const refused: PromoteResult["refused"] = [];
    const rows: DecisionRow[] = [];
    for (const id of [...new Set(ids)]) {
      const row = store.decisions.find((x) => x.id === id);
      if (!row) refused.push({ id, reason: "unknown decision" });
      else if (row.state !== "drafted") refused.push({ id, reason: `it is ${row.state}; only a reconciled (drafted) decision can be promoted` });
      else if (!row.authorOwnsArea && opts.by !== "operator-explicit") refused.push({ id, reason: `outside ${row.name}'s decision area: promote it explicitly by id` });
      else rows.push(row);
    }
    let promoted: string[] = [];
    let draft: string | undefined;
    let commit: PromoteCommit | undefined;
    if (rows.length) {
      const edit = editFor(store, rows, project.root);
      // What git sees in the root's spec before the promotion, so the commit takes only its own changes.
      const snap = await specSnapshot(project.root).catch(() => null);
      try {
        const out = await promoteEdit(project.root, edit, (rid) => verificationFor(store, rid, conflicts), d.now());
        if (out.draft) draft = out.draft;
        const now = d.now().toISOString();
        const done = new Set(out.promoted);
        for (const r of rows) if (r.recordId && (done.has(r.recordId) || currentRecordIds(project.root).has(r.recordId))) {
          r.promotedAt = now;
          promoted.push(r.id);
        }
        store.lastPromotedSpec = specHash(project.root);
        if (snap && promoted.length) commit = await commitSpec(snap, promotionMessage(rows.filter((r) => promoted.includes(r.id)))).catch((err) => ({ skipped: `Not committed: ${err instanceof Error ? err.message : String(err)}` }));
      } catch (err) {
        const reason = err instanceof SpecToolError || err instanceof Error ? err.message : String(err);
        for (const r of rows) refused.push({ id: r.id, reason });
        promoted = [];
      }
    }
    settleStates(store, conflicts, project.root, orgId, project.stakeholder);
    writeDecisionStore(orgId, projectId, store);
    await refreshDraft(orgId, projectId, store).catch(() => []);
    emit({ type: "promoted", orgId, projectId, ids: promoted, by: opts.by });
    return { info: info(orgId, projectId, store, conflicts), promoted, refused, ...(draft ? { draft } : {}), ...(commit ? { commit } : {}) };
  });
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

// ---- resolutions as they happen -----------------------------------------------------------------------------

let watching: (() => void) | null = null;
const pendingRuns = new Map<string, ReturnType<typeof setTimeout>>();

/**
 * A decision recorded in a conflict's baton session settles it (or, once settled, is compared and
 * folded) without waiting for the next Reconcile: run the project's reconciler shortly after
 * (debounced; one run per project). Other
 * decisions wait for the operator or the project overseer. Idempotent; returns the stop.
 */
export function watchResolutions(delayMs = 2000): () => void {
  if (watching) return watching;
  const off = onBatonEvent((e) => {
    if (e.type !== "decision") return;
    let open: Conflict[];
    try {
      // Resolved too: a second confirmation in the same session is folded without a Reconcile click.
      open = readConflicts(e.orgId, e.projectId).filter((c) => c.batonSessionId === e.sessionId);
    } catch {
      return;
    }
    if (!open.length) return;
    const key = `${e.orgId}/${e.projectId}`;
    clearTimeout(pendingRuns.get(key));
    pendingRuns.set(
      key,
      setTimeout(() => {
        pendingRuns.delete(key);
        reconcileProject(e.orgId, e.projectId, { auto: true }).catch((err) => console.warn(`[reconcile] ${key}: ${err instanceof Error ? err.message : String(err)}`));
      }, delayMs),
    );
  });
  watching = () => {
    off();
    for (const t of pendingRuns.values()) clearTimeout(t);
    pendingRuns.clear();
    watching = null;
  };
  return watching;
}

export { areaId };
