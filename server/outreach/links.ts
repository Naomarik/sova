import { OPERATOR } from "../../shared/baton";
import { LINK_WARNINGS } from "../../shared/public-links";
import { handoffLine, type LinkKind, type LinkRef, type LinkRefusal, type OutreachLogLine } from "../../shared/outreach";
import { linksOfKey, mintLink, revokeLinks } from "../baton-links";
import { batonById, currentOffer, keptLinks, reachedBy } from "../baton";
import { operatorName, readProjects, readRoster } from "../orgs";
import { dropSiblingLinks, keepSiblingLink } from "../preview-kept";
import { listPreviews, mintSibling, revokePreview } from "../preview-links";
import { awaitShareLinks } from "../share/links-events";
import { linkUrl, shareState } from "../share/listener";
import { previewAddress, previewOrigin, zoneOf } from "../share/preview-address";

/**
 * Link references (§app.outreach/links): a send carries a reference, never a URL; the resolver of its
 * kind checks it for the person and makes the URL in the send's own step, so no token outlives it and
 * none reaches a model. The core knows only this interface: a new kind is a new entry in RESOLVERS.
 */

export interface LinkContext {
  orgId: string;
  projectId: string;
  personId: string;
}

/** A resolve that can't make its link: the send is refused with `code` (the log's) and the message. */
export class LinkRefused extends Error {
  constructor(
    readonly code: string,
    why: string,
  ) {
    super(why);
  }
}

export interface Resolved {
  url: string;
  /** The link's default line, when the send has no note. Fixed text, never model-written. */
  line?: string;
  /** Ids for the send log (no token, no URL). */
  log: Partial<Pick<OutreachLogLine, "sessionId" | "n" | "offerId" | "previewId">>;
  /** What was made in this step, to turn off again on a definite failure or after a restart (empty
      when it sent a kept link and made nothing). */
  minted: Record<string, string>;
}

export interface LinkResolver {
  kind: LinkKind;
  /** Why this link can't go to this person now (its code and one sentence), or null. */
  check(ctx: LinkContext, ref: LinkRef): LinkRefusal | null;
  /** The sessions a confirm card must list for it. */
  sessions(ref: LinkRef): string[];
  /** Throws LinkRefused when it can't make the link. `createdBy`: who sends it (`operator`, or an overseer's `session:<id>`). */
  resolve(ctx: LinkContext & { key: string; createdBy?: string }, ref: LinkRef): Promise<Resolved>;
  /** Turn off what `resolve` made. */
  revoke(minted: Record<string, string>): void;
  /** The send went: what it replaces stops (a hand-off's older links), never before. */
  settle?(minted: Record<string, string>): void;
}

/** The public address's own refusal: a link nobody outside can open is not sent. */
function addressRefusal(): LinkRefusal | null {
  const warn = shareState().warningCode;
  return warn === "off" || warn === "unreachable" || warn === "not-accepted" ? { code: `address-${warn}`, why: LINK_WARNINGS[warn] } : null;
}

const no = (code: string, why: string): LinkRefusal => ({ code, why });

const nameOf = (orgId: string, personId: string) => readRoster(orgId).find((p) => p.id === personId)?.name ?? "They";

// ---- a gathering's hand-off link ------------------------------------------------------------------

const handoff: LinkResolver = {
  kind: "handoff",
  sessions: (ref) => (ref.kind === "handoff" ? [ref.session] : []),
  check({ orgId, projectId, personId }, ref) {
    if (ref.kind !== "handoff") return no("link", "Not a gathering link.");
    const hit = batonById(ref.session);
    if (!hit || hit.row.orgId !== orgId) return no("session-unknown", "That gathering session isn't in this organization.");
    const row = hit.row;
    if (row.projectId !== projectId) return no("other-project", "That gathering session belongs to another project.");
    if (row.state === "done" || row.state === "closed") return no("session-ended", `That gathering session is ${row.state}.`);
    const name = nameOf(orgId, personId);
    const offer = currentOffer(row);
    if (offer) {
      if (!offer.to.includes(personId)) return no("not-invited", `${name} is not invited to its open offer.`);
      if (!reachedBy(offer, personId)) return no("not-reached", `${name} is not reached yet: their link is made when their working hours start.`);
    } else if (row.holder !== personId || row.holder === OPERATOR) return no("not-holder", `${name} does not hold the baton, so there is no link to send.`);
    return addressRefusal();
  },
  async resolve({ orgId, personId, key }, ref) {
    if (ref.kind !== "handoff") throw new LinkRefused("link", "Not a gathering link.");
    const row = batonById(ref.session)!.row;
    const offer = currentOffer(row);
    const n = offer ? offer.n : row.handoffs[row.handoffs.length - 1]!.n;
    // Their live link of this round when its token is kept, as Get Link gives it: the send makes
    // nothing, so neither a failure nor a success turns anything off (no linkKey).
    const kept = keptLinks(row)[personId];
    if (kept && kept.n === n)
      return {
        url: linkUrl("h", kept.token),
        line: handoffLine(operatorName(), row.publicTitle),
        log: { sessionId: row.sessionId, n, ...(offer ? { offerId: offer.id } : {}) },
        minted: {},
      };
    const { result: token } = await awaitShareLinks(() => mintLink({ orgId, sessionId: row.sessionId, n, personId, ...(offer ? { offerId: offer.id } : {}), key }));
    return {
      url: linkUrl("h", token),
      line: handoffLine(operatorName(), row.publicTitle),
      log: { sessionId: row.sessionId, n, ...(offer ? { offerId: offer.id } : {}) },
      minted: { linkKey: key, sessionId: row.sessionId, n: String(n), personId, ...(offer ? { offerId: offer.id } : {}) },
    };
  },
  revoke(minted) {
    if (minted.linkKey) revokeLinks((l) => l.key === minted.linkKey);
  },
  // As Get Link, once the new link went: the older links of that hand-off (or that invitee's, in the
  // offer) stop working. A failed send leaves them as they were.
  settle(m) {
    if (!m.linkKey || !m.sessionId) return;
    if (m.offerId) revokeLinks((l) => l.sessionId === m.sessionId && l.offerId === m.offerId && l.personId === m.personId && l.key !== m.linkKey);
    else revokeLinks((l) => l.sessionId === m.sessionId && l.n === Number(m.n) && l.key !== m.linkKey);
  },
};

