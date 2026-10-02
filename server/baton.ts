import { randomUUID } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";
import {
  LEASE_IDLE_MS,
  MESSAGES_CAP,
  MESSAGES_DEFAULT,
  MESSAGES_MIN,
  OPERATOR,
  POOL,
  type BatonOwner,
  type BatonSession,
  type BatonStartInput,
  type BatonState,
  type BatonSummaryField,
  type GatheringAbilities,
  type GoneWhy,
  type Handoff,
  type Offer,
  type OfferReach,
  type PersonRef,
  type ViewerReason,
  type WrapupInfo,
} from "../shared/baton";
import type { Person } from "../shared/orgs";
import { deadWhy, liveLinks, mintLink, revokeLinks, type LinkRecord, linkDead, findLink } from "./baton-links";
import { openedSessions } from "./visits";
import { readBatonSettings } from "./baton-settings";
import { heldAt, hostOf, isOrgHostOpen, refusalError, type ActResult, type OrgHostApi, type SessionInfo } from "./org-engine";
import type { Envelope } from "./org-envelope";
import { envelopeFor } from "./org-engine";
import { effectiveHoursOf, isoOf, onOrgAttached, operatorEnvelope, operatorName, orgDir, orgOfSessionPath, OrgError, readHistory, readIndex, placementSid, readProjects, readRoster, setOpenBatonCounter, shortId, type OperatorBy } from "./orgs";
import { baseAbilities, operatorAbilities } from "./gathering-abilities";
import { canonicalPath } from "./paths";
import { projectOverseerPaths, readPoSettings } from "./project-overseer-store";
import { cleanSessionTitle, readSessionTitles, setSessionTitle } from "./session-titles";
import { addWebSession } from "./web-sessions";
import { markOwned } from "./write-guard";

/**
 * Baton sessions (§app/baton): one baton statechart per gathering session (`baton/<org>/<sessionId>`,
 * portable: its snapshot is in the org's workspace repo). The statechart owns every rule: moves, offers
 * and leases, the message lock and budget, the reply in flight, the wrap-up. This module answers
 * today's shapes from the statechart's data (q1: no baton.json) and turns every change into an act the
 * statechart takes or refuses with today's sentence. The runtime half (loadout, tools, the statechart's
 * effects and facts) is server/baton-loadout.ts; the outsider view server/baton-view.ts; the share
 * routes server/share/. Nothing here writes a token into the repo: links are server/baton-links.ts.
 *
 * States (the row's `state`): `open` (a person holds it, or it is offered), `needs-you` (the operator
 * holds it and hasn't answered), `done` (goal_done), `closed`.
 */

export const MESSAGES_MAX = MESSAGES_DEFAULT;
export const PUBLIC_TITLE_MAX = 120;
export const GOAL_MAX = 2000;
export const QUESTION_MAX = 1000;
export const BRIEFING_MAX = 4000;
/** An overseer's reason for a start (§app.baton/told): one or two sentences. */
export const WHY_MAX = 1000;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === "string" ? v : "");
const iso = (v: unknown): string | undefined => (v === null || v === undefined ? undefined : isoOf(v) || undefined);

export const batonSid = (orgId: string, sessionId: string) => `baton/${orgId}/${sessionId}`;

// ---- the session file ------------------------------------------------------------------------------------

/** sessionId → its file relative to the workspace ("sessions/<ts>_<id>.jsonl"); found by its suffix. */
const files = new Map<string, string>();

/** The session file of `sessionId` in a workspace repo, relative ("" when it is not there yet). */
export function batonFileOf(dir: string, sessionId: string): string {
  const have = files.get(sessionId);
  if (have && existsSync(join(dir, have))) return have;
  let names: string[] = [];
  try {
    names = readdirSync(join(dir, "sessions"));
  } catch {
    return "";
  }
  const name = names.find((f) => f.endsWith(`_${sessionId}.jsonl`));
  if (!name) return "";
  const rel = join("sessions", name);
  files.set(sessionId, rel);
  return rel;
}

// ---- the rows, from the statecharts -----------------------------------------------------------------------------

function handoffOf(h: Record<string, unknown>): Handoff {
  return {
    n: Number(h.n),
    from: str(h.from),
    to: str(h.to),
    question: str(h.question),
    briefing: str(h.briefing),
    at: isoOf(h.at),
    ...(typeof h.offerId === "string" ? { offerId: h.offerId } : {}),
  };
}

function offerOf(o: Record<string, unknown>): Offer {
  return {
    id: str(o.id),
    to: Array.isArray(o.to) ? (o.to as string[]) : [],
    question: str(o.question),
    briefing: str(o.briefing),
    state: o.state === "held" || o.state === "withdrawn" ? o.state : "open",
    ...(typeof o.holder === "string" ? { holder: o.holder } : {}),
    ...(Array.isArray(o.heldBy) && o.heldBy.length ? { heldBy: o.heldBy as string[] } : {}),
    ...(o.leaseUntil != null ? { leaseUntil: isoOf(o.leaseUntil) } : {}),
    ...(o.lastActivityAt != null ? { lastActivityAt: isoOf(o.lastActivityAt) } : {}),
    createdAt: isoOf(o.createdAt),
    n: Number(o.n),
    ...(o.state !== "withdrawn" && o.reach && typeof o.reach === "object" ? { reach: reachOf(o.reach as Record<string, unknown>, o.state === "held") } : {}),
  };
}

/** r12: the statechart's per-invitee reach (`{pid {state at? next?}}`, ms) as the reads show it; waiting ones of a held
    offer are paused (rule 12: nobody new is reached while it is leased). */
