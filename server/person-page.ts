import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { BATON_LEASE_ENTRY, BATON_SENT_ENTRY, OPERATOR, POOL, type BatonSession } from "../shared/baton";
import type { DecisionRow } from "../shared/decisions";
import type { NamedRef, Person, PersonConflict, PersonPreview, PersonDecision, PersonLinkRow, PersonPage, PersonRelation, PersonSessionRow, VisitRow } from "../shared/orgs";
import { accessOf, allBatons, heldOffer, outsiderCut, sessionPathOf } from "./baton";
import { linkDead, linksOfPerson, type LinkRecord } from "./baton-links";
import { readConflicts, readDecisionStore } from "./decisions";
import { operatorName, orgDir, OrgError, readHistory, readOrg, readProjects, readRoster } from "./orgs";
import { listDecisions } from "./reconcile";
import { opaqueSenders, readView } from "./share/hub";
import { readVisits } from "./visits";
import { ownerLinksOfPerson } from "./owner";
import { ownerLinksOf } from "./person-links";

/**
 * A person's page (§app.organizations/person-page): everything the org knows about one roster
 * person, assembled by ONE function (personPage) that the person's inbox reuses later. Read-only
 * except for the decision index, which listDecisions syncs from the transcripts as the project page
 * does. Baton sessions only: coding sessions and operator sessions that merely mention them are not
 * theirs. Contact stays on the Person (this page and the People card are the only places it shows);
 * the project overseer never reads anything from here, visits included.
 */

// ---- what a transcript says about one person ------------------------------------------------------------

interface TranscriptFacts {
  /** Per person: messages sent, the newest one's time. */
  sent: Map<string, { n: number; last: string }>;
  /** Per person: offer hand-off numbers whose lease ran out on them. */
  lapsed: Map<string, number[]>;
}

const factCache = new Map<string, { size: number; mtimeMs: number; facts: TranscriptFacts }>();

/** Sent markers and lease events of a transcript, cached by size and mtime (our own line parser,
    never SessionManager.open). */
export function transcriptFacts(path: string): TranscriptFacts {
  const empty: TranscriptFacts = { sent: new Map(), lapsed: new Map() };
  let st;
  try {
    st = statSync(path);
  } catch {
    return empty;
  }
  const hit = factCache.get(path);
  if (hit && hit.size === st.size && hit.mtimeMs === st.mtimeMs) return hit.facts;
  let text = "";
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return empty;
  }
  const facts: TranscriptFacts = { sent: new Map(), lapsed: new Map() };
  for (const line of text.split("\n")) {
    if (!line.includes(BATON_SENT_ENTRY) && !line.includes(BATON_LEASE_ENTRY)) continue;
    let e: Record<string, any>;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    if (e?.type !== "custom" || typeof e.data !== "object" || e.data === null) continue;
    const by = e.data.by;
    if (typeof by !== "string") continue;
    if (e.customType === BATON_SENT_ENTRY) {
      const s = facts.sent.get(by) ?? { n: 0, last: "" };
      s.n++;
      if (typeof e.timestamp === "string" && e.timestamp > s.last) s.last = e.timestamp;
      facts.sent.set(by, s);
    } else if (e.customType === BATON_LEASE_ENTRY && e.data.event === "expired" && typeof e.data.n === "number") {
      facts.lapsed.set(by, [...(facts.lapsed.get(by) ?? []), e.data.n]);
    }
  }
  factCache.set(path, { size: st.size, mtimeMs: st.mtimeMs, facts });
  return facts;
}

// ---- sessions ---------------------------------------------------------------------------------------

interface Ctx {
  orgId: string;
  dir: string;
  roster: Person[];
  operator: string;
  projects: Map<string, string>;
  rows: BatonSession[];
}

function contextOf(orgId: string): Ctx {
  const dir = orgDir(orgId);
  return {
    orgId,
    dir,
    roster: readRoster(orgId),
    operator: operatorName(),
    projects: new Map(readProjects(orgId).map((p) => [p.id, p.name])),
    rows: allBatons().filter((r) => r.orgId === orgId),
  };
}

function ref(ctx: Ctx, id: string): NamedRef {
  if (id === OPERATOR) return { id, name: ctx.operator };
  if (id === POOL) return { id, name: "Invitees" };
  const p = ctx.roster.find((x) => x.id === id);
  // A referrer who isn't on the roster is a free-text name: no id.
  return p ? { id, name: p.name } : /^p_[a-z0-9]{8}$/.test(id) ? { id, name: "Someone" } : { id: "", name: id };
}

const pathOf = (ctx: Ctx, row: BatonSession): string | null => (existsSync(join(ctx.dir, row.file)) ? sessionPathOf(ctx.dir, row) : null);

