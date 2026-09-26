import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import {
  BATON_ENTRY,
  BATON_HANDOFF_ENTRY,
  BATON_OFFER_ENTRY,
  LEASE_IDLE_MS,
  MESSAGES_CAP,
  MESSAGES_DEFAULT,
  MESSAGES_MIN,
  OPERATOR,
  POOL,
  type BatonHandoffData,
  type BatonMarkerData,
  type BatonOfferData,
  type BatonOwner,
  type BatonSession,
  type BatonStartInput,
  type BatonSummaryField,
  type Handoff,
  type Offer,
  type PersonRef,
  type ViewerReason,
  type WrapupInfo,
} from "../shared/baton";
import type { Person } from "../shared/orgs";
import { liveLinks, mintLink, revokeLinks, type LinkRecord, linkDead, findLink } from "./baton-links";
import { emitBatonEvent } from "./baton-events";
import { readBatonSettings } from "./baton-settings";
import { onOrgAttached, operatorName, orgDir, orgOfSessionPath, OrgError, readHistory, readIndex, readOrg, readProjects, readRoster, setOpenBatonCounter, shortId } from "./orgs";
import { canonicalPath } from "./paths";
import { markSeen } from "./seen";
import { cleanSessionTitle, readSessionTitles, setSessionTitle } from "./session-titles";
import { addWebSession } from "./web-sessions";
import { markOwned } from "./write-guard";

/**
 * Baton sessions (§app/baton): the registry in each org's workspace repo (`baton.json`), the state
 * machine, and creation. The runtime half (loadout, tools, the operator's composer gate) is
 * server/baton-loadout.ts; the outsider view is server/baton-view.ts; the share routes
 * server/share/. Nothing here writes a token: links are server/baton-links.ts (host state).
 *
 * States: `open` (a person holds it), `needs-you` (the operator holds it and hasn't answered),
 * `done` (goal_done), `closed` (the operator closed it). The operator's reply turns `needs-you`
 * back into `open` while they keep holding it, so the Needs-you item clears.
 */

export const MESSAGES_MAX = MESSAGES_DEFAULT;
export const PUBLIC_TITLE_MAX = 120;
export const GOAL_MAX = 2000;
export const QUESTION_MAX = 1000;
export const BRIEFING_MAX = 4000;

const batonFile = (dir: string) => join(dir, "baton.json");

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function readRows(dir: string): BatonSession[] {
  try {
    const raw = JSON.parse(readFileSync(batonFile(dir), "utf8"));
    return isObj(raw) && Array.isArray(raw.sessions) ? raw.sessions.filter((r: unknown) => isObj(r) && typeof r.sessionId === "string") : [];
  } catch {
    return [];
  }
}

function writeRows(dir: string, rows: BatonSession[]): void {
  const tmp = `${batonFile(dir)}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify({ version: 1, sessions: rows }, null, 2)}\n`);
  renameSync(tmp, batonFile(dir));
}

/** Every baton row of every attached org. */
export function allBatons(): BatonSession[] {
  const out: BatonSession[] = [];
  for (const o of readIndex().orgs) out.push(...readRows(o.dir));
  return out;
}

setOpenBatonCounter(
  (orgId) => {
    try {
      return readRows(orgDir(orgId)).filter((r) => r.state === "open" || r.state === "needs-you").length;
    } catch {
      return 0;
    }
  },
  (orgId) => {
    const dir = orgDir(orgId);
    const roster = readRoster(orgId);
    return readRows(dir)
      .map((r) => ({
        sessionId: r.sessionId,
        path: sessionPathOf(dir, r),
        publicTitle: r.publicTitle,
        projectId: r.projectId,
        state: r.state,
        holder: r.holder === null ? null : nameOf(orgId, r.holder, roster),
        createdAt: r.createdAt,
      }))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  },
);

/** The row and its org dir for a session id. */
export function batonById(sessionId: string): { row: BatonSession; dir: string } | null {
  for (const o of readIndex().orgs) {
    const row = readRows(o.dir).find((r) => r.sessionId === sessionId);
    if (row) return { row, dir: o.dir };
  }
  return null;
}

/** Session id from a session file name (`<ts>_<uuid>.jsonl`). */
const idOfFile = (path: string): string => {
  const b = basename(path, ".jsonl");
  const i = b.indexOf("_");
  return i >= 0 ? b.slice(i + 1) : b;
};

/** The row of a session file, when it lives in an attached org's workspace and is registered. */
export function batonOfPath(path: string): { row: BatonSession; dir: string } | null {
  const org = orgOfSessionPath(path);
  if (!org) return null;
  const id = idOfFile(path);
  const row = readRows(org.dir).find((r) => r.sessionId === id);
  return row ? { row, dir: org.dir } : null;
}

export const sessionPathOf = (dir: string, row: BatonSession): string => canonicalPath(join(dir, row.file));

