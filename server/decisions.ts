import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { BATON_DECISION_ENTRY, OPERATOR, type BatonDecisionData, type BatonSession } from "../shared/baton";
import type { Conflict, DecisionRow, DecisionState, Provenance, ReconcileRun } from "../shared/decisions";
import type { Person } from "../shared/orgs";
import { allBatons, sessionPathOf } from "./baton";
import { operatorName, orgDir, OrgError, readProjects, readRoster } from "./orgs";

/**
 * The decision index (§app.requirements/decisions): every `sova-baton-decision` entry of a
 * project's baton sessions, with who said it, where, when and in which words. The transcripts are
 * the source; the index adds only what the reconciler decided about each one (state, spec record,
 * superseded-by, what it was compared with). It lives in the org's workspace repo:
 *
 *   <workspace>/projects/<projectId>/decisions.json   { version: 1, decisions, lastRun }
 *   <workspace>/projects/<projectId>/conflicts.json   { version: 1, conflicts }
 *
 * Transcripts are read with our own line parser (never SessionManager.open, which may write).
 */

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

export const projectStoreDir = (orgId: string, projectId: string): string => join(orgDir(orgId), "projects", projectId);
const decisionsFile = (orgId: string, projectId: string) => join(projectStoreDir(orgId, projectId), "decisions.json");
const conflictsFile = (orgId: string, projectId: string) => join(projectStoreDir(orgId, projectId), "conflicts.json");

function readJson(file: string): unknown {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
}

function writeJson(file: string, value: unknown): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(tmp, file);
}

/** The project, or a 404. */
export function projectOf(orgId: string, projectId: string) {
  const p = readProjects(orgId).find((x) => x.id === projectId);
  if (!p) throw new OrgError("Unknown project", 404);
  return p;
}

// ---- store -----------------------------------------------------------------------------------------

export interface DecisionStore {
  decisions: DecisionRow[];
  lastRun: ReconcileRun | null;
  /** specHash of the project's spec right after the reconciler last wrote it (frozen check). */
  lastPromotedSpec?: string;
}

export function readDecisionStore(orgId: string, projectId: string): DecisionStore {
  const raw = readJson(decisionsFile(orgId, projectId));
  const decisions = isObj(raw) && Array.isArray(raw.decisions) ? raw.decisions.filter((d): d is DecisionRow => isObj(d) && typeof d.id === "string" && typeof d.statement === "string") : [];
  const lastRun = isObj(raw) && isObj(raw.lastRun) && typeof raw.lastRun.at === "string" ? (raw.lastRun as unknown as ReconcileRun) : null;
  const lastPromotedSpec = isObj(raw) && typeof raw.lastPromotedSpec === "string" ? raw.lastPromotedSpec : undefined;
  return { decisions, lastRun, ...(lastPromotedSpec !== undefined ? { lastPromotedSpec } : {}) };
}

export function writeDecisionStore(orgId: string, projectId: string, store: DecisionStore): void {
  writeJson(decisionsFile(orgId, projectId), { version: 1, decisions: store.decisions, lastRun: store.lastRun, ...(store.lastPromotedSpec !== undefined ? { lastPromotedSpec: store.lastPromotedSpec } : {}) });
}

/** A conflict's settle session is found by its id on THIS host (§app.organizations/portability):
    `batonPath` is derived on every read, never taken from the repo, and absent when the session is
    unknown here. */
export function readConflicts(orgId: string, projectId: string): Conflict[] {
  const raw = readJson(conflictsFile(orgId, projectId));
  const conflicts = isObj(raw) && Array.isArray(raw.conflicts) ? raw.conflicts.filter((c): c is Conflict => isObj(c) && typeof c.id === "string" && typeof c.a === "string") : [];
  if (!conflicts.length) return conflicts;
  const dir = orgDir(orgId);
  const paths = new Map(allBatons().filter((b) => b.orgId === orgId).map((b) => [b.sessionId, sessionPathOf(dir, b)]));
  return conflicts.map(({ batonPath: _stored, ...c }) => {
    const path = c.batonSessionId ? paths.get(c.batonSessionId) : undefined;
    return path ? { ...c, batonPath: path } : c;
  });
}

