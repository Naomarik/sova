import type { OwnerPageInfo } from "../shared/orgs";
import { type OperatorBy, OrgError, ownerOf, readIndex, readOrgOrPlaceholder, readRoster, setOrgOwner } from "./orgs";
import { tokenFor } from "./link-tokens";
import { findPersonLink, mintOwnerLink, noteOwnerLinkUse, ownerLinksOf, personLinkDead, personLinkState, recordAsk, revokePersonLinks, type PersonLinkRecord } from "./person-links";
import { linkUrl } from "./share/listener";
import { readVisits } from "./visits";
// Loaded with the owner link: its versions follow it (rotation, turning off, idle deadline).
import "./owner-versions";

/**
 * The org's owner and their link (§app.owner-page/owner, /link), for the operator's routes and the
 * share routes. The owner itself is the org statechart's (server/orgs.ts, `setOrgOwner`): a change, the
 * owner leaving and a detach turn the links off through its `revoke-owner-links` effect
 * (server/org-effects.ts); the links live in the host's person-links.json (server/person-links.ts).
 */

/** Set the owner (the operator's select). A change turns the previous owner's link off at once (the org statechart's effect). */
export async function setOwner(orgId: string, personId: unknown, by?: OperatorBy): Promise<void> {
  await setOrgOwner(orgId, personId, by);
}

/** A live owner link's URL when its token is kept (§app.owner-page/link). */
const keptUrl = (l: PersonLinkRecord, now: number): string | undefined => {
  if (personLinkState(l, now) !== "live") return undefined;
  const token = tokenFor(l.hash, "i");
  return token ? linkUrl("i", token) : undefined;
};

/** Get New Owner Link: a new link for the owner now; every older one stops working. With `keep`
    (Get Owner Link), the owner's live link instead when its token is kept; a new one only when none
    is live or the live one isn't kept. */
export function ownerLinkFor(orgId: string, opts: { keep?: boolean } = {}, now = Date.now()): { token: string; createdAt: string; expiresAt: string } {
  const owner = ownerOf(orgId);
  if (!owner) throw new OrgError("Pick an owner first.", 400);
  if (opts.keep) {
    const live = ownerLinksOf(orgId).filter((l) => l.personId === owner.id && personLinkState(l, now) === "live").at(-1);
    const token = live ? tokenFor(live.hash, "i") : null;
    if (live && token) return { token, createdAt: live.createdAt, expiresAt: live.expiresAt };
  }
  const { token, record } = mintOwnerLink(orgId, owner.id, now);
  return { token, createdAt: record.createdAt, expiresAt: record.expiresAt };
}

/** Turn Off Owner Link (and the org statechart's `revoke-owner-links` effect). Returns how many were live. */
export function revokeOwnerLinks(orgId: string, why: "off" | "detached" | "owner-changed" | "left" = "off"): number {
  return revokePersonLinks((l) => l.orgId === orgId, why);
}

export type OwnerAccess = { ok: true; link: PersonLinkRecord; orgId: string; ownerId: string } | { ok: false; status: 404 | 410; why?: "idle"; link?: PersonLinkRecord };

/**
 * What a presented `/i/` token opens. Checked on every request: a link whose person is no longer
 * the org's owner (or no longer active, or whose org isn't attached here) answers 410 even when it
 * was never turned off. Only turning off unused is ever named (`idle`), and only for the owner it
 * was made for.
 */
export function ownerAccess(token: string, now = Date.now()): OwnerAccess {
  const link = findPersonLink(token);
  if (!link) return { ok: false, status: 404 };
  if (link.revokedAt) return { ok: false, status: 410, link };
  if (!readIndex().orgs.some((o) => o.id === link.orgId)) return { ok: false, status: 410, link };
  let owner;
  try {
    owner = ownerOf(link.orgId);
  } catch {
    return { ok: false, status: 410, link };
  }
  if (!owner || owner.id !== link.personId) return { ok: false, status: 410, link };
  if (personLinkDead(link, now)) return { ok: false, status: 410, why: "idle", link };
  return { ok: true, link, orgId: link.orgId, ownerId: owner.id };
}