/**
 * An attach (a restored clone): what this host keeps about each baton session outside the repo is
 * derived again from baton.json — its listing title (the public title; a title the operator already
 * gave it here stays), its web origin, and the write guard's stat, so the operator's composer isn't
 * refused as "recently written by someone else" for the files the clone just wrote. Links are not
 * derived: they are minted again when the operator asks.
 */
onOrgAttached((_orgId, dir) => {
  const titles = readSessionTitles();
  for (const row of readRows(dir)) {
    const path = sessionPathOf(dir, row);
    if (!existsSync(path)) continue;
    addWebSession(row.sessionId);
    markOwned(path);
    if (!titles[row.sessionId]) setSessionTitle(row.sessionId, cleanSessionTitle(row.publicTitle) ?? null);
  }
});

/** Change one row atomically (read, mutate, write) and return it. */
function update(sessionId: string, fn: (row: BatonSession) => void): BatonSession {
  const hit = batonById(sessionId);
  if (!hit) throw new OrgError("Unknown baton session", 404);
  const rows = readRows(hit.dir);
  const row = rows.find((r) => r.sessionId === sessionId)!;
  fn(row);
  writeRows(hit.dir, rows);
  return row;
}

// ---- names ------------------------------------------------------------------------------------------------

export function nameOf(orgId: string, ref: PersonRef | null, roster?: Person[]): string {
  if (ref === null) return "";
  if (ref === OPERATOR) return operatorName();
  if (ref === POOL) return "Invitees";
  const people = roster ?? readRoster(orgId);
  return people.find((p) => p.id === ref)?.name ?? "Someone";
}

export function namesOf(orgId: string): Record<string, string> {
  const out: Record<string, string> = { [OPERATOR]: operatorName(), [POOL]: "Invitees" };
  for (const p of readRoster(orgId)) out[p.id] = p.name;
  return out;
}

/**
 * Resolve a hand-off target the way hand_to accepts it: "operator" (or the operator's name), an
 * ACTIVE roster person's id, or their exact name (case-insensitive). Anything else is a refusal
 * the model can act on. Pure over the roster it is given.
 */
export function resolveTarget(
  roster: Person[],
  raw: string,
  operator: string,
): { ok: true; ref: PersonRef } | { ok: false; error: string } {
  let want = raw.trim();
  if (!want) return { ok: false, error: "Name the person to hand to." };
  // Models copy the roster line: "Maria Lopez (id p_x)", "Maria Lopez (p_x)", "Maria Lopez — payroll".
  // A hand-off routes someone's conversation, so an id and a name that disagree, or two ids, are
  // refused rather than guessed.
  const ids = [...new Set(want.match(/\bp_[a-z0-9]{8}\b/g) ?? [])].filter((id) => roster.some((x) => x.id === id));
  if (ids.length > 1) return { ok: false, error: "That names more than one person. Give one name." };
  const namePart = want
    .replace(/\bp_[a-z0-9]{8}\b/g, "")
    .replace(/\(\s*(id\s*)?\)/gi, "")
    .replace(/\s*\([^)]*\)\s*$/, "")
    .replace(/\s+[—–-]\s.*$/, "")
    .trim();
  if (ids.length === 1) {
    const p = roster.find((x) => x.id === ids[0])!;
    if (namePart && namePart.toLowerCase() !== p.name.toLowerCase())
      return { ok: false, error: `That id is ${p.name}'s, but the name says ${namePart}. Which did you mean? Give the name alone.` };
    want = p.id;
  } else want = namePart || want;
  if (want.toLowerCase() === OPERATOR || want.toLowerCase() === operator.toLowerCase()) return { ok: true, ref: OPERATOR };
  const p = roster.find((x) => x.id === want) ?? roster.find((x) => x.name.toLowerCase() === want.toLowerCase());
  if (!p)
    return {
      ok: false,
      error:
        `${want} is not on the roster. Ask the person you are talking to for ${want}'s full name, at least one way to contact them ` +
        "(email, phone or WhatsApp), their role, and why they are the right person to ask. Keep asking until you have all four, " +
        "then call propose_roster_edit with them, and hand_to the operator so they can approve the new person.",
    };
  if (p.status === "proposed") return { ok: false, error: `${p.name} has been proposed but not approved yet. Hand to the operator and ask them to approve ${p.name} first.` };
  if (p.status === "left")
    return { ok: false, error: p.referral ? `${p.name} was proposed but the operator declined. Ask who else could answer.` : `${p.name} is no longer with the organization. Ask who covers their area now.` };
  return { ok: true, ref: p.id };
}

// ---- creation -------------------------------------------------------------------------------------------------

/** A message limit from a request: a whole number within MESSAGES_MIN..MESSAGES_CAP, else a 400. */
export function messageLimit(v: unknown, field = "messagesMax", min = MESSAGES_MIN, max = MESSAGES_CAP): number {
  if (typeof v !== "number" || !Number.isInteger(v) || v < min || v > max) throw new OrgError(`${field} must be a whole number from ${min} to ${max}`);
  return v;
}