function latest(times: (string | undefined)[]): string {
  let best = "";
  for (const t of times) if (t && t > best) best = t;
  return best;
}

/** How `pid` relates to one row, in the order things happened; [] when it isn't theirs. */
export function relationsIn(ctx: Ctx, row: BatonSession, pid: string, person: Person | undefined, conflicts: PersonConflict[], lapsed: number[]): PersonRelation[] {
  const out: PersonRelation[] = [];
  if (person?.referral?.sessionId === row.sessionId) out.push({ kind: "referred-here", by: ref(ctx, person.referral.referredBy) });
  for (const h of row.handoffs) {
    const offer = h.offerId ? row.offers?.find((o) => o.id === h.offerId) : undefined;
    if (h.to === pid) out.push(h.n === 1 ? { kind: "started-with" } : { kind: "handed-to", n: h.n, from: ref(ctx, h.from) });
    if (offer?.to.includes(pid)) {
      out.push({ kind: "offered", n: h.n, others: offer.to.length - 1 });
      if (heldOffer(row, offer.id, pid)) out.push({ kind: "took-offer", n: h.n });
      if (lapsed.includes(h.n)) out.push({ kind: "lease-lapsed", n: h.n });
    }
    if (h.from === pid) out.push({ kind: "passed-on", n: h.n, to: h.to === POOL && offer ? offer.to.map((id) => ref(ctx, id)) : [ref(ctx, h.to)] });
  }
  for (const p of ctx.roster)
    if (p.id !== pid && p.referral?.sessionId === row.sessionId && p.referral.referredBy === pid) out.push({ kind: "proposed", person: { id: p.id, name: p.name } });
  for (const c of conflicts) if (c.batonSessionId === row.sessionId) out.push({ kind: "conflict", conflictId: c.id, area: c.area });
  if (!out.length && (row.participants.includes(pid) || row.holder === pid)) out.push({ kind: "participant" });
  return out;
}

export function personSessions(ctx: Ctx, pid: string, conflicts: PersonConflict[]): PersonSessionRow[] {
  const person = ctx.roster.find((p) => p.id === pid);
  const titles = new Map(ctx.rows.map((r) => [r.sessionId, r.publicTitle]));
  const out: PersonSessionRow[] = [];
  for (const row of ctx.rows) {
    const path = pathOf(ctx, row);
    const facts = path ? transcriptFacts(path) : null;
    const relations = relationsIn(ctx, row, pid, person, conflicts, facts?.lapsed.get(pid) ?? []);
    const sent = facts?.sent.get(pid);
    if (!relations.length && !sent) continue;
    if (!relations.length) relations.push({ kind: "participant" });
    const offer = row.offerId ? row.offers?.find((o) => o.id === row.offerId) : undefined;
    const liveOffer = offer && offer.state !== "withdrawn" ? offer : undefined;
    out.push({
      sessionId: row.sessionId,
      path,
      publicTitle: row.publicTitle,
      projectId: row.projectId,
      projectName: ctx.projects.get(row.projectId) ?? "",
      state: row.state,
      holder: row.holder === null ? null : ref(ctx, row.holder),
      holdsNow: row.holder === pid,
      ...(liveOffer
        ? {
            offer: {
              state: liveOffer.state === "held" ? ("held" as const) : ("open" as const),
              invited: liveOffer.to.length,
              includesThem: liveOffer.to.includes(pid),
              ...(liveOffer.holder ? { holder: ref(ctx, liveOffer.holder) } : {}),
              ...(liveOffer.reach?.[pid] ? { reach: liveOffer.reach[pid] } : {}),
            },
          }
        : {}),
      relations,
      messages: sent?.n ?? 0,
      ...(sent?.last ? { lastWroteAt: sent.last } : {}),
      lastActivityAt: latest([row.createdAt, row.closedAt, sent?.last, ...row.handoffs.map((h) => h.at), ...(row.offers ?? []).map((o) => o.lastActivityAt)]),
      createdAt: row.createdAt,
      ...(row.parent ? { parent: { sessionId: row.parent, publicTitle: titles.get(row.parent) ?? "" } } : {}),
    });
  }
  return out.sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt));
}

// ---- decisions and conflicts ----------------------------------------------------------------------------

/** Every project's decisions, synced as the project page syncs them; a project whose index can't be
    synced (its root is gone) still shows what its store holds. */
function projectDecisions(orgId: string, projectId: string): DecisionRow[] {
  try {
    return listDecisions(orgId, projectId).decisions;
  } catch {
    return readDecisionStore(orgId, projectId).decisions;
  }
}

