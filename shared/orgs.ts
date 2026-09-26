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
 */

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
}

export interface OrgsInfo {
  operator: { name: string };
  orgs: OrgSummary[];
  /** Where a new org's repo goes when no dir is given. */
  defaultDir: string;
}