const text = (v: unknown, field: string, max: number, required = true): string => {
  const t = typeof v === "string" ? v.trim() : "";
  if (required && !t) throw new OrgError(`${field} is required`);
  if (t.length > max) throw new OrgError(`${field} must be at most ${max} characters`);
  return t;
};

export interface Created {
  path: string;
  sessionId: string;
  token?: string;
  /** One per invitee when started as an offer. */
  links?: { personId: string; token: string }[];
}

/** An offer's invitees: ≥ 2 distinct ACTIVE people (never the operator), resolved like hand_to. */
export function resolveInvitees(roster: Person[], to: readonly unknown[], operator: string): { ok: true; refs: PersonRef[] } | { ok: false; error: string } {
  const refs: PersonRef[] = [];
  for (const raw of to) {
    const t = resolveTarget(roster, String(raw ?? ""), operator);
    if (!t.ok) return t;
    if (t.ref === OPERATOR) return { ok: false, error: "An offer goes to people on the roster, not to the operator." };
    if (!refs.includes(t.ref)) refs.push(t.ref);
  }
  if (refs.length < 2) return { ok: false, error: "An offer needs at least two different people." };
  if (refs.length > 20) return { ok: false, error: "An offer goes to at most 20 people." };
  return { ok: true, refs };
}

function cleanOwner(v: unknown): BatonOwner {
  if (v === undefined || v === "operator") return "operator";
  if (typeof v === "object" && v !== null && typeof (v as { overseerOf?: unknown }).overseerOf === "string") return { overseerOf: (v as { overseerOf: string }).overseerOf };
  throw new OrgError("owner must be \"operator\" or { overseerOf }");
}

const newOffer = (to: string[], question: string, briefing: string, n: number, now: Date): Offer => ({
  id: shortId("off_"),
  to,
  question,
  briefing,
  state: "open",
  createdAt: now.toISOString(),
  n,
});

/** The row's current offer (open or held), or undefined. */
export const currentOffer = (row: Pick<BatonSession, "offers" | "offerId">): Offer | undefined =>
  row.offerId ? row.offers?.find((o) => o.id === row.offerId && o.state !== "withdrawn") : undefined;

/** Withdraw the current offer, in place. Returns it, for revokeWithdrawn after the write. */
function withdrawCurrent(r: BatonSession): Offer | undefined {
  const o = currentOffer(r);
  delete r.offerId;
  if (!o) return undefined;
  o.state = "withdrawn";
  delete o.leaseUntil;
  return o;
}

/** Whether `personId` has held offer `offerId` of this row (its lease, now or before). Holding an
    earlier hand-off of the session does not count: this offer's content is new to them. */
export function heldOffer(row: Pick<BatonSession, "offers">, offerId: string, personId: string): boolean {
  const o = row.offers?.find((x) => x.id === offerId);
  return !!o && (o.holder === personId || !!o.heldBy?.includes(personId));
}

/** A withdrawn offer's links stop working (410) for every invitee who never held it; anyone who
    did keeps reading, like any earlier holder. */
function revokeWithdrawn(row: BatonSession, offer: Offer | undefined): void {
  if (!offer) return;
  revokeLinks((l) => l.sessionId === row.sessionId && l.offerId === offer.id && !heldOffer(row, offer.id, l.personId));
}

/**
 * Start a baton session: a new webapp-owned session file in the org's workspace `sessions/` (cwd =
 * the workspace repo), carrying the `sova-baton` marker and the first hand-off, registered in
 * baton.json, with a link for the first holder when that is a person.
 */
/**
 * In-process options (never from a request): `owner` (the project overseer, the reconciler), and
 * `mintLink: false` for a caller that can't show a link to anyone — then no link exists and the
 * session asks the operator to send one (Needs you, "Send <name> their link").
 */
