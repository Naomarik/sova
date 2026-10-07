import type { OrgLinkRow, SessionShare, SessionShareVisit, SharesOverview } from "../shared/session-share";
import { listPreviews } from "./preview-links";
import { readIdentity, withIdentity, type IdentityLine } from "./visitor-identity";
import { allBatons, namesOf } from "./baton";
import { linkDead, linksOfOrg } from "./baton-links";
import { readIndex, readOrg } from "./orgs";
import { tokenFor } from "./link-tokens";
import { ownerLinksOf, personLinkDead } from "./person-links";
import { linkUrl } from "./share/listener";
import { watchedHashes } from "./share/hub";
import { readPreviewVisits, readSessionVisits, readVisits, visitSummary, type FoldedVisit } from "./visits";

/**
 * The data behind the Shares page (§app.session-share/overview): every live public link this
 * host serves. Session shares come from their store (the caller passes them); org links — every
 * live hand-off (/h/) and owner (/i/) link — are READ from the existing stores and each org's visit
 * log (§app.baton/visits), never changed here. A peer's links are its own answer: the page fans out.
 * Each visit carries what the host's identity side file holds for it (§mesh.public/visitor-log),
 * and this answer is the only one that does: never the preview list or the overseer's tools.
 */

const foldedVisit = (v: FoldedVisit): SessionShareVisit => ({
  id: v.id,
  kind: v.kind,
  at: v.at,
  ...(v.lastSeenAt ? { lastSeenAt: v.lastSeenAt } : {}),
  device: v.device,
  ...(v.bot ? { bot: true as const } : {}),
});

/** A live link's URL when its token is kept (§app.session-share/link). */
const keptLink = (kind: "h" | "i", hash: string): { link?: string } => {
  const token = tokenFor(hash, kind);
  return token ? { link: linkUrl(kind, token) } : {};
};

/** Every live hand-off and owner link of every attached org, newest first. An org whose workspace
    can't be read is skipped (it serves nothing either). */
export function orgLinkRows(now = Date.now(), identity: Map<string, IdentityLine[]> = readIdentity()): OrgLinkRow[] {
  const rows: OrgLinkRow[] = [];
  const shareVisit = (v: FoldedVisit) => withIdentity(foldedVisit(v), identity);
  const watched = watchedHashes();
  const batons = new Map<string, { publicTitle: string; state: string }>();
  try {
    for (const b of allBatons()) batons.set(b.sessionId, { publicTitle: b.publicTitle, state: b.state });
  } catch {
    // no baton rows readable: hand-off rows go without a title
  }
  for (const o of readIndex().orgs) {
    let orgName: string;
    let names: Record<string, string>;
    try {
      orgName = readOrg(o.id).name;
      names = namesOf(o.id);
    } catch {
      continue;
    }
    const byPerson = new Map<string, FoldedVisit[]>();
    const visitsOf = (personId: string): FoldedVisit[] => {
      let v = byPerson.get(personId);
      if (!v) {
        try {
          v = readVisits(o.id, personId);
        } catch {
          v = [];
        }
        byPerson.set(personId, v);
      }
      return v;
    };
    const person = (personId: string) => ({ personId, personName: names[personId] ?? "Someone" });
    for (const l of linksOfOrg(o.id)) {
      if (linkDead(l, now)) continue;
      const visits = visitsOf(l.personId)
        .filter((v) => v.via === undefined && v.sessionId === l.sessionId && v.n === l.n && v.offerId === l.offerId)
        .map(shareVisit);
      const baton = batons.get(l.sessionId);
      // A hand-off page sends no visibility: an open socket is `viewing`.
      rows.push({
        kind: "handoff",
        orgId: o.id,
        orgName,
        ...person(l.personId),
        sessionId: l.sessionId,
        ...(baton ? { sessionTitle: baton.publicTitle } : {}),
        n: l.n,
        state: baton?.state ?? "open",
        ...(watched.has(l.hash) ? { presence: "viewing" as const } : {}),
        createdAt: l.createdAt,
        expiresAt: l.expiresAt,
        ...visitSummary(visits),
        visits,
        ...keptLink("h", l.hash),
      });
    }
    for (const l of ownerLinksOf(o.id)) {
      if (personLinkDead(l, now)) continue;
      const visits = visitsOf(l.personId)
        .filter((v) => v.via === "owner" && v.gen === l.gen)
        .map(shareVisit);
      rows.push({ kind: "owner", orgId: o.id, orgName, ...person(l.personId), state: "live", createdAt: l.createdAt, expiresAt: l.expiresAt, ...visitSummary(visits), visits, ...keptLink("i", l.hash) });
    }
  }
  return rows.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** GET /api/shares-overview: this host's session shares (from the store, with their recipients'
    presence and visits already folded in) and its live org links. */
export async function sharesOverview(sessionShares: SessionShare[], now = Date.now()): Promise<SharesOverview> {
  const identity = readIdentity();
  const shares = sessionShares.map((s) => ({ ...s, recipients: s.recipients.map((r) => ({ ...r, visits: readSessionVisits(s.id, r.id).map((v) => withIdentity(v, identity)) })) }));
  const previewVisits: Record<string, SessionShareVisit[]> = {};
  for (const p of listPreviews({}, now)) {
    if (p.state !== "active") continue;
    const visits = readPreviewVisits(p.id).map((v) => withIdentity(v, identity));
    if (visits.length) previewVisits[p.id] = visits;
  }
  return { sessionShares: shares, orgLinks: orgLinkRows(now, identity), previewVisits };
}