export function personDecisions(ctx: Ctx, pid: string): PersonDecision[] {
  const titles = new Map(ctx.rows.map((r) => [r.sessionId, r.publicTitle]));
  const out: PersonDecision[] = [];
  for (const [projectId, projectName] of ctx.projects)
    for (const d of projectDecisions(ctx.orgId, projectId)) {
      if (d.by !== pid) continue;
      out.push({
        id: d.id,
        projectId,
        projectName,
        area: d.area,
        areaKey: d.areaKey,
        statement: d.statement,
        quote: d.quote,
        at: d.at,
        sessionId: d.sessionId,
        publicTitle: titles.get(d.sessionId) ?? "",
        sessionPath: d.sessionPath,
        entryId: d.entryId,
        state: d.state,
        authorOwnsArea: d.authorOwnsArea,
      });
    }
  return out.sort((a, b) => b.at.localeCompare(a.at));
}

export function personConflicts(ctx: Ctx, pid: string): PersonConflict[] {
  const titles = new Map(ctx.rows.map((r) => [r.sessionId, r.publicTitle]));
  const out: PersonConflict[] = [];
  for (const [projectId, projectName] of ctx.projects) {
    const conflicts = readConflicts(ctx.orgId, projectId).filter((c) => c.routedTo === pid);
    if (!conflicts.length) continue;
    const decisions = new Map(readDecisionStore(ctx.orgId, projectId).decisions.map((d) => [d.id, d]));
    for (const c of conflicts) {
      const title = c.batonSessionId ? titles.get(c.batonSessionId) : undefined;
      out.push({
        id: c.id,
        projectId,
        projectName,
        areaKey: c.areaKey,
        area: decisions.get(c.a)?.area ?? c.areaKey,
        state: c.state,
        routeReason: c.routeReason,
        ...(c.batonSessionId ? { batonSessionId: c.batonSessionId } : {}),
        ...(c.batonPath ? { batonPath: c.batonPath } : {}),
        ...(title ? { publicTitle: title } : {}),
        createdAt: c.createdAt,
        ...(c.resolvedAt ? { resolvedAt: c.resolvedAt } : {}),
      });
    }
  }
  return out.sort((a, b) => (a.state === b.state ? b.createdAt.localeCompare(a.createdAt) : a.state === "open" ? -1 : 1));
}

// ---- links and visits -----------------------------------------------------------------------------------

const sameLink = (l: Pick<LinkRecord, "sessionId" | "n" | "offerId">, v: { sessionId: string; n: number; offerId?: string }) =>
  l.sessionId === v.sessionId && l.n === v.n && (l.offerId ?? "") === (v.offerId ?? "");

/**
 * The link of this host a visit was made with: the newest of its hand-off's links (one person's)
 * made at or before the visit. None: a link minted on another host (a restore, a move). So a new
 * link for the same hand-off never takes an older visit.
 */
function linkOfVisit<L extends Pick<LinkRecord, "sessionId" | "n" | "offerId" | "createdAt">>(links: readonly L[], v: { sessionId: string; n: number; offerId?: string; at: string }): L | undefined {
  let best: L | undefined;
  for (const l of links) if (sameLink(l, v) && l.createdAt <= v.at && (!best || l.createdAt >= best.createdAt)) best = l;
  return best;
}

/** The state word of a link on this host, from its session's row (no token needed). */
export function linkState(link: LinkRecord, row: BatonSession | undefined, now = Date.now()): { state: PersonLinkRow["state"]; reason?: string } {
  // Closing a session turns its links off too: the reason that matters is the close.
  if (!row || row.state === "closed") return { state: "closed" };
  if (link.revokedAt) return { state: "off" };
  if (linkDead(link, now)) return { state: "expired" };
  const a = accessOf(link, row, now);
  if (!a.ok) return { state: "off" };
  return a.canWrite ? { state: "writes" } : { state: "reads", ...(a.reason ? { reason: a.reason } : {}) };
}