export function createBaton(input: BatonStartInput & { owner?: BatonOwner; mintLink?: boolean }, now = new Date()): Created {
  const dir = orgDir(input.orgId);
  readOrg(input.orgId); // a readable org.json, or a 409 before anything is written
  const parent = typeof input.parentSessionId === "string" && input.parentSessionId ? batonById(input.parentSessionId) : null;
  if (input.parentSessionId && (!parent || parent.row.orgId !== input.orgId)) throw new OrgError("Unknown parent session", 404);
  const projectId = input.projectId || parent?.row.projectId;
  const project = readProjects(input.orgId).find((p) => p.id === projectId);
  if (!project) throw new OrgError("Unknown project", 404);
  const owner = cleanOwner(input.owner);
  const publicTitle = text(input.publicTitle, "publicTitle", PUBLIC_TITLE_MAX);
  const goal = text(input.goal, "goal", GOAL_MAX);
  const question = text(input.question ?? "", "question", QUESTION_MAX, false) || publicTitle;
  const briefing = text(input.briefing ?? "", "briefing", BRIEFING_MAX, false);
  const roster = readRoster(input.orgId);
  const many = Array.isArray(input.to) && input.to.length > 1;
  const invitees = many ? resolveInvitees(roster, input.to as unknown[], operatorName()) : null;
  if (invitees && !invitees.ok) throw new OrgError(invitees.error);
  const target = many ? ({ ok: true, ref: POOL } as const) : resolveTarget(roster, String((Array.isArray(input.to) ? input.to[0] : input.to) ?? ""), operatorName());
  if (!target.ok) throw new OrgError(target.error);
  const offer = invitees?.ok ? newOffer(invitees.refs, question, briefing, 1, now) : undefined;
  const model = typeof input.model === "string" && input.model.trim() ? input.model.trim() : undefined;
  const thinking = typeof input.thinking === "string" && input.thinking.trim() ? input.thinking.trim() : undefined;
  const messagesMax = input.messagesMax === undefined || input.messagesMax === null ? readBatonSettings().messagesMax : messageLimit(input.messagesMax);

  const sessionsDir = join(dir, "sessions");
  mkdirSync(sessionsDir, { recursive: true });
  const sm = SessionManager.create(dir, sessionsDir);
  const raw = sm.getSessionFile();
  const header = sm.getHeader();
  if (!raw || !header) throw new Error("SessionManager did not produce a session file");
  sm.appendCustomEntry(BATON_ENTRY, { v: 1, orgId: input.orgId, projectId: project.id } satisfies BatonMarkerData);
  if (offer) sm.appendCustomEntry(BATON_OFFER_ENTRY, { v: 1, n: 1, offerId: offer.id, from: OPERATOR, to: offer.to, question, briefing } satisfies BatonOfferData);
  else sm.appendCustomEntry(BATON_HANDOFF_ENTRY, { v: 1, n: 1, from: OPERATOR, to: target.ref, question, briefing } satisfies BatonHandoffData);
  // Written now, like every web session (SessionManager.create defers its own write).
  writeFileSync(raw, `${[JSON.stringify(header), ...sm.getEntries().map((e) => JSON.stringify(e))].join("\n")}\n`, { flag: "wx" });
  const path = canonicalPath(raw);
  markOwned(path);
  addWebSession(header.id);
  markSeen(header.id);
  // Listed under its public title, not the first message someone happens to write.
  setSessionTitle(header.id, cleanSessionTitle(publicTitle) ?? null);

  const handoff: Handoff = { n: 1, from: OPERATOR, to: target.ref, question, briefing, at: now.toISOString(), ...(offer ? { offerId: offer.id } : {}) };
  const row: BatonSession = {
    sessionId: header.id,
    file: join("sessions", basename(raw)),
    orgId: input.orgId,
    projectId: project.id,
    owner,
    goal,
    publicTitle,
    participants: offer ? [OPERATOR] : [...new Set([OPERATOR, target.ref])],
    holder: offer ? null : target.ref,
    state: target.ref === OPERATOR ? "needs-you" : "open",
    handoffs: [handoff],
    ...(offer ? { offers: [offer], offerId: offer.id } : {}),
    ...(parent ? { parent: parent.row.sessionId } : {}),
    budget: { messagesMax, messagesUsed: 0 },
    ...(model ? { model } : {}),
    ...(thinking ? { thinking } : {}),
    createdAt: now.toISOString(),
  };
  writeRows(dir, [...readRows(dir), row]);
  const mint = input.mintLink !== false;
  const token = target.ref === OPERATOR || offer || !mint ? undefined : mintLink({ orgId: input.orgId, sessionId: header.id, n: 1, personId: target.ref });
  const links = !mint ? undefined : offer?.to.map((personId) => ({ personId, token: mintLink({ orgId: input.orgId, sessionId: header.id, n: 1, personId, offerId: offer.id }) }));
  emitBatonEvent({ type: offer ? "offer" : "handoff", orgId: input.orgId, projectId: project.id, sessionId: header.id });
  return { path, sessionId: header.id, ...(token ? { token } : {}), ...(links ? { links } : {}) };
}

// ---- moves -----------------------------------------------------------------------------------------------------

/**
 * Move the baton (hand_to, Take back, the budget stop). The caller writes the `sova-baton-handoff`
 * entry into the transcript with the returned `n`. No link is minted here: the host keeps no
 * token it could show later, so a person's link is minted when the operator asks for it (Copy
 * link), and until then the session asks the operator to send it (`sendLink`).
 */
export function handTo(
  sessionId: string,
  to: PersonRef,
  question: string,
  briefing: string,
  now = new Date(),
): { n: number; from: PersonRef } {
  let n = 0;
  let from: PersonRef = OPERATOR;
  let withdrawn: Offer | undefined;
  const row = update(sessionId, (r) => {
    const refused = moveRefusal(r, to);
    if (refused) throw refused;
    from = r.holder ?? (r.offerId ? POOL : OPERATOR);
    withdrawn = withdrawCurrent(r);
    n = r.handoffs.length + 1;
    r.handoffs.push({ n, from, to, question, briefing, at: now.toISOString() });
    r.holder = to;
    r.state = to === OPERATOR ? "needs-you" : "open";
    if (!r.participants.includes(to)) r.participants.push(to);
  });
  revokeWithdrawn(row, withdrawn);
  emitBatonEvent({ type: "handoff", orgId: row.orgId, projectId: row.projectId, sessionId });
  return { n, from };
}

