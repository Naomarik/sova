/**
 * Wire types for organizations, rosters and their projects (§app/organizations). Kept out of
 * shared/protocol.ts so the mesh wire contract moves only for the few fields the session list and
 * the digest carry (see shared/baton.ts for the baton half).
 *
 * Routes (operator app only; never on the share listener):
 * GET    /api/orgs                          -> OrgsInfo (each summary with needsYou and lastActivityAt)
 * POST   /api/orgs                          body { name, dir? } -> 201 OrgDetail
 * POST   /api/orgs/attach                   body { dir } -> 201 OrgDetail (a restored clone)
 * PUT    /api/orgs/operator                 body { name } -> OrgsInfo
 * GET    /api/orgs/:id                      -> OrgDetail (with needsYou, each baton's waiting, projectConflicts;
 *                                               so is every route below that answers OrgDetail)
 * PATCH  /api/orgs/:id                      body { name?, notes? } -> OrgDetail
 * DELETE /api/orgs/:id                      -> { ok: true } (detach: removes it from this host's index only)
 * POST   /api/orgs/:id/commit               -> OrgDetail (Commit now; pushes when a remote is set)
 * PUT    /api/orgs/:id/remote               body { url } ("" removes it) -> OrgDetail
 * POST   /api/orgs/:id/people               body PersonInput -> 201 OrgDetail
 * PATCH  /api/orgs/:id/people/:pid          body Partial<PersonInput> -> OrgDetail
 * GET    /api/orgs/:id/people/:pid/history  -> ProfileChange[] (newest first)
 * POST   /api/orgs/:id/people/:pid/revert   body { at } -> OrgDetail
 * POST   /api/orgs/:id/people/:pid/approve  -> OrgDetail (a proposed person becomes active, by the operator)
 * POST   /api/orgs/:id/people/:pid/decline  -> OrgDetail (a proposed person becomes "left"; the referral is kept)
 * GET    /api/orgs/:id/changes?limit=50     -> NamedChange[] (newest first, across the roster: Recent profile changes)
 * POST   /api/orgs/:id/projects             body { name, root } -> 201 OrgDetail
 * PATCH  /api/orgs/:id/projects/:pid        body { name?, root? } -> OrgDetail
 * GET    /api/orgs/:id/people/:pid          -> PersonPage (a person's page, §app.organizations/person-page)
 * GET    /api/orgs/:id/people/:pid/preview?session=<sid> -> PersonPreview (Preview as {name}: read-only, as
 *                                               their link shows it; no token, no visit; 404 when the session isn't theirs)
 * POST   /api/orgs/:id/people/:pid/links/revoke body { sessionId?, n? } -> PersonPage (both: turns off that one
 *                                               link of theirs; neither: every live /h/ link of theirs on this host)
 */

import type { BatonView } from "./baton";

export type PersonStatus = "active" | "proposed" | "left";

export interface PersonContact {
  email?: string;
  phone?: string;
  whatsapp?: string;
  /** Any other channel, free text ("Slack: @tony"). */
  other?: string;
}

/** Who referred a proposed person and why. Required on every `proposed` person. */
export interface PersonReferral {
  why: string;
  /** A roster person's id, "operator", or a free-text name when the referrer is not on the roster. */
  referredBy: string;
  sessionId?: string;
  quote?: string;
}

export interface Competence {
  level: 1 | 2 | 3 | 4 | 5;
  /** Sessions observed. */
  n: number;
}

export interface Person {
  id: string;
  orgId: string;
  name: string;
  status: PersonStatus;
  contact: PersonContact;
  role: string;
  decides: string[];
  skills: string[];
  competence: Record<string, Competence>;
  /** BCP-47, e.g. "es-CO". "" = unknown. */
  language: string;
  /** How to talk to them, ≤ 300 characters. */
  voice: string;
  referral?: PersonReferral;
}

/** The fields a change can set, one history line each. */
export type ProfileField = "name" | "status" | "contact" | "role" | "decides" | "skills" | "competence" | "language" | "voice" | "referral";
export const PROFILE_FIELDS: readonly ProfileField[] = ["name", "status", "contact", "role", "decides", "skills", "competence", "language", "voice", "referral"];

export type ChangeWriter = "operator" | "wrapup" | "referral" | "overseer";

/** One line of `roster-history.jsonl`, append-only. */
export interface ProfileChange {
  /** ISO time; unique per org (the store bumps a clash by a millisecond), the key revert names. */
  at: string;
  personId: string;
  field: ProfileField;
  from: unknown;
  to: unknown;
  by: { kind: ChangeWriter; sessionId?: string; entryId?: string; quote?: string };
  /** The `at` of the change this undoes. */
  revertOf?: string;
}

/** A history line with the person's current name, for the Recent profile changes feed. */
export type NamedChange = ProfileChange & { name: string };

export type PersonInput = Partial<Omit<Person, "id" | "orgId">> & { name: string };

export const PERSON_NAME_MAX = 80;
export const PERSON_TEXT_MAX = 300;
export const PERSON_LIST_MAX = 12;
export const PERSON_ITEM_MAX = 40;

