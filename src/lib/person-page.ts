// One person's page (§app.organizations/person-page): the words its rows say, as pure functions so
// they run under tsx --test. The server derives every fact (relations, link states, visits); these
// only put them into words. Shapes are structural, so a row with more fields passes as is.

import type { LinkState, NamedRef, PersonRelation, PersonSessionRow, ProfileChange, VisitRow } from "../../shared/orgs";
import { agoTime, relativeTime } from "./format";
import { reachWords } from "./working-hours";

const OPERATOR = "operator";
/** A person's name, or "you" for the operator. */
const nameOf = (w: NamedRef): string => (w.id === OPERATOR ? "you" : w.name);
const others = (n: number): string => (n === 1 ? "1 other" : `${n} others`);
/** "Ana", "Ana and Ben", "Ana, Ben, and Cy" (serial comma). */
export const namesList = (ws: readonly NamedRef[]): string => {
  const names = ws.map(nameOf);
  if (names.length <= 2) return names.join(" and ");
  return `${names.slice(0, -1).join(", ")}, and ${names[names.length - 1]}`;
};

export function relationWords(r: PersonRelation): string {
  switch (r.kind) {
    case "started-with":
      return "Started with them";
    case "handed-to":
      return `Handed to them by ${nameOf(r.from)} · #${r.n}`;
    case "passed-on":
      return `Passed on to ${namesList(r.to)} · #${r.n}`;
    case "offered":
      return r.others > 0 ? `Offered to them with ${others(r.others)} · #${r.n}` : `Offered to them · #${r.n}`;
    case "took-offer":
      return `Took the offer · #${r.n}`;
    case "lease-lapsed":
      return `Their lease lapsed · #${r.n}`;
    case "referred-here":
      return `Referred here by ${nameOf(r.by)}`;
    case "proposed":
      return `Proposed ${nameOf(r.person)} here`;
    case "conflict":
      return `Asked to settle ${r.area}`;
    case "participant":
      return "Took part";
  }
}

/** Who has the session now, from the person's side; null once it is done or closed. */
export function holdLine(row: Pick<PersonSessionRow, "holdsNow" | "holder" | "state" | "offer">, now = Date.now()): string | null {
  if (row.state === "done" || row.state === "closed") return null;
  if (row.holdsNow) return "Holds it now";
  // r12: an invitee not reached yet has no link; say when their hours start (or that a lease pauses reaching).
  const o = row.offer;
  const waiting = o?.includesThem && o.reach?.state === "waiting" ? ` · not reached yet, ${reachWords(o.reach, o.holder ? nameOf(o.holder) : undefined, now)}` : "";
  if (o?.state === "open" && o.includesThem) return `${o.invited > 1 ? `Open to them and ${others(o.invited - 1)}` : "Open to them"}${waiting}`;
  if (waiting && row.holder) return `With ${nameOf(row.holder)}${waiting}`;
  if (row.holder) return `With ${nameOf(row.holder)}`;
  if (row.offer?.state === "open") return `Open to ${row.offer.invited} people`;
  return null;
}

/** "3 messages · last wrote 2h ago", "1 message", "0 messages". */
export function messagesLine(row: { messages: number; lastWroteAt?: string }, now = Date.now()): string {
  const count = row.messages === 1 ? "1 message" : `${row.messages} messages`;
  return row.lastWroteAt ? `${count} · last wrote ${relativeTime(row.lastWroteAt, now)}` : count;
}

export const LINK_STATE: Record<LinkState, { word: string; tone?: "success" | "info" | "warn" }> = {
  writes: { word: "Can write", tone: "success" },
  reads: { word: "Reads only", tone: "info" },
  off: { word: "Turned off" },
  expired: { word: "Expired" },
  closed: { word: "Session closed" },
};

/** An owner link's state (§app.owner-page/link): it opens the page, or it doesn't any more. */
export const OWNER_LINK_STATE: Record<"live" | "expired" | "off", { word: string; tone?: "success" | "info" | "warn" }> = {
  live: { word: "Can read", tone: "success" },
  off: { word: "Turned off" },
  expired: { word: "Expired" },
};