export function markDone(sessionId: string, now = new Date()): BatonSession {
  let withdrawn: Offer | undefined;
  const row = update(sessionId, (r) => {
    if (r.state === "done" || r.state === "closed") throw new OrgError(`This session is already ${r.state}.`, 409);
    withdrawn = withdrawCurrent(r);
    r.state = "done";
    r.holder = null;
    r.closedAt = now.toISOString();
  });
  revokeWithdrawn(row, withdrawn);
  emitBatonEvent({ type: "done", orgId: row.orgId, projectId: row.projectId, sessionId });
  return row;
}

export function closeBaton(sessionId: string, now = new Date()): BatonSession {
  const row = update(sessionId, (r) => {
    if (r.state === "closed") throw new OrgError("This session is already closed.", 409);
    withdrawCurrent(r);
    r.state = "closed";
    r.holder = null;
    r.closedAt = r.closedAt ?? now.toISOString();
  });
  revokeLinks((l) => l.sessionId === sessionId);
  emitBatonEvent({ type: "closed", orgId: row.orgId, projectId: row.projectId, sessionId });
  return row;
}

export const budgetSpent = (r: Pick<BatonSession, "budget">): boolean => r.budget.messagesUsed >= r.budget.messagesMax;

/** Why a person can't be handed the baton at the limit (the model's hand_to, the operator's hand-off or offer). */
const LIMIT_REACHED = "This conversation has reached its message limit. Only the operator can take it now: hand it to the operator.";

/**
 * Why the baton can't go to `to` (a person, the operator, or POOL for an offer) now, or null: the
 * refusals of handTo and startOffer. An operator's move asks first, so a move that would be refused
 * never stops the reply in flight (server/baton-loadout.ts).
 */
export function moveRefusal(r: BatonSession, to: PersonRef): OrgError | null {
  if (r.state === "done" || r.state === "closed") return new OrgError(`This session is ${r.state}.`, 409);
  if (r.holder === to) return new OrgError("They already hold the baton.", 409);
  if (to !== OPERATOR && budgetSpent(r)) return new OrgError(LIMIT_REACHED, 409);
  return null;
}

/** An offer's refusals, as startOffer makes them (the invitees, then moveRefusal), or null. */
export function offerRefusal(r: BatonSession, to: readonly unknown[]): OrgError | null {
  const invitees = resolveInvitees(readRoster(r.orgId), to, operatorName());
  return invitees.ok ? moveRefusal(r, POOL) : new OrgError(invitees.error);
}

/** The message budget is spent: the caller moves the baton to the operator (with its entry). */
export class BudgetSpent extends OrgError {
  constructor(by: PersonRef = POOL) {
    super(
      by === OPERATOR
        ? "This conversation has reached its message limit. Extend it to write."
        : "This conversation has reached its message limit. The operator has been told.",
      409,
    );
  }
}

export interface Noted {
  row: BatonSession;
  /** This message claimed an open offer (hand-off `n`): the caller records the lease entry. */
  claimed?: { n: number; offerId: string };
  /** A lapsed lease was returned to the pool on the way (someone else's, or this sender's own). */
  expired?: { n: number; offerId: string; by: PersonRef };
  /** The row as it was before this message: undoNote puts it back when the message is not accepted. */
  before: BatonSession;
}

/** The lease's idle time: LEASE_IDLE_MS, or SOVA_BATON_LEASE_MS when set (hermetic tests only). */
export function leaseMs(env: NodeJS.ProcessEnv = process.env): number {
  const v = Number(env.SOVA_BATON_LEASE_MS);
  return Number.isFinite(v) && v >= 1000 ? Math.floor(v) : LEASE_IDLE_MS;
}

/**
 * Whether a reply is being written in a session right now: the runtime registers it
 * (server/baton-loadout.ts). A lease never lapses while the model is answering its holder; the
 * reply's end renews it (touchLease).
 */
let replyInFlight: (sessionId: string) => boolean = () => false;
export function setReplyProbe(fn: (sessionId: string) => boolean): void {
  replyInFlight = fn;
}

/** Return a held offer whose lease has lapsed to its pool, in place. Never mid-reply. */
function lapse(r: BatonSession, now: number): Noted["expired"] {
  const o = currentOffer(r);
  if (!o || o.state !== "held" || !o.holder || !o.leaseUntil || Date.parse(o.leaseUntil) > now) return undefined;
  if (replyInFlight(r.sessionId)) return undefined;
  const by = o.holder;
  o.state = "open";
  delete o.holder;
  delete o.leaseUntil;
  r.holder = null;
  return { n: o.n, offerId: o.id, by };
}

