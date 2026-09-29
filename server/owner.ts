import type { OwnerPageInfo } from "../shared/orgs";
import { type OperatorBy, OrgError, ownerOf, readIndex, readOrg, readRoster, setOrgOwner } from "./orgs";
import { findPersonLink, mintOwnerLink, ownerLinksOf, personLinkDead, personLinkState, revokePersonLinks, type PersonLinkRecord } from "./person-links";
import { readVisits } from "./visits";

/**
 * The org's owner and their link (§app.owner-page/owner, /link), for the operator's routes and the
 * share routes. The owner itself is the org chart's (server/orgs.ts, `setOrgOwner`): a change, the
 * owner leaving and a detach turn the links off through its `revoke-owner-links` effect
 * (server/org-effects.ts); the links live in the host's person-links.json (server/person-links.ts).
 */

/** When the owner link's remaining life counts as "send a new one" (Needs you). */
export const OWNER_LINK_SOON_MS = 7 * 86_400_000;

/** Set the owner (the operator's select). A change turns the previous owner's link off at once (the org chart's effect). */
export async function setOwner(orgId: string, personId: unknown, by?: OperatorBy): Promise<void> {
  await setOrgOwner(orgId, personId, by);
}

/** Get Owner Link: a new link for the owner now; every older one stops working. */
export function mintOwnerLinkFor(orgId: string, now = Date.now()): PersonLinkRecord & { token: string } {
  const owner = ownerOf(orgId);
  if (!owner) throw new OrgError("Pick an owner first.", 400);
  const { token, record } = mintOwnerLink(orgId, owner.id, now);
  return { ...record, token };
}

/** Turn Off Owner Link (and the org chart's `revoke-owner-links` effect). Returns how many were live. */
export function revokeOwnerLinks(orgId: string, why: "off" | "detached" | "owner-changed" | "left" = "off"): number {
  return revokePersonLinks((l) => l.orgId === orgId, why);
}

export type OwnerAccess = { ok: true; link: PersonLinkRecord; orgId: string; ownerId: string } | { ok: false; status: 404 | 410; why?: "expired"; link?: PersonLinkRecord };

/**
 * What a presented `/i/` token opens. Checked on every request: a link whose person is no longer
 * the org's owner (or no longer active, or whose org isn't attached here) answers 410 even when it
 * was never turned off. Only an expiry is ever named.
 */
export function ownerAccess(token: string, now = Date.now()): OwnerAccess {
  const link = findPersonLink(token);
  if (!link) return { ok: false, status: 404 };
  if (link.revokedAt) return { ok: false, status: 410, link };
  if (personLinkDead(link, now)) return { ok: false, status: 410, why: "expired", link };
  if (!readIndex().orgs.some((o) => o.id === link.orgId)) return { ok: false, status: 410, link };
  let owner;
  try {
    owner = ownerOf(link.orgId);
  } catch {
    return { ok: false, status: 410, link };
  }
  if (!owner || owner.id !== link.personId) return { ok: false, status: 410, link };
  return { ok: true, link, orgId: link.orgId, ownerId: owner.id };
}

/** Visits to the Owner page by a person (not a scanner), newest first. */
const ownerVisits = (orgId: string, personId: string) => readVisits(orgId, personId).filter((v) => v.via === "owner" && v.kind === "visit" && !v.bot);

/** The owner card (OrgDetail.ownerPage). */
export function ownerPageInfo(orgId: string, now = Date.now()): OwnerPageInfo {
  const org = readOrg(orgId);
  const person = org.owner ? readRoster(orgId).find((p) => p.id === org.owner && p.status === "active") : undefined;
  if (!person) return { person: null, link: null, opened: 0 };
  const newest = ownerLinksOf(orgId)
    .filter((l) => l.personId === person.id)
    .at(-1);
  const opened = ownerVisits(orgId, person.id);
  return {
    person: { id: person.id, name: person.name },
    link: newest ? { state: personLinkState(newest, now), createdAt: newest.createdAt, expiresAt: newest.expiresAt } : null,
    opened: opened.length,
    ...(opened[0] ? { lastOpenedAt: opened[0].at } : {}),
  };
}

/** Needs you: 1 when the owner's newest link expired or has under a week left (none minted yet: 0). */
export function ownerLinkNeeds(orgId: string, now = Date.now()): number {
  const info = ownerPageInfo(orgId, now);
  if (!info.person || !info.link || info.link.state === "off") return 0;
  return info.link.state === "expired" || Date.parse(info.link.expiresAt) - now < OWNER_LINK_SOON_MS ? 1 : 0;
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
      };
    })
    .reverse();
}