function reachOf(r: Record<string, unknown>, held: boolean): Record<string, OfferReach> {
  const out: Record<string, OfferReach> = {};
  for (const [pid, v] of Object.entries(r)) {
    const x = (v ?? {}) as Record<string, unknown>;
    out[pid] =
      x.state === "waiting"
        ? { state: "waiting", until: typeof x.next === "number" ? isoOf(x.next) : null, ...(held ? { paused: true as const } : {}) }
        : { state: "reached", ...(typeof x.at === "number" ? { at: isoOf(x.at) } : {}) };
  }
  return out;
}

/** Whether an invitee of this offer has been reached (r12; an offer from before r12 reached everyone). */
export const reachedBy = (o: Pick<Offer, "reach">, personId: string): boolean => o.reach?.[personId]?.state !== "waiting";

function wrapupOf(w: unknown): WrapupInfo | undefined {
  if (!isObj(w) || typeof w.state !== "string") return undefined;
  return {
    state: w.state as WrapupInfo["state"],
    at: isoOf(w.at),
    applied: typeof w.applied === "number" ? w.applied : 0,
    refused: Array.isArray(w.refused) ? (w.refused as WrapupInfo["refused"]) : [],
    ...(typeof w.error === "string" ? { error: w.error } : {}),
  };
}

function stateOf(configuration: readonly string[], d: Record<string, unknown>): BatonState {
  if (configuration.includes("closed")) return "closed";
  if (configuration.includes("done")) return "done";
  return d.needsYou === true ? "needs-you" : "open";
}

/** The row today's routes and pages read, from a baton session of the statechart. */
export function rowOf(dir: string, s: Pick<SessionInfo, "configuration" | "data">): BatonSession {
  const d = s.data;
  const sessionId = str(d.sessionId);
  const owner: BatonOwner = isObj(d.owner) && typeof d.owner.overseerOf === "string" ? { overseerOf: d.owner.overseerOf } : "operator";
  const budget = isObj(d.budget) ? d.budget : {};
  const conflict = isObj(d.conflict) && typeof d.conflict.id === "string" ? { id: d.conflict.id, area: str(d.conflict.area) } : undefined;
  return {
    sessionId,
    file: batonFileOf(dir, sessionId),
    orgId: str(d.orgId),
    projectId: str(d.projectId),
    owner,
    goal: str(d.goal),
    publicTitle: str(d.publicTitle),
    participants: Array.isArray(d.participants) ? (d.participants as string[]) : [],
    holder: typeof d.holder === "string" ? d.holder : null,
    state: stateOf(s.configuration, d),
    handoffs: Array.isArray(d.handoffs) ? (d.handoffs as Record<string, unknown>[]).map(handoffOf) : [],
    ...(Array.isArray(d.offers) && d.offers.length ? { offers: (d.offers as Record<string, unknown>[]).map(offerOf) } : {}),
    ...(typeof d.offerId === "string" ? { offerId: d.offerId } : {}),
    ...(typeof d.parent === "string" && d.parent ? { parent: d.parent } : {}),
    ...(wrapupOf(d.wrapup) ? { wrapup: wrapupOf(d.wrapup) } : {}),
    budget: { messagesMax: typeof budget.messagesMax === "number" ? budget.messagesMax : MESSAGES_DEFAULT, messagesUsed: typeof budget.messagesUsed === "number" ? budget.messagesUsed : 0 },
    ...(typeof d.model === "string" && d.model ? { model: d.model } : {}),
    ...(typeof d.thinking === "string" && d.thinking ? { thinking: d.thinking } : {}),
    ...(isObj(d.abilities) ? { abilities: { draw: d.abilities.draw === true, readLinks: d.abilities.readLinks === true } } : {}),
    createdAt: isoOf(d.createdAt),
    ...(iso(d.closedAt) ? { closedAt: iso(d.closedAt) } : {}),
    ...(d.hiddenFromOwner === true ? { hiddenFromOwner: true } : {}),
    ...(iso(d.wroteAt) ? { wroteAt: iso(d.wroteAt) } : {}),
    ...(conflict ? { conflict } : {}),
    ...(d.startedVia === "overseer" ? { startedVia: "overseer" as const } : {}),
  };
}