/** `projects.json` in the workspace repo: the org's projects (manual only in slice 1). */
export interface OrgProject {
  id: string;
  orgId: string;
  name: string;
  /** Absolute directory on the home host. Need not be a git repo. */
  root: string;
  origin: "manual";
  createdAt: string;
  /** Slice 3: the project's spec is frozen (only the reconciler's promotion writes claims/). */
  spec?: { frozen: boolean };
}

/** `org.json` in the workspace repo. */
export interface Org {
  id: string;
  name: string;
  slug: string;
  createdAt: string;
  notes?: string;
}

export interface OrgGitStatus {
  /** The remote pushes go to (the repo's `origin`), or null: local commits only. */
  remote: string | null;
  lastCommit: { sha: string; at: string; message: string } | null;
  /** The last commit or push failure, cleared by the next success. */
  lastError: string | null;
  /** Uncommitted changes exist right now. */
  dirty: boolean;
  /** How often changes are committed (ms): an hour, unless a test shortened it. Absent: an older server. */
  commitEveryMs?: number;
}

export interface OrgSummary extends Org {
  /** The workspace repo on this host. */
  dir: string;
  people: number;
  projects: number;
  /** Baton sessions not done or closed. */
  openBatons: number;
  /** GET /api/orgs only: what in this org waits on the operator, the same items the attention list
      raises (absent = unknown, e.g. an older server). */
  needsYou?: OrgNeedsYou;
  /** GET /api/orgs only: ISO time of the org's newest activity (absent = unknown). */
  lastActivityAt?: string;
}

/** What waits on the operator in one org, by kind (§app.organizations/org-cards). */
export interface OrgNeedsYou {
  /** Baton sessions the operator holds and hasn't answered (state "needs-you"). */
  replies: number;
  /** Baton sessions a person holds, or offers them, with no live link: the operator must send one. */
  links: number;
  /** Roster people proposed by referral, waiting for Approve or Decline. */
  proposals: number;
  /** Open decision conflicts routed to the operator with no baton session asking about them yet
      (one that has a session counts once, as that session's reply). */
  conflicts: number;
}

/** One baton session of the org, for its page. */
export interface OrgBatonRow {
  sessionId: string;
  /** The session file on this host, for #/s/<path>. */
  path: string;
  publicTitle: string;
  projectId: string;
  state: "open" | "needs-you" | "done" | "closed";
  /** Display name, null when done/closed. */
  holder: string | null;
  createdAt: string;
  /** From the org routes: what this session waits on the operator for, when anything
      ("reply": the operator holds it; "link": someone has no live link yet). */
  waiting?: "reply" | "link";
}

export interface OrgDetail extends OrgSummary {
  roster: Person[];
  projectList: OrgProject[];
  /** Newest first. */
  batons: OrgBatonRow[];
  git: OrgGitStatus;
  /** Newest first, at most 20: the Recent profile changes feed. */
  recentChanges: NamedChange[];
  /** Any file problem reading the repo (a hand-edited roster that doesn't parse). */
  problems: string[];
  /** From the org routes: open conflicts routed to the operator with no session yet, per project id
      (projects with none are absent). */
  projectConflicts?: Record<string, number>;
  /** From the org routes: the People card's "Last opened" line, per person id (§app.baton/visits).
      `at`: the start of their newest visit (link previews, scanners and turned-off attempts don't
      count); `minted`: a link was ever minted for them on this host. People with neither are absent. */
  lastOpened?: Record<string, { at?: string; minted: boolean }>;
}

// ---- a person's page (§app.organizations/person-page) -------------------------------------------------

/** A person (or the operator, id "operator") with their current display name. */
export interface NamedRef {
  id: string;
  name: string;
}

/** How a person relates to one baton session. A session can carry several. */
export type PersonRelation =
  /** The session's first hand-off went to them. */
  | { kind: "started-with" }
  /** A later hand-off (#n) went to them. */
  | { kind: "handed-to"; n: number; from: NamedRef }
  /** They passed the baton on at hand-off #n: to one person, or (an offer) to several. */
  | { kind: "passed-on"; n: number; to: NamedRef[] }
  /** Offer #n included them; `others` = how many more were invited. */
  | { kind: "offered"; n: number; others: number }
  /** They took offer #n (their message claimed it). */
  | { kind: "took-offer"; n: number }
  /** Their lease on offer #n ran out (the offer went back to the pool). */
  | { kind: "lease-lapsed"; n: number }
  /** They were proposed for the roster in this session, by `by` (a person, the operator, or a free-text name with id ""). */
  | { kind: "referred-here"; by: NamedRef }
  /** They proposed someone for the roster in this session. */
  | { kind: "proposed"; person: NamedRef }
  /** This session asks them to settle conflict `conflictId` (area `area`). */
  | { kind: "conflict"; conflictId: string; area: string }
  /** A participant with none of the above (older rows). */
  | { kind: "participant" };