/** A use of a live owner link by a person (§app.owner-page/link): its 7 days start again. */
export function noteOwnerUse(access: Extract<OwnerAccess, { ok: true }>, now = Date.now()): void {
  noteOwnerLinkUse(access.link.hash, now);
}

/**
 * Ask for a new link (§app.owner-page/link): only a link that turned off unused, still naming the
 * org's owner, may ask; at most once a day (asking again sooner answers the same). 202 asked; 409
 * the link still works;
 * 410/404 as a read answers.
 */
export function askForNewLink(token: string, now = Date.now()): { status: 202 | 404 | 409 | 410; askedAt?: string } {
  const a = ownerAccess(token, now);
  if (a.ok) return { status: 409 };
  if (a.status === 404 || a.why !== "idle" || !a.link) return { status: a.status };
  // A newer link for this owner answers the ask already: it is the generic answer, as a replaced link's.
  const newer = ownerLinksOf(a.link.orgId).some((l) => l.gen > a.link!.gen);
  if (newer) return { status: 410 };
  const askedAt = recordAsk(a.link.hash, now);
  return askedAt ? { status: 202, askedAt } : { status: 410 };
}

/** Visits to the Owner page by a person (not a scanner), newest first. */
const ownerVisits = (orgId: string, personId: string) => readVisits(orgId, personId).filter((v) => v.via === "owner" && v.kind === "visit" && !v.bot);

const urlOf = (l: PersonLinkRecord, now: number): { url?: string } => {
  const url = keptUrl(l, now);
  return url ? { url } : {};
};

/** The owner card (OrgDetail.ownerPage). */
export function ownerPageInfo(orgId: string, now = Date.now()): OwnerPageInfo {
  const org = readOrgOrPlaceholder(orgId);
  const person = org.owner ? readRoster(orgId).find((p) => p.id === org.owner && p.status === "active") : undefined;
  if (!person) return { person: null, link: null, opened: 0 };
  const newest = ownerLinksOf(orgId)
    .filter((l) => l.personId === person.id)
    .at(-1);
  const opened = ownerVisits(orgId, person.id);
  return {
    person: { id: person.id, name: person.name },
    link: newest ? { state: personLinkState(newest, now), createdAt: newest.createdAt, expiresAt: newest.expiresAt, ...urlOf(newest, now), ...(newest.askedAt && !newest.revokedAt ? { askedAt: newest.askedAt } : {}) } : null,
    opened: opened.length,
    ...(opened[0] ? { lastOpenedAt: opened[0].at } : {}),
  };
}

/** Needs you: 1 while the owner, holding their newest link after it turned off unused, asked for a
    new one; a new link answers it. A link that turned off with nobody asking needs nothing. */
export function ownerLinkNeeds(orgId: string, now = Date.now()): number {
  const info = ownerPageInfo(orgId, now);
  return info.person && info.link?.state === "expired" && info.link.askedAt ? 1 : 0;
}

/** A person's owner links for their page, newest first, with visits counted per generation. */
export function ownerLinksOfPerson(orgId: string, personId: string, now = Date.now()) {
  const visits = readVisits(orgId, personId).filter((v) => v.via === "owner" && v.kind === "visit" && !v.bot);
  return ownerLinksOf(orgId)
    .filter((l) => l.personId === personId)
    .map((l) => {
      const mine = visits.filter((v) => v.gen === l.gen);
      return {
        createdAt: l.createdAt,
        expiresAt: l.expiresAt,
        ...(l.revokedAt ? { revokedAt: l.revokedAt } : {}),
        state: personLinkState(l, now),
        visits: mine.length,
        ...(mine[0] ? { lastVisitAt: mine[0].at } : {}),
        ...(keptUrl(l, now) ? { link: keptUrl(l, now)! } : {}),
      };
    })
    .reverse();
}