// ---- a public preview link ------------------------------------------------------------------------


const preview: LinkResolver = {
  kind: "preview",
  sessions: () => [],
  check({ orgId, projectId }, ref) {
    if (ref.kind !== "preview") return no("link", "Not a preview link.");
    const p = listPreviews().find((v) => v.id === ref.preview);
    if (!p || !readProjects(orgId).some((x) => x.id === p.projectId)) return no("preview-unknown", "No such preview in this organization.");
    if (p.projectId !== projectId) return no("other-project", "That preview belongs to another project.");
    if (p.state !== "active") return p.state === "off" ? no("preview-off", "That preview is turned off.") : no("preview-expired", "That preview is expired.");
    const address = previewAddress();
    if (!address.url) return no("preview-address", address.message ?? "No preview address is set.");
    return addressRefusal();
  },
  // The host keeps only a preview's hash, so its URL exists only at a mint: the person gets their own
  // sibling of it (same port, its expiry, turned off with it), listed as "sent to {name}".
  async resolve({ personId, createdBy }, ref) {
    if (ref.kind !== "preview") throw new LinkRefused("link", "Not a preview link.");
    // One reading, before the mint: a routed host's address reads as unset for a moment while its gateway
    // states its kinds again after a comeback, which the mint's own wait for the gateway can land in.
    const address = previewAddress();
    const zone = address.url && zoneOf(address.url) ? address.url : null;
    if (!zone) throw new LinkRefused("preview-address", address.message ?? "No preview address is set.");
    let result: ReturnType<typeof mintSibling>;
    try {
      result = (await awaitShareLinks(() => mintSibling(ref.preview, personId, createdBy ?? "operator"))).result;
    } catch (err) {
      throw new LinkRefused("preview-off", err instanceof Error ? err.message : String(err));
    }
    const url = `${previewOrigin(zone, result.label)}/`;
    // Kept for the operator's Sent to line only (§mesh.public/preview): never in the log, a result or a model's context.
    try {
      keepSiblingLink(result.record.id, url);
    } catch (err) {
      console.warn(`[outreach] a person's preview link isn't kept (${err instanceof Error ? err.name : "error"}); it still goes`);
    }
    return { url, line: `${operatorName()} shared a preview with you.`, log: { previewId: result.record.id }, minted: { previewId: result.record.id } };
  },
  revoke(minted) {
    const id = minted.previewId;
    if (!id) return;
    revokePreview(id);
    try {
      dropSiblingLinks((k) => k !== id);
    } catch {
      // Turned off already: a kept link of an ended sibling is never listed, and the sweep drops it.
    }
  },
};

export const RESOLVERS: Record<LinkKind, LinkResolver> = { handoff, preview };

/** A reference as the tools and routes pass it, checked for shape only. */
export function parseLinkRef(v: unknown): LinkRef | null {
  if (!v || typeof v !== "object") return null;
  const r = v as Record<string, unknown>;
  if (r.kind === "handoff" && typeof r.session === "string" && r.session) return { kind: "handoff", session: r.session };
  if (r.kind === "preview" && typeof r.preview === "string" && /^pv_[\w-]{1,64}$/.test(r.preview)) return { kind: "preview", preview: r.preview };
  return null;
}

/** Whether a hand-off link was minted under this key (a step run again after a restart). */
export const mintedUnder = (key: string): boolean => linksOfKey(key).length > 0;
