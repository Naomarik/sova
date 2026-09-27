/**
 * Wire types for decisions, their reconciliation and their promotion into a project's own spec
 * (§app/requirements). Imported by the server, the operator app and the project overseer, so it
 * imports nothing at runtime.
 *
 * Source of truth: the `sova-baton-decision` entries in the baton transcripts (shared/baton.ts).
 * The index below is derived from them and kept in the org's workspace repo:
 *   <workspace>/projects/<projectId>/decisions.json   { version: 1, decisions: DecisionRow[] }
 *   <workspace>/projects/<projectId>/conflicts.json   { version: 1, conflicts: Conflict[] }
 *
 * Operator routes (main listener only; never on the share listener):
 * GET   /api/orgs/:id/projects/:pid/decisions            -> DecisionsInfo (syncs the index from the transcripts first)
 * GET   /api/orgs/:id/projects/:pid/conflicts            -> Conflict[] (open first, then newest)
 * POST  /api/orgs/:id/projects/:pid/reconcile            -> DecisionsInfo (compare, route conflicts, draft the clean ones)
 * POST  /api/orgs/:id/projects/:pid/draft                -> DecisionsInfo (rewrite the project draft from the index)
 * POST  /api/orgs/:id/projects/:pid/promote              body { ids: string[] (DecisionRow ids), bulk?: boolean } -> PromoteResult
 *                                                        (bulk = "Select all ready": out-of-area decisions are refused;
 *                                                        default false = the operator named each id: allowed)
 * POST  /api/orgs/:id/projects/:pid/conflicts/:cid/route  body { to?: PersonRef } -> DecisionsInfo (start its baton session now)
 * POST  /api/orgs/:id/projects/:pid/conflicts/:cid/resolve body ConflictResolveInput -> DecisionsInfo (the operator decides)
 * GET   /api/orgs/:id/projects/:pid/spec                 -> SpecStatus
 * PATCH /api/orgs/:id/projects/:pid/spec                 body { frozen: boolean } -> SpecStatus
 */

/** Who stated a decision, where and when, in their own words. Also the `provenance` field of a
    spec record (an array: a resolution cites every decision it settles). */
export interface Provenance {
  /** A roster person's id, or "operator". */
  by: string;
  /** Their display name when the decision was recorded. */
  name: string;
  /** "" for a decision the operator stated on the project page (a conflict's resolution). */
  sessionId: string;
  /** The user message holding the quote (the last one before the decision entry); the decision
      entry's own id when none precedes it. */
  entryId: string;
  /** ISO time the decision was recorded. */
  at: string;
  quote: string;
}

/**
 * - `pending`: not compared yet (or its last comparison failed).
 * - `drafted`: compared with every other live decision of its area, no open conflict, written to
 *   the project's draft: promotable.
 * - `conflict`: part of an open Conflict.
 * - `promoted`: in the project's current spec.
 * - `superseded`: a later decision replaced it (`supersededBy`).
 */
export type DecisionState = "pending" | "drafted" | "promoted" | "superseded" | "conflict";

export interface DecisionRow {
  /** `${sessionId}:${markerId}`: stable, one per decision entry. */
  id: string;
  orgId: string;
  projectId: string;
  /** As recorded ("Invoicing"). */
  area: string;
  /** The spec area it files under: `§requirements/<areaKey>` (lowercase letters and hyphens). */
  areaKey: string;
  statement: string;
  quote: string;
  /** A roster person's id, or "operator". */
  by: string;
  name: string;
  /** ISO time of the decision entry. */
  at: string;
  sessionId: string;
  /** The quote's user message (Provenance.entryId). */
  entryId: string;
  /** The `sova-baton-decision` entry's own id. */
  markerId: string;
  /** The author may decide this area: the operator, or an active person whose `decides` (set by
      the operator, not self-asserted) covers `areaKey`. Out-of-area decisions are promoted only
      by the operator naming them explicitly. */
  authorOwnsArea: boolean;
  /** The session file on this host, for #/s/<path>; null when it is not here. */
  sessionPath: string | null;
  state: DecisionState;
  /** Its spec record id, once drafted: `§requirements.<areaKey>/<slug>`. */
  recordId?: string;
  /** The DecisionRow id that replaced it. */
  supersededBy?: string;
  /** Decisions that restated this one (a conflict's resolution that kept it): superseded by it,
      their quotes and provenance join its spec record. */
  folded?: string[];
  /** The Conflict this decision settles (it was recorded in that conflict's baton session). */
  resolves?: string;
  /** Other DecisionRow ids of the same area it was found consistent with; absent until a
      successful reconcile run has filed and compared it. */
  checkedWith?: string[];
  promotedAt?: string;
}