/**
 * A message entered the session (from the share page or the operator's composer). The lock of
 * §app.baton/offers-and-leases lives here, in one synchronous read-modify-write (the whole server
 * is one process, so nothing interleaves): a lapsed lease goes back to the pool, then an invitee's
 * message on an open offer CLAIMS it (the first accepted message wins), then the holder rule
 * applies as for any hand-off, and the holder's message renews the lease. Counts the message
 * against the budget; the operator answering clears Needs you. Refuses (409) when `by` does not
 * hold the baton or the session is not open, and (BudgetSpent) when the budget is spent.
 */
export function noteMessage(sessionId: string, by: PersonRef, now = Date.now()): Noted {
  const hit = batonById(sessionId);
  if (!hit) throw new OrgError("Unknown baton session", 404);
  let claimed: Noted["claimed"];
  let expired: Noted["expired"];
  let before!: BatonSession;
  const row = update(sessionId, (r) => {
    before = structuredClone(r);
    if (r.state === "done" || r.state === "closed") throw new OrgError(`This conversation is ${r.state}.`, 409);
    // Only active people take part (§app.organizations/roster): someone marked left writes nothing.
    if (by !== OPERATOR && readRoster(r.orgId).find((p) => p.id === by)?.status !== "active") throw new OrgError("You are no longer taking part in this conversation.", 409);
    expired = lapse(r, now);
    const o = currentOffer(r);
    if (o && o.state === "open" && by !== OPERATOR && o.to.includes(by)) {
      if (budgetSpent(r)) throw new BudgetSpent(by);
      o.state = "held";
      o.holder = by;
      if (!o.heldBy?.includes(by)) o.heldBy = [...(o.heldBy ?? []), by];
      r.holder = by;
      if (!r.participants.includes(by)) r.participants.push(by);
      claimed = { n: o.n, offerId: o.id };
    }
    if (r.holder !== by) {
      if (o && o.to.includes(by) && o.holder && o.holder !== by) throw new OrgError("Someone else is answering right now.", 409);
      throw new OrgError(by === OPERATOR ? (r.holder ? `${nameOf(r.orgId, r.holder)} holds the baton. Take it back to write.` : "The baton is offered to people right now. Take it back to write.") : "It's not your turn anymore.", 409);
    }
    if (budgetSpent(r)) throw new BudgetSpent(by);
    r.budget.messagesUsed++;
    if (by === OPERATOR && r.state === "needs-you") r.state = "open";
    if (o && o.holder === by) {
      o.lastActivityAt = new Date(now).toISOString();
      o.leaseUntil = new Date(now + leaseMs()).toISOString();
    }
  });
  return { row, ...(claimed ? { claimed } : {}), ...(expired ? { expired } : {}), before };
}

/**
 * The message noteMessage let in was not accepted after all (the runtime refused it): put the row
 * back as it was, so a refused send neither spends the budget nor claims an offer. The caller runs
 * this in the same synchronous stretch as noteMessage, so nothing else has changed the row since.
 */
export function undoNote(sessionId: string, noted: Noted): void {
  update(sessionId, (r) => {
    Object.assign(r, structuredClone(noted.before));
    for (const k of Object.keys(r) as (keyof BatonSession)[]) if (!(k in noted.before)) delete r[k];
  });
}

/**
 * Raise a session's message limit by `by` (the operator, from the strip or the Needs-you item):
 * the holder may write again. Bounded like any limit; refused once the session is done or closed.
 */
export function extendBudget(sessionId: string, by: unknown): BatonSession {
  const hit = batonById(sessionId);
  if (!hit) throw new OrgError("Unknown baton session", 404);
  const n = messageLimit(by, "by", 1, MESSAGES_CAP);
  return update(sessionId, (r) => {
    if (r.state === "done" || r.state === "closed") throw new OrgError(`This session is ${r.state}.`, 409);
    const next = r.budget.messagesMax + n;
    if (next > MESSAGES_CAP) throw new OrgError(`A conversation's limit is at most ${MESSAGES_CAP} messages (it is ${r.budget.messagesMax} now).`, 409);
    r.budget.messagesMax = next;
  });
}

/** A reply ended: the holder's lease renews from now (the later of their message and the reply). */
export function touchLease(sessionId: string, now = Date.now()): void {
  const hit = batonById(sessionId);
  const o = hit ? currentOffer(hit.row) : undefined;
  if (!o || o.state !== "held") return;
  update(sessionId, (r) => {
    const cur = currentOffer(r);
    if (!cur || cur.state !== "held") return;
    cur.lastActivityAt = new Date(now).toISOString();
    cur.leaseUntil = new Date(now + leaseMs()).toISOString();
  });
}

/** Sessions whose held lease has lapsed (read only; the ticker then calls expireLease on each). */
export function lapsedLeases(now = Date.now()): string[] {
  return allBatons()
    .filter((r) => {
      const o = currentOffer(r);
      return !!o && o.state === "held" && !!o.leaseUntil && Date.parse(o.leaseUntil) <= now && r.state === "open" && !replyInFlight(r.sessionId);
    })
    .map((r) => r.sessionId);
}