export interface PersonSessionRow {
  sessionId: string;
  /** The session file on this host, for #/s/<path>; null when it isn't here. */
  path: string | null;
  publicTitle: string;
  projectId: string;
  projectName: string;
  state: "open" | "needs-you" | "done" | "closed";
  /** Who holds it now; null when nobody does (done, closed, or an open offer in its pool). */
  holder: NamedRef | null;
  /** This person holds it now. */
  holdsNow: boolean;
  /** The current offer (open or held), when there is one. */
  offer?: { state: "open" | "held"; invited: number; includesThem: boolean; holder?: NamedRef };
  relations: PersonRelation[];
  /** Messages they wrote in it. */
  messages: number;
  lastWroteAt?: string;
  /** Newest of: created, each hand-off, their last message, the offer's activity, closed. */
  lastActivityAt: string;
  createdAt: string;
  parent?: { sessionId: string; publicTitle: string };
}

/** A decision they stated (DecisionRow's fields a page needs), with its project and session. */
export interface PersonDecision {
  id: string;
  projectId: string;
  projectName: string;
  area: string;
  areaKey: string;
  statement: string;
  quote: string;
  at: string;
  sessionId: string;
  /** The session's public title ("" when the row is gone). */
  publicTitle: string;
  sessionPath: string | null;
  entryId: string;
  state: "pending" | "drafted" | "promoted" | "superseded" | "conflict";
  /** false: outside their decision area. */
  authorOwnsArea: boolean;
}

/** A conflict routed to them. */
export interface PersonConflict {
  id: string;
  projectId: string;
  projectName: string;
  areaKey: string;
  /** The area as recorded on its older decision (areaKey when unknown). */
  area: string;
  state: "open" | "resolved";
  routeReason: string;
  batonSessionId?: string;
  batonPath?: string;
  /** The asking session's public title, when it has one. */
  publicTitle?: string;
  createdAt: string;
  resolvedAt?: string;
}

/** What a link can do now. writes: its person holds that hand-off; reads: the baton moved on or the
    session is done; off: turned off (revoked, rotated, left, withdrawn); expired; closed: the session was closed. */
export type LinkState = "writes" | "reads" | "off" | "expired" | "closed";

/** One /h/ link of theirs minted on THIS host (tokens and hashes never leave the host's link store). */
export interface PersonLinkRow {
  sessionId: string;
  publicTitle: string;
  /** The hand-off it belongs to. */
  n: number;
  offerId?: string;
  createdAt: string;
  expiresAt: string;
  revokedAt?: string;
  state: LinkState;
  /** Why a reading link can't write ("moved-on", "done", "taken", …; shared/baton.ts ViewerReason). */
  reason?: string;
  /** It belongs to the session's current hand-off. */
  current: boolean;
  /** Visits through it (scanners and previews not counted). */
  visits: number;
  lastVisitAt?: string;
}

/**
 * One row of their visit log (`visits.jsonl`, §app.baton/visits), newest first.
 * - visit: they opened a link (the share page's API answered); `lastSeenAt` from later activity.
 *   `bot`: a security scanner or script, not a person (show muted, never counted as opened).
 * - preview: a link previewer fetched the page (`device` names the service: "Slack", "WhatsApp", …).
 * - refused: someone opened a link after it was turned off (the page said it no longer works).
 * - capped: the link reached its 20 visits for that day; later ones that day are not recorded.
 */
export interface VisitRow {
  id: string;
  kind: "visit" | "preview" | "refused" | "capped";
  at: string;
  lastSeenAt?: string;
  sessionId: string;
  /** The session's public title ("" when the row is gone). */
  publicTitle: string;
  n: number;
  /** A coarse device family ("Safari · iPhone", "Chrome · Windows"), a preview service, or "Security scanner". */
  device: string;
  bot?: boolean;
  /** No link of this hand-off exists on this host (it was minted where the org lived before). */
  otherHost?: boolean;
}

/** GET /api/orgs/:id/people/:pid/preview?session=: the session as their link shows it now (the
    share page's view, `viewer.canWrite` always false). `linkOpens`: a link of theirs on this host
    opens this session now (false: they left, it's closed, or they were never sent one here). */
export type PersonPreview = BatonView & { linkOpens: boolean };

/** GET /api/orgs/:id/people/:pid. */
export interface PersonPage {
  person: Person;
  org: { id: string; name: string };
  operatorName: string;
  /** Newest activity first. */
  sessions: PersonSessionRow[];
  /** Newest first, across the org's projects. */
  decisions: PersonDecision[];
  /** Routed to them: open first, then newest. */
  conflicts: PersonConflict[];
  /** This host's links of theirs, newest first. */
  links: PersonLinkRow[];
  /** Every row of their visit log, newest first. */
  visits: VisitRow[];
  /** Visits by a person (kind "visit", not bot). */
  opened: number;
  /** Start of their newest such visit. */
  lastOpenedAt?: string;
  /** Their profile history, newest first (as GET …/history). */
  history: ProfileChange[];
}

export interface OrgsInfo {
  operator: { name: string };
  orgs: OrgSummary[];
  /** Where a new org's repo goes when no dir is given. */
  defaultDir: string;
}