export interface Conflict {
  /** "cf_" + 8 chars. */
  id: string;
  orgId: string;
  projectId: string;
  areaKey: string;
  /** DecisionRow ids; `a` is the older. */
  a: string;
  b: string;
  /** P(they contradict), from the decide seam. */
  p: number;
  /** A roster person's id, or "operator". */
  routedTo: string;
  /** Why that person: "Tony Reyes decides invoicing", "nobody decides invoicing", "… is self-asserted". */
  routeReason: string;
  /** The owner of the area claimed it themselves (no operator or referral evidence): routed to the operator. */
  selfAsserted?: boolean;
  /** The baton session asking `routedTo` to settle it. */
  batonSessionId?: string;
  /** That session's file on this host, for #/s/<path>. */
  batonPath?: string;
  state: "open" | "resolved";
  /** The DecisionRow that settled it (a new decision, or the side the operator kept). */
  resolvedBy?: string;
  /** Which side survived: a, b, both (not a real conflict) or neither (a new decision replaced both). */
  outcome?: "a" | "b" | "both" | "neither";
  createdAt: string;
  resolvedAt?: string;
}

export type ConflictResolveInput =
  /** Keep one side (the other is superseded by it), or both (not a contradiction). */
  | { keep: "a" | "b" | "both" }
  /** The operator states the decision; it supersedes both. */
  | { statement: string };

export interface SpecStatus {
  /** The project root's `.sova/spec` (absolute, on this host). */
  specRoot: string;
  /** A current spec exists (manifest.json). */
  exists: boolean;
  /** Only the reconciler's promotion writes claims/ (a rule of Sova's; a coding session's tools can't be stopped). */
  frozen: boolean;
  /** The project draft the writer keeps, when one exists. */
  draft: string | null;
  /** `§requirements/…` records in the current spec. */
  promoted: number;
  /** Records in the draft not yet promoted. */
  drafted: number;
  /** Frozen only: the current spec changed since the reconciler last wrote it (someone edited claims/ directly). */
  editedOutside?: boolean;
}

export interface ReconcileRun {
  at: string;
  /** Pairs asked about. */
  compared: number;
  /** New conflicts. */
  found: number;
  error?: string;
}

export interface DecisionsInfo {
  /** Newest first. */
  decisions: DecisionRow[];
  /** Open first, then newest. */
  conflicts: Conflict[];
  spec: SpecStatus;
  lastRun: ReconcileRun | null;
  running: boolean;
  /** personId → name, for routedTo / by. */
  names: Record<string, string>;
}

export interface PromoteResult {
  info: DecisionsInfo;
  /** DecisionRow ids promoted. */
  promoted: string[];
  refused: { id: string; reason: string }[];
  /** The kept draft under the project's .sova/spec/drafts/ whose draft.json holds this promotion's evidence. */
  draft?: string;
  /** The commit of the changed `.sova/spec/` files in the project root (a git root only), or why it
      was skipped (the promotion itself stands). Absent: nothing was promoted, or the root is not in git. */
  commit?: PromoteCommit;
}

export type PromoteCommit = { sha: string; branch: string; files: string[]; message: string } | { skipped: string };

/** In-process events (server/reconcile.ts `onReconcileEvent`). */
export interface ReconcileEvent {
  type: "conflict" | "resolved" | "promoted" | "drafted";
  orgId: string;
  projectId: string;
  /** DecisionRow ids, or Conflict ids for conflict/resolved. */
  ids: string[];
  /** promoted: who asked (the operator by id or in bulk, or the project overseer). */
  by?: "operator-explicit" | "bulk" | "overseer";
}

/** Settings → Decisions "Reconcile decisions" when the settings file doesn't say. */
export const RECONCILE_DEFAULT = true;
/** What every refused or skipped reconcile says while the switch is off. */
export const RECONCILE_OFF = "Turn on Reconcile decisions in Settings → Decisions.";

/** Contradiction threshold: a pair at or above it is a conflict. */
export const CONFLICT_P = 0.7;
/** Spec namespace every decision files under. */
export const REQUIREMENTS_NS = "requirements";

/**
 * Everything folded into `d`, and into what was folded into it, depth-first in folding order, each
 * once (never `d` itself, even on a cycle). Its quotes all join `d`'s record (§app.requirements/reconciler).
 */
export function foldedRows<T extends Pick<DecisionRow, "id" | "folded">>(d: T, byId: ReadonlyMap<string, T>): T[] {
  const seen = new Set([d.id]);
  const out: T[] = [];
  const walk = (row: T) => {
    for (const id of row.folded ?? []) {
      const next = byId.get(id);
      if (!next || seen.has(id)) continue;
      seen.add(id);
      out.push(next);
      walk(next);
    }
  };
  walk(d);
  return out;
}