/** Return a lapsed lease to its pool; null when there was none to return (a message renewed it). */
export function expireLease(sessionId: string, now = Date.now()): Noted["expired"] | null {
  let expired: Noted["expired"];
  update(sessionId, (r) => {
    if (r.state === "open") expired = lapse(r, now);
  });
  return expired ?? null;
}

/**
 * Put the baton in a pool (§app.baton/offers-and-leases): a hand-off to ≥ 2 people at once, one
 * link each, the first accepted message holds it. Withdraws a current offer first. The caller
 * writes the `sova-baton-offer` entry with the returned `n` (createBaton writes its own).
 */
export function startOffer(
  sessionId: string,
  to: readonly unknown[],
  question: string,
  briefing = "",
  now = new Date(),
  /** false: no links (an in-process caller that can't show them); Needs you asks the operator. */
  mint = true,
): { n: number; from: PersonRef; offer: Offer; links: { personId: string; token: string }[] } {
  const hit = batonById(sessionId);
  if (!hit) throw new OrgError("Unknown baton session", 404);
  const invitees = resolveInvitees(readRoster(hit.row.orgId), to, operatorName());
  if (!invitees.ok) throw new OrgError(invitees.error);
  const q = text(question, "question", QUESTION_MAX, false) || hit.row.publicTitle;
  const b = text(briefing, "briefing", BRIEFING_MAX, false);
  let n = 0;
  let from: PersonRef = OPERATOR;
  let offer: Offer | undefined;
  let withdrawn: Offer | undefined;
  const row = update(sessionId, (r) => {
    const refused = moveRefusal(r, POOL);
    if (refused) throw refused;
    from = r.holder ?? (r.offerId ? POOL : OPERATOR);
    withdrawn = withdrawCurrent(r);
    n = r.handoffs.length + 1;
    offer = newOffer(invitees.refs, q, b, n, now);
    r.handoffs.push({ n, from, to: POOL, question: q, briefing: b, at: now.toISOString(), offerId: offer.id });
    r.offers = [...(r.offers ?? []), offer];
    r.offerId = offer.id;
    r.holder = null;
    r.state = "open";
  });
  revokeWithdrawn(row, withdrawn);
  const o = offer!;
  const links = mint ? o.to.map((personId) => ({ personId, token: mintLink({ orgId: row.orgId, sessionId, n, personId, offerId: o.id }) })) : [];
  emitBatonEvent({ type: "offer", orgId: row.orgId, projectId: row.projectId, sessionId });
  return { n, from, offer: o, links };
}

// ---- links, as the share routes and the strip need them ------------------------------------------------------

export type LinkAccess =
  | { ok: true; link: LinkRecord; row: BatonSession; dir: string; canWrite: boolean; reason?: ViewerReason }
  | { ok: false; status: 404 | 410 };

/** What a presented token may do (§app.baton/links). */
export function linkAccess(token: string, now = Date.now()): LinkAccess {
  const link = findLink(token);
  if (!link) return { ok: false, status: 404 };
  const hit = batonById(link.sessionId);
  if (!hit) return { ok: false, status: 404 };
  if (linkDead(link, now) || hit.row.state === "closed") return { ok: false, status: 410 };
  const row = hit.row;
  const current = row.handoffs[row.handoffs.length - 1];
  let reason: ViewerReason | undefined;
  const offer = link.offerId ? row.offers?.find((o) => o.id === link.offerId) : undefined;
  if (row.state === "done") reason = "done";
  else if (link.offerId && offer && row.offerId === offer.id && current?.n === link.n) {
    // The current offer: the pool may write (the first accepted message claims it), the lease
    // holder may write, and a lapsed lease is as good as the pool (the message route returns it).
    const lapsed = offer.state === "held" && !!offer.leaseUntil && Date.parse(offer.leaseUntil) <= now && !replyInFlight(row.sessionId);
    if (offer.state === "held" && offer.holder !== link.personId && !lapsed) reason = "taken";
  } else if (link.offerId && !heldOffer(row, link.offerId, link.personId)) reason = "withdrawn";
  else if (!current || current.n !== link.n || row.holder !== link.personId) reason = row.holder === OPERATOR ? "needs-operator" : "moved-on";
  // At the limit the page says so, also once the baton has gone to the operator because of it.
  if (budgetSpent(row) && (!reason || reason === "needs-operator" || reason === "moved-on")) reason = "budget";
  return { ok: true, link, row, dir: hit.dir, canWrite: !reason, ...(reason ? { reason } : {}) };
}

/** A fresh link for the current hand-off (the host keeps no token to show again); older links of
    that hand-off are revoked. */
