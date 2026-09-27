/**
 * Wire types of the Owner page (§app/owner-page): one read-only page where an organization's owner
 * (one active roster person, set by the operator) follows every project the operator shows them.
 * Imported by the server, the operator app and the share build (src/share/), so it imports only
 * shared/baton.ts types and nothing at runtime.
 *
 * Every answer is built field by field on the server (server/owner-page.ts, `ownerView`). No id of
 * Sova's leaves the server: projects and conversations are named by host-derived handles (`q_…`,
 * `k_…`) that mean nothing without the link. Never on it: the org's About text, roles, voices,
 * contacts, goals, briefings to others, the project overseer's notes or conversation, coding
 * titles or paths, costs, tokens, visits, link states.
 *
 * Share listener (read-only; no POST, no socket):
 * GET /i/<token>                        the share build's shell (it routes /i/ to the Owner page)
 * GET /api/i/<token>                    -> OwnerHome
 * GET /api/i/<token>/p/<q_…>            -> OwnerProject (404: unknown or not shown)
 * GET /api/i/<token>/c/<k_…>            -> OwnerConversation (404: unknown or hidden)
 * Dead links: 410 { error, code: "gone", why?: "expired" } with no names; unknown: 404 { error, code: "not-found" }.
 *
 * Operator routes (main listener only):
 * PUT  /api/orgs/:id/owner                    body { personId: string | null } -> OrgDetail (null: no owner)
 * GET  /api/orgs/:id/owner/link               -> OwnerLinkResult (mints; the older link stops at once)
 * POST /api/orgs/:id/owner/revoke             -> OrgDetail (Turn Off Owner Link)
 * GET  /api/orgs/:id/owner/preview            -> OwnerHome (as the owner sees it; no token, no visit)
 * GET  /api/orgs/:id/owner/preview?project=q_ -> OwnerProject
 * GET  /api/orgs/:id/owner/preview?c=k_       -> OwnerConversation
 * PATCH /api/orgs/:id/projects/:pid           body { ownerHidden: boolean } (with the other fields) -> OrgDetail
 * POST /api/baton/:sid/owner                  body { hidden: boolean } -> BatonInfo (Hide From / Show To the owner)
 * GET  /api/orgs/:id/projects/:pid/updates    -> ProjectUpdate[] (newest first; the project page's log)
 * POST /api/orgs/:id/projects/:pid/updates/:uid/withdraw -> ProjectUpdate[]
 */

import type { BatonView } from "./baton";

/** A project's chip, derived, never typed: the first that applies. */
export type OwnerStatus = "waiting-on-you" | "asking" | "building" | "quiet";

/** The most characters of one update. */
export const OWNER_UPDATE_MAX = 2000;
/** How long an owner link lasts from minting (absolute; no renewal). */
export const OWNER_LINK_DAYS = 90;

/** A person as the page names them: the whole name and the first name. Never a role or an id. */
export interface OwnerName {
  name: string;
  first: string;
}

/** One update the project overseer posted (not taken down). Shown with its time only. */
export interface OwnerNews {
  id: string;
  at: string;
  text: string;
}

/** A conversation that waits on the owner. */
export interface OwnerWaiting {
  /** The conversation's handle (k_…). */
  conversation: string;
  publicTitle: string;
  /** The project's handle (q_…) and name. */
  project: string;
  projectName: string;
  /** When it was put to them (the hand-off or the offer). */
  askedAt: string;
}

export interface OwnerCounts {
  /** People asked in the shown conversations (the operator not counted). */
  people: number;
  /** Decisions shown (superseded ones not counted). */
  decisions: number;
  /** Pieces of work finished (merged) and in progress. */
  finished: number;
  inProgress: number;
}

export interface OwnerProjectCard extends OwnerCounts {
  /** The project's handle (q_…). */
  id: string;
  name: string;
  status: OwnerStatus;
  /** Newest activity in its shown conversations, updates or work ("" when none). */
  lastActivityAt: string;
  latestNews: OwnerNews | null;
  /** Shown conversations, for the empty states ("{n} conversations so far."). */
  conversations: number;
}

