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
 * PATCH  /api/orgs/:id                      body { name?, about? } -> OrgDetail (about: the org's About text,
 *                                               at most ORG_ABOUT_MAX characters; blank removes it)
 * POST   /api/orgs/:id/about/revert         body { at } -> OrgDetail (the About text back to that line's `from`)
 * DELETE /api/orgs/:id                      -> { ok: true } (detach: removes it from this host's index only)
 * POST   /api/orgs/:id/commit               -> OrgDetail (Commit now; pushes when a remote is set)
 * POST   /api/orgs/:id/reload               -> OrgDetail (the Workspace tab's Reload: retries a fixed journal and restored
 *                                    snapshots; `problems` lists what is still wrong, [] when all loaded)
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
 * The org's owner and the Owner page's operator routes: see shared/owner.ts.
 */

import type { BatonView, OfferReach } from "./baton";

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
  /** r7: an IANA zone ("Europe/Istanbul"). Absent or "": unknown, so no hours check. */
  tz?: string;
  /** r7: when they work, in `tz`: days 0 = Sunday … 6 = Saturday, "HH:MM" from–to (`to` ≤ `from`: overnight).
      Absent or null: no hours (acts reach them at once, as before). Not private: roster history like contact. */
  hours?: PersonHours | null;
  /** Computed on every read from the charts' next-window rule, never stored: inside their hours now, else
      when the next window opens (ISO). Absent: no hours set. The page's off-hours note on the operator's own acts. */
  hoursNow?: { open: boolean; nextOpen?: string };
  /** r13: whose hours `hoursNow` reads: their own, else the company's; absent: neither (always in hours).
      `tz`/`hours` above stay the person's own. */
  hoursFrom?: "own" | "company";
}

export interface PersonHours {
  days: number[];
  from: string;
  to: string;
}

/** The fields a change can set, one history line each. */
export type ProfileField = "name" | "status" | "contact" | "role" | "decides" | "skills" | "competence" | "language" | "voice" | "referral" | "tz" | "hours";
export const PROFILE_FIELDS: readonly ProfileField[] = ["name", "status", "contact", "role", "decides", "skills", "competence", "language", "voice", "referral", "tz", "hours"];

export type ChangeWriter = "operator" | "wrapup" | "referral" | "overseer";

/** One line of `roster-history.jsonl`, append-only. */
export interface ProfileChange {
  /** ISO time; unique per org (the store bumps a clash by a millisecond), the key revert names. */
  at: string;
  personId: string;
  field: ProfileField;
  from: unknown;
  to: unknown;
  by: ChangeBy;
  /** The `at` of the change this undoes. */
  revertOf?: string;
}

/** A change made by the global Overseer for the operator (§app.overseer/org-attribution): always
    with `kind: "operator"`, which alone decides what the change may do. */
export const VIA_OVERSEER = "overseer";
export type ChangeVia = typeof VIA_OVERSEER;

/** Who wrote a history line. `via`/`overseerId`: the operator's change, made through the global
    Overseer (never on any other kind). */
export interface ChangeBy {
  kind: ChangeWriter;
  sessionId?: string;
  entryId?: string;
  quote?: string;
  via?: ChangeVia;
  overseerId?: string;
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
  /** The project's main stakeholder (a roster person's id; absent or null: none). They decide every
      area of the project no one else on the roster decides. Set only by the operator. */
  stakeholder?: string | null;
  /** Each change of `stakeholder`, oldest first (at most 50). */
  stakeholderHistory?: StakeholderChange[];
  /** Set when the main stakeholder left the org (so the project has none); removed when the
      operator sets the stakeholder again (to someone or to none). Needs you asks for a new one. */
  stakeholderCleared?: { personId: string; name: string; at: string };
  /** The operator switched this project off the owner's page (§app.owner-page/chats). Absent: shown. */
  ownerHidden?: boolean;
  /** Archived (§app.organizations/archive): put away, nothing deleted. `via`: the global Overseer
      did it for the operator. Absent: not archived. */
  archived?: { at: string; via?: ChangeVia };
}

/** One change of a project's main stakeholder: the operator set it (`operator`), or the person left (`left`). */
export interface StakeholderChange {
  at: string;
  from: string | null;
  to: string | null;
  why: "operator" | "left";
  /** The operator's change, made through the global Overseer. */
  via?: ChangeVia;
}

/** `org.json` in the workspace repo. */
export interface Org {
  id: string;
  name: string;
  slug: string;
  createdAt: string;
  /** The org's owner (§app.owner-page/owner): an active roster person's id; absent or null: none.
      Set only by the operator; cleared when they leave. Reads the Owner page; decides nothing. */
  owner?: string | null;
  /** Each change of `owner`, oldest first (at most 50). */
  ownerHistory?: OwnerChange[];
  /** Set when the owner left the org (so it has none); removed when the operator sets it again. */
  ownerCleared?: { personId: string; name: string; at: string };
  /** r13: the company's zone and working hours, the default for a person with no hours of their own (operator only;
      org history like About, not private). Absent / null: none. */
  tz?: string;
  hours?: PersonHours | null;
}

/** One change of the org's owner: the operator set it, or the person left. */
export interface OwnerChange {
  at: string;
  from: string | null;
  to: string | null;
  why: "operator" | "left";
  /** The operator's change, made through the global Overseer. */
  via?: ChangeVia;
}

/** The owner card on the People tab (OrgDetail.ownerPage). No token, no hash. */
export interface OwnerPageInfo {
  /** The owner now, or null. */
  person: NamedRef | null;
  /** Their newest owner link on this host: live, expired, or off (turned off, replaced); null: none yet. */
  link: { state: "live" | "expired" | "off"; createdAt: string; expiresAt: string } | null;
  /** Visits to the Owner page by a person (not scanners or previews), all time. */
  opened: number;
  lastOpenedAt?: string;
}

/** The most characters of the org's About text (`about.md`, §app.organizations/about). */
export const ORG_ABOUT_MAX = 4000;

/** One line of `org-history.jsonl`, append-only: a change of the org's About text. */
export interface OrgChange {
  /** ISO time; unique per org, the key Revert names. */
  at: string;
  field: "about";
  /** "" = none. */
  from: string;
  to: string;
  by: { kind: "operator"; via?: ChangeVia; overseerId?: string };
  /** The `at` of the change this undoes. */
  revertOf?: string;
}

/** r13: a line of `org-history.jsonl` changing the company zone or working hours (field keys as a person's
    history). The history reads return them apart from About's (`OrgDetail.hoursHistory`). */
export type OrgHoursChange = Omit<OrgChange, "field" | "from" | "to" | "revertOf"> &
  ({ field: "tz"; from: string; to: string } | { field: "hours"; from: PersonHours | null; to: PersonHours | null });

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
  /** Projects not archived (§app.organizations/archive). */
  projects: number;
  /** Archived projects (absent: none, or an older server). */
  archivedProjects?: number;
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
  /** Projects whose main stakeholder left the org, so the operator must pick a new one (absent: an older server). */
  stakeholders?: number;
  /** 1 when the org has an owner whose owner link expired or has under 7 days left, with no newer one. */
  ownerLink?: number;
  /** Acts waiting in a hold before they reach a person or the code (§app.project-overseer/holds); absent: none, or an older server. */
  held?: number;
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

/** What Commit Now did: a commit (its short sha), a push, both, or nothing. */
export interface CommitNowOutcome {
  committed: boolean;
  sha?: string;
  pushed?: boolean;
}

export interface OrgDetail extends OrgSummary {
  roster: Person[];
  projectList: OrgProject[];
  /** Newest first. */
  batons: OrgBatonRow[];
  git: OrgGitStatus;
  /** Only on Commit Now's answer (`POST /api/orgs/:id/commit`): what it did. */
  commit?: CommitNowOutcome;
  /** Newest first, at most 20: the Recent profile changes feed. */
  recentChanges: NamedChange[];
  /** Any file problem reading the repo (a hand-edited roster that doesn't parse). */
  problems: string[];
  /** The org's About text, whole (a hand edit may pass the cap); absent when none. Only on the
      detail: never on `Org` or `OrgSummary`. */
  about?: string;
  /** Its history, newest first, at most 20. */
  aboutHistory?: OrgChange[];
  /** r13: changes of the company zone and working hours, newest first. */
  hoursHistory?: OrgHoursChange[];
  /** From the org routes: open conflicts routed to the operator with no session yet, per project id
      (projects with none are absent). */
  projectConflicts?: Record<string, number>;
  /** From the org routes: the People card's "Last opened" line, per person id (§app.baton/visits).
      `at`: the start of their newest visit (link previews, scanners and turned-off attempts don't
      count); `minted`: a link was ever minted for them on this host. People with neither are absent. */
  lastOpened?: Record<string, { at?: string; minted: boolean }>;
  /** From the org routes: the owner card (absent: an older server). */
  ownerPage?: OwnerPageInfo;
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
  /** `reach` (r12): this person's, when the offer includes them (absent: reached, or an offer from before r12). */
  offer?: { state: "open" | "held"; invited: number; includesThem: boolean; holder?: NamedRef; reach?: OfferReach };
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
  /** "owner": the Owner page ("Opened the owner page"; sessionId "", n 0). Absent: a hand-off link. */
  via?: "owner";
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
  /** `tz`/`hours` (r13): the company's, for "(company hours)" on the Hours row. */
  org: { id: string; name: string; tz?: string; hours?: PersonHours | null };
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
  /** The projects they are the main stakeholder of (absent: an older server). */
  stakeholderOf?: { projectId: string; name: string }[];
  /** They are the org's owner (the `Owner` chip). */
  owner?: boolean;
  /** Their owner links on this host, newest first (no token, no hash). */
  ownerLinks?: { createdAt: string; expiresAt: string; revokedAt?: string; state: "live" | "expired" | "off"; visits: number; lastVisitAt?: string }[];
}

export interface OrgsInfo {
  operator: { name: string };
  orgs: OrgSummary[];
  /** Where a new org's repo goes when no dir is given. */
  defaultDir: string;
}