export function rotateLink(sessionId: string, personId?: string): { token: string; n: number } {
  const hit = batonById(sessionId);
  if (!hit) throw new OrgError("Unknown baton session", 404);
  const row = hit.row;
  const offer = currentOffer(row);
  if (offer) {
    // An offer: one invitee's link, re-minted; their older links of this offer stop working.
    if (!personId || !offer.to.includes(personId)) throw new OrgError("Name one of the invitees (?person=).", 400);
    const p = readRoster(row.orgId).find((x) => x.id === personId);
    if (p?.status !== "active") throw new OrgError(`${p?.name ?? "That person"} is not active, so they get no link.`, 409);
    revokeLinks((l) => l.sessionId === sessionId && l.offerId === offer.id && l.personId === personId);
    return { token: mintLink({ orgId: row.orgId, sessionId, n: offer.n, personId, offerId: offer.id }), n: offer.n };
  }
  const current = row.handoffs[row.handoffs.length - 1];
  if (!current || row.holder === null || row.holder === OPERATOR || current.to !== row.holder)
    throw new OrgError("No person holds the baton, so there is no link to share.", 409);
  revokeLinks((l) => l.sessionId === sessionId && l.n === current.n);
  return { token: mintLink({ orgId: row.orgId, sessionId, n: current.n, personId: row.holder }), n: current.n };
}

export function revokeCurrent(sessionId: string): number {
  const hit = batonById(sessionId);
  if (!hit) throw new OrgError("Unknown baton session", 404);
  const current = hit.row.handoffs[hit.row.handoffs.length - 1];
  return current ? revokeLinks((l) => l.sessionId === sessionId && l.n === current.n) : 0;
}

export const liveLinkCount = (row: BatonSession): number => {
  const current = row.handoffs[row.handoffs.length - 1];
  return current ? liveLinks(row.sessionId, current.n).length : 0;
};

// ---- the session list and the digest ---------------------------------------------------------------------------

/** `SessionSummary.baton` for a listed file, or undefined when it is not a baton session. */
export function batonSummaryField(path: string): BatonSummaryField | undefined {
  const hit = batonOfPath(path);
  if (!hit) return undefined;
  const row = hit.row;
  const last = row.handoffs[row.handoffs.length - 1];
  const offer = currentOffer(row);
  const proposals = proposalsOf(row);
  const linked = offer && offer.state === "open" && last?.offerId === offer.id ? new Set(liveLinks(row.sessionId, offer.n).map((l) => l.personId)) : null;
  const missing = linked ? offer!.to.filter((id) => !linked.has(id)).map((id) => nameOf(row.orgId, id)) : [];
  return {
    holder: row.holder === null ? (offer ? `${offer.to.length} invited` : null) : nameOf(row.orgId, row.holder),
    state: row.state,
    ...(offer ? { offer: { state: offer.state === "held" ? "held" : "open", invited: offer.to.length, ...(offer.holder ? { holder: nameOf(row.orgId, offer.holder) } : {}) } } : {}),
    ...(proposals.length ? { proposals } : {}),
    ...(row.state === "needs-you" && last && last.to === OPERATOR
      ? { needsYou: { from: nameOf(row.orgId, last.from), question: last.question, since: Date.parse(last.at) || 0 } }
      : {}),
    // A person holds it through a hand-off nobody has a link for yet: the operator must send one.
    ...(row.state === "open" && last && row.holder !== null && row.holder !== OPERATOR && last.to === row.holder && liveLinks(row.sessionId, last.n).length === 0
      ? { sendLink: { to: nameOf(row.orgId, row.holder), question: last.question, since: Date.parse(last.at) || 0 } }
      : {}),
    // An open offer with invitees nobody has a link for (started in-process without links): the
    // operator sends them — named until each has one.
    ...(missing.length ? { sendLink: { to: missing.join(", "), question: offer!.question, since: Date.parse(last!.at) || 0 } } : {}),
  };
}

export const workspaceHasFile = (dir: string, row: BatonSession): boolean => existsSync(join(dir, row.file));

/** People proposed from this session who still wait for the operator (§app.organizations/referrals). */
export function proposalsOf(row: BatonSession): NonNullable<BatonSummaryField["proposals"]> {
  let roster: Person[];
  try {
    roster = readRoster(row.orgId);
  } catch {
    return [];
  }
  const waiting = roster.filter((p) => p.status === "proposed" && p.referral?.sessionId === row.sessionId);
  if (!waiting.length) return [];
  const history = readHistory(row.orgId);
  return waiting.map((p) => {
    const created = history.find((c) => c.personId === p.id);
    const by = p.referral?.referredBy ?? "";
    return {
      personId: p.id,
      name: p.name,
      role: p.role,
      by: by === OPERATOR || roster.some((x) => x.id === by) ? nameOf(row.orgId, by, roster) : by,
      since: created ? Date.parse(created.at) || 0 : 0,
    };
  });
}

/** Record the wrap-up's progress on the row (server/baton-wrapup.ts). */
export function setWrapup(sessionId: string, info: WrapupInfo): void {
  update(sessionId, (r) => {
    r.wrapup = info;
  });
}