/** GET /api/i/<token>. */
export interface OwnerHome {
  org: { name: string };
  owner: OwnerName;
  operator: OwnerName;
  /** Server time of this answer. */
  updatedAt: string;
  waiting: OwnerWaiting[];
  projects: OwnerProjectCard[];
}

/** Someone asked in the project's conversations. */
export interface OwnerPerson extends OwnerName {
  /** Shown conversations they were asked in or wrote in. */
  conversations: number;
  lastWroteAt?: string;
  /** They hold one of its conversations now ("Waiting on {first}"). */
  waitingOnThem: boolean;
  /** This is the owner. */
  isYou: boolean;
}

export type OwnerDecisionState = "agreed" | "noted" | "needs-choice";

export interface OwnerDecision {
  /** The decision's area, as recorded. */
  topic: string;
  statement: string;
  /** The person's own words. */
  quote: string;
  by: OwnerName;
  at: string;
  state: OwnerDecisionState;
}

/** Two answers that disagree, and who is asked to choose. */
export interface OwnerDifference {
  topic: string;
  /** The two people's names (one entry when the same person said both). */
  between: string[];
  chooser: { kind: "person"; name: string; first: string } | { kind: "you" } | { kind: "operator"; name: string; first: string };
}

export type OwnerConversationStatus =
  | { kind: "waiting-on"; name: string; first: string }
  | { kind: "waiting-on-you" }
  | { kind: "with-operator"; name: string; first: string }
  | { kind: "offered"; count: number }
  | { kind: "done" }
  | { kind: "closed" };

export interface OwnerConversationRow {
  /** The conversation's handle (k_…). */
  id: string;
  publicTitle: string;
  status: OwnerConversationStatus;
  createdAt: string;
  /** Messages people (and the operator) wrote in it. */
  messages: number;
  lastActivityAt: string;
}

/** GET /api/i/<token>/p/<q_…>. */
export interface OwnerProject extends Pick<OwnerCounts, "finished" | "inProgress"> {
  id: string;
  name: string;
  status: OwnerStatus;
  lastActivityAt: string;
  org: { name: string };
  owner: OwnerName;
  operator: OwnerName;
  updatedAt: string;
  /** Newest first. */
  news: OwnerNews[];
  waiting: OwnerWaiting[];
  /** Who we've talked to: newest writer first; people who never wrote after them. */
  people: OwnerPerson[];
  /** Newest first. */
  decisions: OwnerDecision[];
  differences: OwnerDifference[];
  /** Newest activity first. */
  conversations: OwnerConversationRow[];
}

/** GET /api/i/<token>/c/<k_…>: the thread as the share page shows it, the owner as the viewer
    (briefings only when addressed to them; senders as "you" / "operator" / "person-<n>"). */
export interface OwnerConversation extends BatonView {
  id: string;
  project: string;
  projectName: string;
  status: OwnerConversationStatus;
  /** The owner holds it now: "It's your turn here. Answer through the link {op} sent you." */
  yourTurn: boolean;
  org: { name: string };
  operator: OwnerName;
  updatedAt: string;
}

// ---- operator side ---------------------------------------------------------------------------------

/** GET /api/orgs/:id/owner/link. Shown once: the host keeps only the token's hash. */
export interface OwnerLinkResult {
  /** The share listener's public address + "/i/<token>" (just the path when none is known). */
  link: string;
  createdAt: string;
  expiresAt: string;
  linkWarning?: string;
}

/** One update in the project page's log (every post, taken-down ones included). `by`: "overseer",
    posted on its own; "operator", posted in the operator's own turn (they asked). */
export interface ProjectUpdate {
  id: string;
  at: string;
  text: string;
  by: "overseer" | "operator";
  withdrawnAt?: string;
}
