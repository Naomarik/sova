/**
 * Wire types for per-conversation spec drafts (§app.requirements/conversation-drafts, /lock-in,
 * /draft-specs, /draft-approval). Imported by the server and the operator app, so it imports
 * nothing at runtime.
 *
 * Operator routes (main listener only; never on the share listener):
 * GET  /api/draft-specs?project=<pid>                        -> { drafts: DraftSpecSummary[] } (every project when omitted)
 * POST /api/projects/:pid/draft-specs/:sessionId/approve     body { items?: string[] } -> DraftApproveResult
 * POST /api/projects/:pid/draft-specs/:sessionId/build       body { items?: string[] } -> DraftBuildResult
 *
 * The conversation's person never sees any of it: the chat says only a plain-words summary.
 */

export type DraftState = "unconfirmed" | "confirmed";
export type ConversationKind = "gathering" | "settle" | "assistant";
export type DraftItemStatus = "agreed" | "approved" | "promoted" | "built" | "dropped";

export interface DraftItem {
  /** "r1", "r2", … within its conversation (what requirement_drop names). */
  id: string;
  /** new behaviour, or a change to behaviour the spec describes (`target`). */
  kind: "new" | "change";
  /** A short title (the statement, cut). */
  title: string;
  /** The requirement: the decision's statement. */
  text: string;
  /** What it is about, as recorded ("Content editing"); files its record under `§requirements.<areaKey>/`. */
  area: string;
  areaKey: string;
  /** The person's own words (operator-side only). */
  quote: string;
  /** The § id it changes (change items). Server-side only. */
  target?: string;
  /** SHA-256 of the target's prose in the current spec when it was agreed. */
  basedOnHash?: string;
  /** Its record in the draft (`§requirements.<areaKey>/<slug>`), kept from one rebuild to the next. */
  recordId?: string;
  agreedAt: string;
  /** The person id who agreed it, or "operator" (operator-side only). */
  by?: string;
  /** Their name then (operator-side only). */
  name?: string;
  /** The decision it is (`<sessionId>:<markerId>`), and the user message holding the quote. */
  decisionId?: string;
  entryId?: string;
  /** Why it clashes with the current spec now ("changed" | "gone"); null/absent when it doesn't. */
  clash?: string | null;
  status: DraftItemStatus;
  /** The coding session the operator started to build it (a change), when one was. */
  buildSessionId?: string;
  /** The branch a Build carried this conversation's draft onto (its worktree's): the item becomes official
      when that branch lands, so Approve and the reconciler's promotion leave it to the branch. */
  buildBranch?: string;
  /** When the operator approved it. */
  approvedAt?: string;
  /** Seeded at rollout from a decision recorded before conversation drafts. */
  seeded?: boolean;
}

export interface ConversationDraftRecord {
  version: 1;
  sessionId: string;
  projectId: string;
  orgId?: string;
  kind: ConversationKind;
  /** The draft's name: `conv-<sid20>` (assistant: `conv-<sid20>-<pid>`). */
  draft: string;
  /** A hash of the current spec the draft was last rebuilt on (null: never built). */
  baseSha: string | null;
  state: DraftState;
  summaryShownAt?: string | null;
  /** The conversation's leaf when the summary was given: the person's yes must come after it. */
  summaryLeaf?: string | null;
  confirmedAt?: string | null;
  /** The summary the person confirmed, as the chat gave it to requirements_confirm. */
  confirmedSummary?: string | null;
  items: DraftItem[];
  /** The person the conversation is with (operator-side only). */
  person?: { id: string; name: string };
  /** The conversation's title for the operator (a gathering's public title). */
  title?: string;
  /** What the last rebuild was made from (main line + items), so an unchanged catch-up does nothing. */
  builtFrom?: string | null;
  /** The recorded decisions were seeded as items (rollout), once. */
  seeded?: boolean;
  updatedAt: string;
}

/** One conversation's draft compared with the main line's current spec. */
export interface DraftSpecSummary {
  sessionId: string;
  projectId: string;
  projectName: string;
  /** The person's name. */
  person?: string;
  title: string;
  kind: ConversationKind;
  state: DraftState;
  /** The draft's name. */
  draft: string;
  newItems: DraftItem[];
  /** Change items, each with the current text of the record it changes (absent when it is gone). */
  changes: (DraftItem & { currentText?: string })[];
  clashes: number;
  updatedAt: string;
}

export interface DraftApproveResult {
  /** Item ids promoted into the current spec now (new requirements). */
  promoted: string[];
  /** Item ids approved, waiting for a coding session to build them (changes, and new items a Build carried onto its branch). */
  waitingForBuild: string[];
  /** Item ids whose decision the legacy path had already promoted (marked promoted, not promoted again). */
  alreadyPromoted: string[];
  /** The promotion's commit in the project root, when it made one (as PromoteResult.commit). */
  commit?: { sha: string; branch: string; files: string[]; message: string } | { skipped: string };
  draft: DraftSpecSummary;
}

/** POST …/build answers 202 with this. */
export interface DraftBuildResult {
  /** The coding session started. */
  sessionId: string;
  title: string;
  path?: string;
  /** The item ids it was asked to build. */
  items: string[];
  /** The branch the conversation's draft was carried onto (its worktree), when it was. */
  branch?: string;
}

/** At most this many items in one conversation's record. */
export const DRAFT_ITEMS_MAX = 200;
/** A confirmed summary is kept up to this many characters. */
export const DRAFT_SUMMARY_MAX = 8000;