/** A link that still opens: Turn Off applies to it. */
export const linkLive = (state: LinkState): boolean => state === "writes" || state === "reads";

type VisitIn = Pick<VisitRow, "kind" | "at" | "lastSeenAt" | "device" | "publicTitle" | "bot" | "otherHost"> & Partial<Pick<VisitRow, "via">>;

/** "for about 12 min" from a visit's first and last sighting; nothing under a minute. */
export function visitDuration(v: { at: string; lastSeenAt?: string }): string | null {
  if (!v.lastSeenAt) return null;
  const ms = Date.parse(v.lastSeenAt) - Date.parse(v.at);
  if (!Number.isFinite(ms) || ms < 60_000) return null;
  const min = Math.round(ms / 60_000);
  if (min < 60) return `for about ${min} min`;
  const h = Math.round(min / 6) / 10;
  return `for about ${h % 1 === 0 ? h.toFixed(0) : h} h`;
}

/** The row's words, without the time (the time goes in its own `<time>`). Previews and scanners
    are muted rows: they are not the person opening their link. */
export function visitWords(v: VisitIn): { text: string; muted: boolean } {
  // An owner-page visit names the page, not a conversation (§app.owner-page/link).
  const what = v.via === "owner" ? "the owner page" : v.publicTitle;
  if (v.kind === "preview") return { text: `${!v.device || v.device === "Link preview" ? "Link preview" : `Link preview by ${v.device}`} · ${what}`, muted: true };
  if (v.kind === "refused") return { text: `Tried a turned-off link · ${what}`, muted: false };
  if (v.kind === "capped") return { text: "Too many visits on this link today; we stopped recording until tomorrow", muted: true };
  if (v.bot) return { text: `${v.device} · ${what}`, muted: true };
  const dur = visitDuration(v);
  const parts = [`Opened ${what}`, v.device, ...(dur ? [dur] : []), ...(v.otherHost ? ["link from another host"] : [])];
  return { text: parts.join(" · "), muted: false };
}

/** A real opening: a visit that is neither a preview nor a scanner. */
export const isOpening = (v: Pick<VisitIn, "kind" | "bot">): boolean => v.kind === "visit" && !v.bot;

/** The summary over the timeline: "Opened 4 times · last 2h ago", or the absence once a link was
    ever sent; null when there is nothing to say (no link, no visit). */
export function visitsSummary(p: { opened: number; lastOpenedAt?: string; linksEver: number }, now = Date.now()): string | null {
  if (p.opened === 0) return p.linksEver > 0 ? "Hasn't opened a link yet." : null;
  const n = p.opened === 1 ? "Opened once" : `Opened ${p.opened} times`;
  return p.lastOpenedAt ? `${n} · last ${relativeTime(p.lastOpenedAt, now)}` : n;
}

/** When they left: the newest status change to "left" in their history (newest first). */
export function leftAt(history: readonly Pick<ProfileChange, "field" | "to" | "at">[]): string | null {
  return history.find((c) => c.field === "status" && c.to === "left")?.at ?? null;
}

/** Rows shown before "Show All": the timeline collapses past this. */
export const VISITS_FOLDED = 20;

/** "2h ago", "yesterday", "3d ago", then "on Mar 4": a relative time that reads after a verb. */
export function sinceWords(at: string, now = Date.now()): string {
  const age = agoTime(at, now);
  return age || `on ${relativeTime(at, now)}`;
}

/** "Ana" from "Ana María López": the button and preview name a person by first name. */
export const firstName = (name: string): string => name.trim().split(/\s+/)[0] || name;

/** Relations that put a session in front of them (their link could open it): only then can the
    operator preview it as them. Referred-here, proposed and conflict alone do not. */
const ADDRESSED = new Set<PersonRelation["kind"]>(["started-with", "handed-to", "passed-on", "offered", "took-offer", "lease-lapsed", "participant"]);
export const canPreview = (row: Pick<PersonSessionRow, "relations" | "holdsNow">): boolean => row.holdsNow || row.relations.some((r) => ADDRESSED.has(r.kind));