/** The repo holds no host path: `batonPath` is stripped (a read derives it again). */
export function writeConflicts(orgId: string, projectId: string, conflicts: Conflict[]): void {
  writeJson(conflictsFile(orgId, projectId), { version: 1, conflicts: conflicts.map(({ batonPath: _path, ...c }) => c) });
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

// ---- reading transcripts -------------------------------------------------------------------------------

interface RawEntry {
  type?: string;
  id?: string;
  parentId?: string | null;
  timestamp?: string;
  customType?: string;
  data?: unknown;
  message?: { role?: string };
}

function readEntries(file: string): RawEntry[] {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const out: RawEntry[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line);
      if (isObj(e)) out.push(e as RawEntry);
    } catch {
      // a torn trailing line: skip
    }
  }
  return out;
}

const nameIn = (roster: Person[], ref: string): string => (ref === OPERATOR ? operatorName() : (roster.find((p) => p.id === ref)?.name ?? ref));

/** The decisions one baton transcript holds, as fresh (pending) rows. Pure over the file. */
export function decisionsInSession(file: string, row: Pick<BatonSession, "sessionId" | "orgId" | "projectId">, roster: Person[], sessionPath: string | null): DecisionRow[] {
  const entries = readEntries(file);
  const byId = new Map<string, RawEntry>();
  for (const e of entries) if (typeof e.id === "string") byId.set(e.id, e);
  const out: DecisionRow[] = [];
  for (const e of entries) {
    if (e.type !== "custom" || e.customType !== BATON_DECISION_ENTRY || typeof e.id !== "string" || !isObj(e.data)) continue;
    const d = e.data as Partial<BatonDecisionData>;
    if (typeof d.area !== "string" || typeof d.statement !== "string" || typeof d.quote !== "string") continue;
    // The quote's location: the nearest user message up the tree.
    let entryId = e.id;
    let cur = e.parentId ? byId.get(e.parentId) : undefined;
    for (let hops = 0; cur && hops < 200; hops++) {
      if (cur.type === "message" && cur.message?.role === "user" && typeof cur.id === "string") {
        entryId = cur.id;
        break;
      }
      cur = cur.parentId ? byId.get(cur.parentId) : undefined;
    }
    const by = typeof d.by === "string" && d.by ? d.by : OPERATOR;
    out.push({
      id: `${row.sessionId}:${e.id}`,
      orgId: row.orgId,
      projectId: row.projectId,
      area: d.area,
      areaKey: areaKeyOf(d.area),
      statement: d.statement,
      quote: d.quote,
      by,
      name: nameIn(roster, by),
      at: typeof e.timestamp === "string" ? e.timestamp : new Date(0).toISOString(),
      sessionId: row.sessionId,
      entryId,
      markerId: e.id,
      sessionPath,
      state: "pending",
      authorOwnsArea: false,
    });
  }
  return out;
}

/** The provenance a row carries into the spec. */
export const provenanceOf = (d: DecisionRow): Provenance => ({ by: d.by, name: d.name, sessionId: d.sessionId, entryId: d.entryId, at: d.at, quote: d.quote });

/**
 * Bring the index up to date with the transcripts: add every decision entry not indexed yet
 * (pending), refresh session paths. Never drops a row (a transcript that went away keeps its
 * decisions; their provenance still names it). Returns the store and the ids added.
 */
export function syncDecisions(orgId: string, projectId: string): { store: DecisionStore; added: string[] } {
  projectOf(orgId, projectId);
  const dir = orgDir(orgId);
  const roster = readRoster(orgId);
  const store = readDecisionStore(orgId, projectId);
  const known = new Map(store.decisions.map((d) => [d.id, d]));
  const added: string[] = [];
  for (const b of allBatons()) {
    if (b.orgId !== orgId || b.projectId !== projectId) continue;
    const path = sessionPathOf(dir, b);
    for (const d of decisionsInSession(join(dir, b.file), b, roster, path)) {
      const old = known.get(d.id);
      if (old) {
        old.sessionPath = path;
        continue;
      }
      store.decisions.push(d);
      known.set(d.id, d);
      added.push(d.id);
    }
  }
  if (added.length) writeDecisionStore(orgId, projectId, store);
  return { store, added };
}

/** A decision the operator states on the project page (a conflict's resolution): no transcript. */
export function operatorDecision(orgId: string, projectId: string, input: { area: string; areaKey: string; statement: string; now?: Date; markerId: string }): DecisionRow {
  const at = (input.now ?? new Date()).toISOString();
  return {
    id: `operator:${input.markerId}`,
    orgId,
    projectId,
    area: input.area,
    areaKey: input.areaKey,
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