export function personLinks(ctx: Ctx, pid: string, visits: (VisitRow & { offerId?: string })[], now = Date.now()): PersonLinkRow[] {
  const rows = new Map(ctx.rows.map((r) => [r.sessionId, r]));
  const all = linksOfPerson(ctx.orgId, pid);
  return all
    .map((l): PersonLinkRow => {
      const row = rows.get(l.sessionId);
      const mine = visits.filter((v) => v.kind === "visit" && !v.bot && linkOfVisit(all, v) === l);
      const current = !!row && row.handoffs[row.handoffs.length - 1]?.n === l.n && !linkDead(l, now);
      return {
        sessionId: l.sessionId,
        publicTitle: row?.publicTitle ?? "",
        n: l.n,
        ...(l.offerId ? { offerId: l.offerId } : {}),
        createdAt: l.createdAt,
        expiresAt: l.expiresAt,
        ...(l.revokedAt ? { revokedAt: l.revokedAt } : {}),
        ...linkState(l, row, now),
        current,
        visits: mine.length,
        ...(mine[0] ? { lastVisitAt: mine[0].at } : {}),
      };
    })
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** Their visit log for the page: session titles, and whether its link was minted on another host. */
export function personVisits(ctx: Ctx, pid: string): (VisitRow & { offerId?: string })[] {
  const titles = new Map(ctx.rows.map((r) => [r.sessionId, r.publicTitle]));
  const links = linksOfPerson(ctx.orgId, pid);
  const ownerGens = new Set(ownerLinksOf(ctx.orgId).filter((l) => l.personId === pid).map((l) => l.gen));
  return readVisits(ctx.orgId, pid).map((v) => ({
    id: v.id,
    kind: v.kind,
    at: v.at,
    ...(v.lastSeenAt ? { lastSeenAt: v.lastSeenAt } : {}),
    ...(v.via === "owner" ? { via: "owner" as const } : {}),
    sessionId: v.sessionId,
    publicTitle: titles.get(v.sessionId) ?? "",
    n: v.n,
    ...(v.offerId ? { offerId: v.offerId } : {}),
    device: v.device,
    ...(v.bot ? { bot: true } : {}),
    ...((v.via === "owner" ? v.gen !== undefined && ownerGens.has(v.gen) : linkOfVisit(links, v)) ? {} : { otherHost: true }),
  }));
}

// ---- the page ------------------------------------------------------------------------------------------

/** GET /api/orgs/:id/people/:pid: the whole page. 404 for an unknown org or person. */
export function personPage(orgId: string, pid: string, now = Date.now()): PersonPage {
  const ctx = contextOf(orgId);
  const person = ctx.roster.find((p) => p.id === pid);
  if (!person) throw new OrgError("Unknown person", 404);
  const conflicts = personConflicts(ctx, pid);
  const visitsFull = personVisits(ctx, pid);
  const links = personLinks(ctx, pid, visitsFull, now);
  const visits: VisitRow[] = visitsFull.map(({ offerId: _o, ...v }) => v);
  const opened = visits.filter((v) => v.kind === "visit" && !v.bot);
  return {
    person,
    org: { id: orgId, name: readOrg(orgId).name },
    operatorName: ctx.operator,
    sessions: personSessions(ctx, pid, conflicts),
    decisions: personDecisions(ctx, pid),
    conflicts,
    links,
    visits,
    opened: opened.length,
    ...(opened[0] ? { lastOpenedAt: opened[0].at } : {}),
    history: readHistory(orgId, pid).reverse(),
    stakeholderOf: readProjects(orgId)
      .filter((p) => p.stakeholder === pid)
      .map((p) => ({ projectId: p.id, name: p.name })),
    owner: readOrg(orgId).owner === pid && person.status === "active",
    ownerLinks: ownerLinksOfPerson(orgId, pid, now),
  };
}

/**
 * Preview as {name}: a session as their link shows it, read-only, with no token (§app.organizations/
 * person-page). An invitee who never held an offer sees the conversation only up to it, as their
 * link would. 404 when the session isn't one of theirs.
 */
export async function previewAs(orgId: string, pid: string, sessionId: string, now = Date.now()): Promise<PersonPreview> {
  const ctx = contextOf(orgId);
  const person = ctx.roster.find((p) => p.id === pid);
  if (!person) throw new OrgError("Unknown person", 404);
  const row = ctx.rows.find((r) => r.sessionId === sessionId);
  if (!row) throw new OrgError("Unknown baton session", 404);
  const offered = (row.offers ?? []).filter((o) => o.to.includes(pid));
  const addressed = row.participants.includes(pid) || row.holder === pid || row.handoffs.some((h) => h.to === pid) || offered.length > 0;
  if (!addressed) throw new OrgError(`${person.name} has no link to this session.`, 404);
  // As their links show it: the newest offer to them they never held cuts the view at that offer,
  // unless they held the baton some other way after it.
  const view = await readView(row, ctx.dir, pid, outsiderCut(row, pid));
  const canWrite = row.holder === pid && (row.state === "open" || row.state === "needs-you");
  const linkOpens = person.status !== "left" && linksOfPerson(orgId, pid).some((l) => l.sessionId === sessionId && accessOf(l, row, now).ok);
  return {
    ...view,
    items: opaqueSenders(view.items, pid),
    // A preview writes nothing, whatever their link could do.
    viewer: { name: person.name, canWrite: false, ...(canWrite ? {} : { reason: row.state === "done" ? "done" : "moved-on" }) },
    linkOpens,
  };
}