function rowsOf(orgId: string, dir: string): BatonSession[] {
  if (!isOrgHostOpen(orgId)) return [];
  return hostOf(orgId)
    .sessions("baton")
    // r11: retired past its project's 200-row cap (its statechart's final state): no longer the org's
    .filter((s) => s.running)
    .map((s) => rowOf(dir, s))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/** r11: a gathering its project retired past the 200-row cap (no longer organizational). */
export function isRetiredBaton(orgId: string, sessionId: string): boolean {
  if (!isOrgHostOpen(orgId)) return false;
  const sid = batonSid(orgId, sessionId);
  return hostOf(orgId).sessions("baton").some((s) => s.id === sid && !s.running);
}

/** Every baton session of every attached org. */
export function allBatons(): BatonSession[] {
  const out: BatonSession[] = [];
  for (const o of readIndex().orgs) out.push(...rowsOf(o.id, o.dir));
  return out;
}

setOpenBatonCounter(
  (orgId) => {
    try {
      // An archived project's are not counted (§app.organizations/archive; none are open while it is).
      const archived = new Set(readProjects(orgId).filter((p) => p.archived).map((p) => p.id));
      return rowsOf(orgId, orgDir(orgId)).filter((r) => (r.state === "open" || r.state === "needs-you") && !archived.has(r.projectId)).length;
    } catch {
      return 0;
    }
  },
  (orgId) => {
    const dir = orgDir(orgId);
    const roster = readRoster(orgId);
    return rowsOf(orgId, dir)
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
    if (!isOrgHostOpen(o.id)) continue;
    const host = hostOf(o.id);
    const sid = batonSid(o.id, sessionId);
    const data = host.data(sid);
    const configuration = host.configuration(sid) ?? [];
    // r11: retired (its statechart's final state, an empty configuration): no longer the org's
    if (data && configuration.length) return { row: rowOf(o.dir, { configuration, data }), dir: o.dir };
  }
  return null;
}

/** Session id from a session file name (`<ts>_<uuid>.jsonl`). */
const idOfFile = (path: string): string => {
  const b = basename(path, ".jsonl");
  const i = b.indexOf("_");
  return i >= 0 ? b.slice(i + 1) : b;
};

/** The row of a session file, when it lives in an attached org's workspace and is a baton session. */
export function batonOfPath(path: string): { row: BatonSession; dir: string } | null {
  const org = orgOfSessionPath(path);
  if (!org) return null;
  const hit = batonById(idOfFile(path));
  return hit && hit.row.orgId === org.orgId ? hit : null;
}

export const sessionPathOf = (dir: string, row: BatonSession): string => canonicalPath(join(dir, row.file || batonFileOf(dir, row.sessionId) || join("sessions", `_${row.sessionId}.jsonl`)));

/**
 * An attach (a restored clone): what this host keeps about each baton session outside the repo is
 * derived again from the statecharts: its listing title (the public title; a title the operator already
 * gave it here stays), its web origin, and the write guard's stat, so the operator's composer isn't
 * refused as "recently written by someone else" for the files the clone just wrote. Links are not
 * derived: they are minted again when the operator asks.
 */
onOrgAttached((orgId, dir) => {
  const titles = readSessionTitles();
  for (const row of rowsOf(orgId, dir)) {
    const path = sessionPathOf(dir, row);
    if (!existsSync(path)) continue;
    addWebSession(row.sessionId);
    markOwned(path);
    if (!titles[row.sessionId]) setSessionTitle(row.sessionId, cleanSessionTitle(row.publicTitle) ?? null);
  }
});

// ---- names -------------------------------------------------------------------------------------------------

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

/** A roster person as an act's envelope names a target (`target {id name status referral?}`). */
export const targetOfPerson = (p: Pick<Person, "id" | "name" | "status" | "referral" | "tz" | "hours"> & { orgId?: string }) => {
  // r7: the act waits for their working hours (the statechart's act meta `:hours` reads these); r13: the effective ones
  // (their own, else the company's).
  const eff = p.orgId ? effectiveHoursOf(p.orgId, p.id) : { tz: p.tz, hours: p.hours ?? undefined };
  return {
    id: p.id,
    name: p.name,
    status: p.status,
    ...(p.referral ? { referral: true } : {}),
    ...(eff.tz ? { tz: eff.tz } : {}),
    ...(eff.hours ? { hours: eff.hours } : {}),
  };
};
const operatorTarget = () => ({ id: OPERATOR, name: operatorName(), status: "active" as const });

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

/** A hand_to target as the statechart reads it: `target` for a resolved one, `invalid` (the sentence) otherwise. */
export function handToTarget(orgId: string, raw: string): { target?: { id: string; name: string; status: string }; invalid?: string } {
  const roster = readRoster(orgId);
  const t = resolveTarget(roster, raw, operatorName());
  if (!t.ok) return { invalid: t.error };
  if (t.ref === OPERATOR) return { target: operatorTarget() };
  return { target: targetOfPerson(roster.find((p) => p.id === t.ref)!) };
}

// ---- creation -------------------------------------------------------------------------------------------------

/** A message limit from a request: a whole number within MESSAGES_MIN..MESSAGES_CAP, else a 400. */
export function messageLimit(v: unknown, field = "messagesMax", min = MESSAGES_MIN, max = MESSAGES_CAP): number {
  const why = messageLimitProblem(v, field, min, max);
  if (why) throw new OrgError(why);
  return v as number;
}
const messageLimitProblem = (v: unknown, field: string, min: number, max: number): string | null =>
  typeof v !== "number" || !Number.isInteger(v) || v < min || v > max ? `${field} must be a whole number from ${min} to ${max}` : null;

/** A text field's problem (required, at most `max`), or null. */
const textProblem = (v: unknown, field: string, max: number, required = true): string | null => {
  const t = typeof v === "string" ? v.trim() : "";
  if (required && !t) return `${field} is required`;
  if (t.length > max) return `${field} must be at most ${max} characters`;
  return null;
};
const cleanText = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

export interface Created {
  path: string;
  sessionId: string;
  token?: string;
  /** One per invitee when started as an offer. */
  links?: { personId: string; token: string }[];
  /** Held (q10): an unattended overseer's start waits in a hold; nothing exists yet. */
  held?: { id: string; until: number };
  /** Filed as its gap's planned gathering (gather/plan): nothing exists yet; the statechart starts it at L1. */
  planned?: true;
  /** r7: the operator's own act went at once although the person is off hours: when their window opens (ISO). */
  offHours?: string;
}

/** r7: when the act went to someone off hours, when their window opens (the engine's step says so). */
export function offHoursOf(out: ActResult): { offHours?: string } {
  const at = out.result?.steps.find((s) => s.offHours != null)?.offHours;
  return typeof at === "number" ? { offHours: new Date(at).toISOString() } : {};
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

/** The row's current offer (open or held), or undefined. */
export const currentOffer = (row: Pick<BatonSession, "offers" | "offerId">): Offer | undefined =>
  row.offerId ? row.offers?.find((o) => o.id === row.offerId && o.state !== "withdrawn") : undefined;

/** Whether `personId` has held offer `offerId` of this row (its lease, now or before). Holding an
    earlier hand-off of the session does not count: this offer's content is new to them. */
export function heldOffer(row: Pick<BatonSession, "offers">, offerId: string, personId: string): boolean {
  const o = row.offers?.find((x) => x.id === offerId);
  return !!o && (o.holder === personId || !!o.heldBy?.includes(personId));
}

/**
 * Where a person's view of this session stops (§app.baton/outsider-view), whichever of their links
 * they read it through: at the newest offer to them that they never held — its hand-off `n` —
 * unless the baton came to them directly after it. undefined: they see the whole conversation.
 */
export function outsiderCut(row: Pick<BatonSession, "offers" | "handoffs">, personId: string): number | undefined {
  const offer = [...(row.offers ?? [])].reverse().find((o) => o.to.includes(personId));
  if (!offer || heldOffer(row, offer.id, personId)) return undefined;
  const direct = [...row.handoffs].reverse().find((h) => h.to === personId);
  return direct && direct.n > offer.n ? undefined : offer.n;
}

/** What a gathering session of this project started now gets: its setting, else Automatic. */
export function projectAbilities(orgId: string, projectId: string): GatheringAbilities {
  return baseAbilities(readPoSettings(projectOverseerPaths(orgId, projectId)).gatheringAbilities);
}

/** The lease's idle time: LEASE_IDLE_MS, or SOVA_BATON_LEASE_MS when set (hermetic tests only). */
export function leaseMs(env: NodeJS.ProcessEnv = process.env): number {
  const v = Number(env.SOVA_BATON_LEASE_MS);
  return Number.isFinite(v) && v >= 1000 ? Math.floor(v) : LEASE_IDLE_MS;
}

/** Tokens the statechart's link effects minted, by `<sessionId>#<n>#<personId>`: handed to the caller that
    asked (a route shows a link once), never into the effect's result (that reaches the log). */
const minted = new Map<string, string>();
const mintKey = (sessionId: string, n: number, personId: string) => `${sessionId}#${n}#${personId}`;
const mintWaiters = new Map<string, (token: string) => void>();

/** Mint a link for the statechart's `mint-link`/`mint-links` effect (server/baton-loadout.ts). */
export function mintForEffect(input: { orgId: string; sessionId: string; n: number; personId: string; offerId?: string; key: string }): void {
  const token = mintLink(input);
  const k = mintKey(input.sessionId, input.n, input.personId);
  minted.set(k, token);
  mintWaiters.get(k)?.(token);
  mintWaiters.delete(k);
  // Handed over within a minute or never: a token is not kept around.
  setTimeout(() => minted.delete(k), 60_000).unref?.();
}

/** The token minted for this hand-off and person (once: it is forgotten as it is taken); waits up to `ms`. */
export function takeMinted(sessionId: string, n: number, personId: string, ms = 0): Promise<string | undefined> {
  const k = mintKey(sessionId, n, personId);
  const have = minted.get(k);
  if (have || ms <= 0) {
    minted.delete(k);
    return Promise.resolve(have);
  }
  return new Promise((resolve) => {
    const t = setTimeout(() => {
      mintWaiters.delete(k);
      resolve(undefined);
    }, ms);
    t.unref?.();
    mintWaiters.set(k, (token) => {
      clearTimeout(t);
      minted.delete(k);
      resolve(token);
    });
  });
}

/** The org of a baton session, or a 404. */
function orgOfBaton(sessionId: string): { orgId: string; row: BatonSession; dir: string } {
  const hit = batonById(sessionId);
  if (!hit) throw new OrgError("Unknown baton session", 404);
  return { orgId: hit.row.orgId, row: hit.row, dir: hit.dir };
}

/** Send an act to a baton session; a refusal throws as the route answers it. */
export async function batonAct(sessionId: string, event: string, payload: Record<string, unknown>, envelope: Envelope | ((orgId: string, projectId: string) => Envelope), opts: { settle?: boolean } = {}): Promise<ActResult> {
  const { orgId, row } = orgOfBaton(sessionId);
  const env = typeof envelope === "function" ? envelope(orgId, row.projectId) : envelope;
  const out = await hostOf(orgId).act(batonSid(orgId, sessionId), event, payload, env, opts);
  if (!out.taken) throw refusalError(out.refusal ?? { sentence: "That can't be done now." });
  return out;
}

/** The operator's envelope for an act on a baton session (or theirs through the global Overseer). */
export const operatorOn = (by?: OperatorBy) => (orgId: string, projectId: string) => operatorEnvelope(orgId, projectId, by);
/** An envelope for an act by the session's own actors (the model, a person, the host). */
export const actorOn = (by: "model" | "person" | "system" | "wrapup") => (orgId: string, projectId: string) => envelopeFor(orgId, projectId, { by, attended: false });

export interface CreateOptions {
  /** Who starts it (default: the operator). The project overseer's comes with its turn's envelope. */
  envelope?: Envelope;
  by?: OperatorBy;
  /** false: no link is minted (an in-process caller that can't show one); Needs you asks the operator. */
  mintLink?: boolean;
  startedVia?: "overseer";
  /** An overseer's reason for starting it, for the operator only (§app.baton/told); its tool requires one. */
  why?: string;
  /** Sova's own item for it (the operator's to-do it came from). */
  opItem?: string;
  /** A gap's item statechart (`item/…`): it starts the gathering (gather/start) and links it, instead of the project. */
  item?: string;
  /** With `item`: file it as the gap's planned gathering (gather/plan), started by the statechart itself at L1 (r3). */
  plan?: boolean;
}

/**
 * Who starts it, as its statechart records it (§app.baton/goal-and-loadout): the project overseer comes with its
 * turn's envelope, the global Overseer as the operator via the Overseer; anyone else is the operator.
 */
function startedRecord(opts: CreateOptions): { by: "operator" | "overseer" | "project-overseer"; overseerId?: string; why?: string } {
  const why = cleanText(opts.why);
  const extra = (overseerId: string | undefined) => ({ ...(overseerId ? { overseerId } : {}), ...(why ? { why } : {}) });
  if (opts.envelope?.by === "overseer") return { by: "project-overseer", ...extra(opts.envelope.overseerId) };
  if (opts.startedVia === "overseer") return { by: "overseer", ...extra(opts.by?.overseerId) };
  return { by: "operator" };
}

/**
 * Start a baton session: the project statechart's `baton/start` spawns its baton statechart, which makes the
 * session file in the org's workspace `sessions/` (cwd = the workspace repo) with the `sova-baton`
 * marker and the first hand-off (or offer), and mints the first holder's link (or one per invitee).
 * The request's own problems (a text field, the targets, the limit, the abilities) are the host's
 * `invalid`, refused by the statechart after the project's archive check, as today's order.
 */
export async function createBaton(input: BatonStartInput, opts: CreateOptions = {}): Promise<Created> {
  const orgId = String(input.orgId ?? "");
  orgDir(orgId); // 404 for an unknown org
  const parent = typeof input.parentSessionId === "string" && input.parentSessionId ? batonById(input.parentSessionId) : null;
  if (input.parentSessionId && (!parent || parent.row.orgId !== orgId)) throw new OrgError("Unknown parent session", 404);
  const projectId = input.projectId || parent?.row.projectId || "";
  const project = readProjects(orgId).find((p) => p.id === projectId);
  if (!project) throw new OrgError("Unknown project", 404);
  const roster = readRoster(orgId);
  const many = Array.isArray(input.to) && input.to.length > 1;
  const invitees = many ? resolveInvitees(roster, input.to as unknown[], operatorName()) : null;
  const target = many ? null : resolveTarget(roster, String((Array.isArray(input.to) ? input.to[0] : input.to) ?? ""), operatorName());
  const abilities = operatorAbilities(input.abilities, projectAbilities(orgId, project.id));
  const limitWhy = input.messagesMax === undefined || input.messagesMax === null ? null : messageLimitProblem(input.messagesMax, "messagesMax", MESSAGES_MIN, MESSAGES_CAP);
  // Today's order after the archive check: the texts, the targets, the limit, the abilities.
  const invalid =
    textProblem(input.publicTitle, "publicTitle", PUBLIC_TITLE_MAX) ??
    textProblem(input.goal, "goal", GOAL_MAX) ??
    textProblem(input.question ?? "", "question", QUESTION_MAX, false) ??
    textProblem(input.briefing ?? "", "briefing", BRIEFING_MAX, false) ??
    (invitees && !invitees.ok ? invitees.error : null) ??
    (target && !target.ok ? target.error : null) ??
    limitWhy ??
    ("error" in abilities ? abilities.error : null) ??
    textProblem(opts.why ?? "", "why", WHY_MAX, false);
  const publicTitle = cleanText(input.publicTitle);
  const sessionId = randomUUID();
  const to = target?.ok ? target.ref : undefined;
  const targets = invitees?.ok ? invitees.refs : undefined;
  const mint = opts.mintLink !== false;
  const model = cleanText(input.model);
  const thinking = cleanText(input.thinking);
  const payload: Record<string, unknown> = {
    sessionId,
    ...(to ? { to } : {}),
    ...(targets ? { targets, offerId: shortId("off_") } : {}),
    publicTitle,
    goal: cleanText(input.goal),
    question: cleanText(input.question) || publicTitle,
    briefing: cleanText(input.briefing),
    ...(model ? { model } : {}),
    ...(thinking ? { thinking } : {}),
    messagesMax: typeof input.messagesMax === "number" && !limitWhy ? input.messagesMax : readBatonSettings().messagesMax,
    ...("error" in abilities ? {} : { abilities }),
    ...(parent ? { parent: parent.row.sessionId } : {}),
    ...(mint ? {} : { mintLink: false }),
    ...(opts.startedVia ? { startedVia: opts.startedVia } : {}),
    started: startedRecord(opts),
    ...(opts.opItem ? { opItem: opts.opItem } : {}),
    leaseMs: leaseMs(),
    operatorName: operatorName(),
  };
  // The person it reaches, as the statechart reads them (status, and r7's zone and hours).
  const person = to && to !== OPERATOR ? roster.find((p) => p.id === to) : undefined;
  // An offer's invitees as the statechart reads them (r7: an offer waits until the earliest invitee's window).
  const targetPeople = targets ? targets.map((id) => roster.find((p) => p.id === id)).filter((p): p is Person => !!p).map(targetOfPerson) : undefined;
  const envelope = { ...(opts.envelope ?? operatorEnvelope(orgId, project.id, opts.by)), ...(invalid ? { invalid } : {}), ...(person ? { target: targetOfPerson(person) } : {}), ...(targetPeople ? { targetPeople } : {}) };
  const [sid, event] = opts.item ? [opts.item, opts.plan ? "gather/plan" : "gather/start"] : [placementSid(orgId, project.id), "baton/start"];
  const out = await hostOf(orgId).act(sid, event, payload, envelope, { settle: true });
  if (!out.taken) throw refusalError(out.refusal ?? { sentence: "That can't be done now." });
  if (out.held) return { path: "", sessionId, held: heldAt(sid, out.held) };
  if (opts.plan) return { path: "", sessionId: "", planned: true };
  for (const e of out.effects ?? []) if (e.kind === "create-session" && e.error) throw new Error(e.error);
  const dir = orgDir(orgId);
  const path = canonicalPath(join(dir, batonFileOf(dir, sessionId)));
  const off = offHoursOf(out);
  if (!mint) return { path, sessionId, ...off };
  if (targets) {
    const links: { personId: string; token: string }[] = [];
    for (const personId of targets) {
      const token = await takeMinted(sessionId, 1, personId);
      if (token) links.push({ personId, token });
    }
    return { path, sessionId, links, ...off };
  }
  const token = to && to !== OPERATOR ? await takeMinted(sessionId, 1, to) : undefined;
  return { path, sessionId, ...(token ? { token } : {}), ...off };
}

// ---- the model's acts (its tools) ----------------------------------------------------------------------------

/**
 * hand_to: the model hands the conversation to `person` (a roster name or id, or "operator"). `chosen`: the
 * person talking chose who answers next (else the statechart refuses, unless the operator's goal named them).
 * The statechart refuses in today's words; returns the new hand-off's number and who it came from.
 */
export async function handTo(sessionId: string, person: string, question: string, briefing: string, opts: { chosen?: boolean } = {}): Promise<{ n: number; from: PersonRef }> {
  const { orgId } = orgOfBaton(sessionId);
  const { target, invalid } = handToTarget(orgId, person);
  await batonAct(sessionId, "baton/hand-to", { ...(target ? { target } : {}), ...(invalid ? { invalid } : {}), chosen: opts.chosen ?? true, question, briefing }, actorOn("model"), { settle: true });
  const h = batonById(sessionId)!.row.handoffs.at(-1)!;
  return { n: h.n, from: h.from };
}

/** goal_done: the goal is met; the conversation ends and its wrap-up starts. */
export async function markDone(sessionId: string, summary = "Done."): Promise<BatonSession> {
  await batonAct(sessionId, "baton/goal-done", { summary }, actorOn("model"), { settle: true });
  return batonById(sessionId)!.row;
}

// ---- the operator's acts ----------------------------------------------------------------------------------------

/** The operator's change from the strip (§app.baton/abilities): applies from the next run. */
export async function setAbilities(sessionId: string, v: unknown, by?: OperatorBy): Promise<BatonSession> {
  const { row } = orgOfBaton(sessionId);
  const next = operatorAbilities(v, abilitiesOfRow(row));
  await batonAct(sessionId, "baton/abilities", "error" in next ? {} : { abilities: next }, (o, p) => ({ ...operatorEnvelope(o, p, by), ...("error" in next ? { invalid: next.error } : {}) }), { settle: true });
  return batonById(sessionId)!.row;
}
const abilitiesOfRow = (row: BatonSession): GatheringAbilities => row.abilities ?? { draw: false, readLinks: false };

/**
 * Raise a session's message limit by `by` (the operator, from the strip or the Needs-you item):
 * the holder may write again. Bounded like any limit; refused once the session is done or closed.
 */
export async function extendBudget(sessionId: string, by: unknown, who?: OperatorBy): Promise<BatonSession> {
  // `more`: the envelope's own `by` is the actor.
  await batonAct(sessionId, "baton/extend", { more: by }, operatorOn(who), { settle: true });
  return batonById(sessionId)!.row;
}

/** Hide a conversation from the org owner's page, or show it again (§app.owner-page/chats; the operator's strip). */
export async function setHiddenFromOwner(sessionId: string, hidden: boolean, by?: OperatorBy): Promise<BatonSession> {
  await batonAct(sessionId, "baton/hide", { hidden }, operatorOn(by), { settle: true });
  return batonById(sessionId)!.row;
}

/** Close it (the operator's Close; `envelope` for the overseer's sova_close_gathering or the system). */
export async function closeBaton(sessionId: string, opts: { by?: OperatorBy; envelope?: Envelope; reason?: string; ownerProject?: string } = {}): Promise<ActResult> {
  return batonAct(sessionId, "baton/close", { ...(opts.reason !== undefined ? { reason: opts.reason } : {}), ...(opts.ownerProject ? { ownerProject: opts.ownerProject } : {}) }, opts.envelope ?? operatorOn(opts.by), { settle: true });
}

/** Take the baton back (the operator; a reply in flight is stopped first, by the statechart). */
export async function takeBack(sessionId: string, by?: OperatorBy): Promise<ActResult> {
  return batonAct(sessionId, "baton/take-back", {}, operatorOn(by), { settle: true });
}

/** Withdraw the open offer (the operator); the baton comes back to them. */
export async function withdrawOffer(sessionId: string, by?: OperatorBy): Promise<ActResult> {
  return batonAct(sessionId, "baton/withdraw", {}, operatorOn(by), { settle: true });
}

/** Wait until the statechart's data says `done`, or `ms` passed (a move held for a reply's end). */
async function until(sessionId: string, done: (row: BatonSession) => boolean, ms: number): Promise<BatonSession | null> {
  const end = Date.now() + ms;
  for (;;) {
    const row = batonById(sessionId)?.row ?? null;
    if (row && done(row)) return row;
    if (Date.now() >= end) return row;
    await new Promise((r) => setTimeout(r, 25));
  }
}

/**
 * Hand the baton to a roster person (the operator's hand-off, §app.baton/hand-off): the statechart checks
 * who and what, stops a reply in flight and moves once it ended, and mints their link, returned once.
 */
export async function handoffTo(sessionId: string, personId: string, question: string, briefing: string, by?: OperatorBy, opts: { mintLink?: boolean } = {}): Promise<{ n: number; token?: string; offHours?: string }> {
  const { orgId } = orgOfBaton(sessionId);
  const p = readRoster(orgId).find((x) => x.id === personId);
  const before = batonById(sessionId)!.row.handoffs.length;
  const out = await batonAct(sessionId, "baton/handoff", { question, briefing, ...(p ? { target: targetOfPerson(p) } : {}), ...(opts.mintLink === false ? { mintLink: false } : {}) }, operatorOn(by), { settle: true });
  const row = await until(sessionId, (r) => r.handoffs.length > before, 30_000);
  const n = row && row.handoffs.length > before ? row.handoffs.length : before;
  const token = n > before && opts.mintLink !== false ? await takeMinted(sessionId, n, personId, 5_000) : undefined;
  return { n, ...(token ? { token } : {}), ...offHoursOf(out) };
}

/**
 * Offer the baton to several people at once (§app.baton/offers-and-leases): the statechart withdraws a
 * current offer, stops a reply in flight, and mints one link per invitee (unless `mintLink` false).
 */
export async function offerTo(sessionId: string, to: readonly unknown[], question: string, briefing: string, opts: { by?: OperatorBy; envelope?: Envelope; mintLink?: boolean } = {}): Promise<{ n: number; offer?: Offer; links: { personId: string; token: string }[] }> {
  const { orgId, row } = orgOfBaton(sessionId);
  const roster = readRoster(orgId);
  const invitees = resolveInvitees(roster, to, operatorName());
  const project = readProjects(orgId).find((p) => p.id === row.projectId);
  const qWhy = textProblem(question, "question", QUESTION_MAX, false) ?? textProblem(briefing, "briefing", BRIEFING_MAX, false);
  const invalid = invitees.ok ? qWhy : invitees.error;
  const before = row.handoffs.length;
  const targets = invitees.ok ? invitees.refs.map((id) => targetOfPerson(roster.find((p) => p.id === id)!)) : [];
  await batonAct(
    sessionId,
    "baton/offer",
    { targets, question: cleanText(question), briefing: cleanText(briefing), offerId: shortId("off_"), ...(opts.mintLink === false ? { mintLink: false } : {}) },
    (o, p) => ({ ...(opts.envelope ?? operatorEnvelope(o, p, opts.by)), ...(invalid ? { invalid } : {}), projectName: project?.name ?? "" }),
    { settle: true },
  );
  const after = await until(sessionId, (r) => r.handoffs.length > before, 30_000);
  const n = after && after.handoffs.length > before ? after.handoffs.length : before;
  const offer = after ? currentOffer(after) : undefined;
  const links: { personId: string; token: string }[] = [];
  if (offer && opts.mintLink !== false)
    for (const personId of offer.to) {
      const token = await takeMinted(sessionId, n, personId, 5_000);
      if (token) links.push({ personId, token });
    }
  return { n, ...(offer ? { offer } : {}), links };
}

/** Run a failed wrap-up again (the operator's Retry). */
export async function retryWrapup(sessionId: string, by?: OperatorBy): Promise<ActResult> {
  return batonAct(sessionId, "baton/wrapup-retry", {}, operatorOn(by), { settle: true });
}

// ---- messages -----------------------------------------------------------------------------------------------

export const budgetSpent = (r: Pick<BatonSession, "budget">): boolean => r.budget.messagesUsed >= r.budget.messagesMax;

/** A message by `by` is by someone the session was sent to: a roster person, or the operator when the
    first hand-off went to the operator (a conflict routed to them). */
export const wroteForIt = (r: Pick<BatonSession, "handoffs">, by: PersonRef): boolean => by !== OPERATOR || r.handoffs[0]?.to === OPERATOR;

export interface Noted {
  /** This message claimed an open offer (its lease is theirs now). */
  claimed: boolean;
}

/**
 * A message entered the session (from the share page or the operator's composer). The lock of
 * §app.baton/offers-and-leases is the statechart's `baton/message`, stepped synchronously here: an
 * invitee's message on an open offer CLAIMS it (the first accepted message wins), the holder rule
 * applies as for any hand-off, the holder's message renews the lease, the budget counts it, the
 * operator answering clears Needs you. A refusal throws OrgError with the statechart's sentence and code
 * (`taken`, `budget`, `gone`). The caller hands the message to the runtime in the same synchronous
 * stretch, and calls undoNote if the runtime refuses it after all.
 */
export function noteMessage(sessionId: string, by: PersonRef): Noted {
  const { orgId, row } = orgOfBaton(sessionId);
  const active = by === OPERATOR || readRoster(orgId).find((p) => p.id === by)?.status === "active";
  const host = hostOf(orgId);
  const envelope = by === OPERATOR ? operatorEnvelope(orgId, row.projectId) : envelopeFor(orgId, row.projectId, { by: "person", attended: false });
  const out = host.actNow(batonSid(orgId, sessionId), "baton/message", { from: by, active }, envelope);
  if (!out.taken) throw refusalError(out.refusal ?? { sentence: "That can't be done now." });
  const after = hostOf(orgId).data(batonSid(orgId, sessionId));
  const last = isObj(after?.lastNote) ? after!.lastNote : {};
  return { claimed: (last as { claimed?: unknown }).claimed === true };
}

/** The runtime refused the message noteMessage let in: as if it never came (it neither counts nor claims). */
export function undoNote(sessionId: string): void {
  const { orgId, row } = orgOfBaton(sessionId);
  hostOf(orgId).actNow(batonSid(orgId, sessionId), "message/refused", {}, envelopeFor(orgId, row.projectId, { by: "system", attended: false }));
}

/**
 * Lower a session's message count to `used` (server/baton-recount.ts: messages a kill lost), only
 * while it still reads `expected`: a message counted since the caller looked stays counted. The
 * statechart never raises a count. Returns whether it changed.
 */
export function setBudgetUsed(sessionId: string, used: number, expected: number): boolean {
  const { orgId, row } = orgOfBaton(sessionId);
  if (row.budget.messagesUsed !== expected || used >= expected || used < 0) return false;
  const out = hostOf(orgId).actNow(batonSid(orgId, sessionId), "budget/recount", { n: used }, envelopeFor(orgId, row.projectId, { by: "system", attended: false }));
  return out.taken && batonById(sessionId)?.row.budget.messagesUsed === used;
}

// ---- links, as the share routes and the strip need them ------------------------------------------------------

export type LinkAccess =
  | { ok: true; link: LinkRecord; row: BatonSession; dir: string; canWrite: boolean; reason?: ViewerReason }
  | { ok: false; status: 404 | 410; why?: GoneWhy };

/** What a presented token may do (§app.baton/links). */
export function linkAccess(token: string, now = Date.now()): LinkAccess {
  const link = findLink(token);
  if (!link) return { ok: false, status: 404 };
  const hit = batonById(link.sessionId);
  if (!hit) return { ok: false, status: 404 };
  const a = accessOf(link, hit.row, now);
  if (!a.ok) return a;
  return { ok: true, link, row: hit.row, dir: hit.dir, canWrite: a.canWrite, ...(a.reason ? { reason: a.reason } : {}) };
}

/** What a link may do on its session's row, with no token: 410 when it is turned off, expired or
    the session is closed (with `why` only for an expired link or a withdrawn offer's); else whether
    it writes now, and why not. linkAccess, and the person page's link states. A lapsed lease is the
    statechart's timer (never mid-reply): until it fires, the lease holds. */
export function accessOf(link: LinkRecord, row: BatonSession, now = Date.now()): { ok: true; canWrite: boolean; reason?: ViewerReason } | { ok: false; status: 410; why?: GoneWhy } {
  if (linkDead(link, now)) {
    const why = deadWhy(link, now);
    return { ok: false, status: 410, ...(why ? { why } : {}) };
  }
  if (row.state === "closed") return { ok: false, status: 410 };
  const current = row.handoffs[row.handoffs.length - 1];
  let reason: ViewerReason | undefined;
  const offer = link.offerId ? row.offers?.find((o) => o.id === link.offerId) : undefined;
  if (row.state === "done") reason = "done";
  else if (link.offerId && offer && row.offerId === offer.id && current?.n === link.n) {
    // The current offer: the pool may write (the first accepted message claims it), the lease holder may write.
    if (offer.state === "held" && offer.holder !== link.personId) reason = "taken";
  } else if (link.offerId && !heldOffer(row, link.offerId, link.personId)) reason = "withdrawn";
  // They hold it, through a newer link: this one only reads, and the page points them to that one.
  else if (row.holder === link.personId && current?.n !== link.n) reason = "newer-link";
  else if (!current || current.n !== link.n || row.holder !== link.personId) reason = row.holder === OPERATOR ? "needs-operator" : "moved-on";
  // At the limit the page says so, also once the baton has gone to the operator because of it.
  if (budgetSpent(row) && (!reason || reason === "needs-operator" || reason === "moved-on")) reason = "budget";
  return { ok: true, canWrite: !reason, ...(reason ? { reason } : {}) };
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
    // r12: an invitee is reached only in their own working hours; until then there is no link to send.
    if (!reachedBy(offer, personId)) throw new OrgError(`${p.name} is not reached yet: their link is made when their working hours start.`, 409);
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

/** personId → when their newest live link of the current round was minted: the open offer's links
    while one is out, else the current hand-off's. */
export function linkTimes(row: BatonSession): Record<string, string> {
  const last = row.handoffs[row.handoffs.length - 1];
  const offer = currentOffer(row);
  const n = offer && offer.state === "open" && last?.offerId === offer.id ? offer.n : last?.n;
  const out: Record<string, string> = {};
  if (n === undefined) return out;
  for (const l of liveLinks(row.sessionId, n)) if (!out[l.personId] || Date.parse(l.createdAt) > Date.parse(out[l.personId]!)) out[l.personId] = l.createdAt;
  return out;
}

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
  // r12: only a reached invitee needs a link; one still waiting for their hours is listed as waiting.
  const missing = linked ? offer!.to.filter((id) => reachedBy(offer!, id) && !linked.has(id)).map((id) => nameOf(row.orgId, id)) : [];
  const waiting =
    offer && offer.state !== "withdrawn" && offer.reach
      ? offer.to.flatMap((id) => {
          const r = offer.reach![id];
          return r?.state === "waiting" ? [{ name: nameOf(row.orgId, id), until: r.until }] : [];
        })
      : [];
  return {
    holder: row.holder === null ? (offer ? `${offer.to.length} invited` : null) : nameOf(row.orgId, row.holder),
    state: row.state,
    ...(offer ? { offer: { state: offer.state === "held" ? "held" : "open", invited: offer.to.length, ...(offer.holder ? { holder: nameOf(row.orgId, offer.holder) } : {}) } } : {}),
    ...(proposals.length ? { proposals } : {}),
    ...(row.wroteAt ? { written: true as const } : {}),
    ...(openedSessions(row.orgId).has(row.sessionId) ? { opened: true as const } : {}),
    ...(row.conflict ? { settle: { area: row.conflict.area } } : {}),
    ...(row.state === "needs-you" && last && last.to === OPERATOR
      ? { needsYou: { from: nameOf(row.orgId, last.from), question: last.question, since: Date.parse(last.at) || 0 } }
      : {}),
    ...(() => {
      const newest = Object.values(linkTimes(row)).sort().at(-1);
      return newest ? { linkAt: newest } : {};
    })(),
    // A person holds it through a hand-off nobody has a link for yet: the operator must send one.
    ...(row.state === "open" && last && row.holder !== null && row.holder !== OPERATOR && last.to === row.holder && liveLinks(row.sessionId, last.n).length === 0
      ? { sendLink: { to: nameOf(row.orgId, row.holder), question: last.question, since: Date.parse(last.at) || 0 } }
      : {}),
    // An open offer with invitees nobody has a link for (started in-process without links): the
    // operator sends them — named until each has one.
    ...(missing.length ? { sendLink: { to: missing.join(", "), question: offer!.question, since: Date.parse(last!.at) || 0 } } : {}),
    ...(waiting.length ? { waiting } : {}),
  };
}

export const workspaceHasFile = (dir: string, row: BatonSession): boolean => !!row.file && existsSync(join(dir, row.file));

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

/** Every baton session of one org's engine, as the host's read API gives them (the runtime's facts). */
export function batonSessionsOf(host: Pick<OrgHostApi, "sessions">): SessionInfo[] {
  return host.sessions("baton");
}
