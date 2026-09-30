import { OPERATOR } from "../../shared/baton";
import { LINK_WARNINGS } from "../../shared/public-links";
import { handoffLine, type LinkKind, type LinkRef, type OutreachLogLine } from "../../shared/outreach";
import { linksOfKey, mintLink, revokeLinks } from "../baton-links";
import { batonById, currentOffer, reachedBy } from "../baton";
import { operatorName, readRoster } from "../orgs";
import { listPreviews, mintSibling, revokePreview } from "../preview-links";
import { awaitShareLinks } from "../share/links-events";
import { linkUrl, shareState } from "../share/listener";
import { previewAddress, previewOrigin } from "../share/preview-address";

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

export interface Resolved {
  url: string;
  /** The link's default line, when the send has no note. Fixed text, never model-written. */
  line?: string;
  /** Ids for the send log (no token, no URL). */
  log: Partial<Pick<OutreachLogLine, "sessionId" | "n" | "offerId" | "previewId">>;
  /** What was made in this step, to turn off again on a definite failure or after a restart. */
  minted: Record<string, string>;
}

export interface LinkResolver {
  kind: LinkKind;
  /** Why this link can't go to this person now (one sentence), or null. */
  check(ctx: LinkContext, ref: LinkRef): string | null;
  /** The sessions a confirm card must list for it. */
  sessions(ref: LinkRef): string[];
  resolve(ctx: LinkContext & { key: string }, ref: LinkRef): Promise<Resolved>;
  /** Turn off what `resolve` made. */
  revoke(minted: Record<string, string>): void;
}

/** The public address's own refusal: a link nobody outside can open is not sent. */
function addressRefusal(): string | null {
  const warn = shareState().warningCode;
  return warn === "off" || warn === "unreachable" || warn === "not-accepted" ? LINK_WARNINGS[warn] : null;
}

const nameOf = (orgId: string, personId: string) => readRoster(orgId).find((p) => p.id === personId)?.name ?? "They";

// ---- a gathering's hand-off link ------------------------------------------------------------------

const handoff: LinkResolver = {
  kind: "handoff",
  sessions: (ref) => (ref.kind === "handoff" ? [ref.session] : []),
  check({ orgId, projectId, personId }, ref) {
    if (ref.kind !== "handoff") return "Not a gathering link.";
    const hit = batonById(ref.session);
    if (!hit || hit.row.orgId !== orgId) return "That gathering session isn't in this organization.";
    const row = hit.row;
    if (row.projectId !== projectId) return "That gathering session belongs to another project.";
    if (row.state === "done" || row.state === "closed") return `That gathering session is ${row.state}.`;
    const name = nameOf(orgId, personId);
    const offer = currentOffer(row);
    if (offer) {
      if (!offer.to.includes(personId)) return `${name} is not invited to its open offer.`;
      if (!reachedBy(offer, personId)) return `${name} is not reached yet: their link is made when their working hours start.`;
    } else if (row.holder !== personId || row.holder === OPERATOR) return `${name} does not hold the baton, so there is no link to send.`;
    return addressRefusal();
  },
  async resolve({ orgId, personId, key }, ref) {
    if (ref.kind !== "handoff") throw new Error("Not a gathering link.");
    const row = batonById(ref.session)!.row;
    const offer = currentOffer(row);
    const n = offer ? offer.n : row.handoffs[row.handoffs.length - 1]!.n;
    // As Get Link: the older links of that hand-off (or that invitee's, in the offer) stop working.
    if (offer) revokeLinks((l) => l.sessionId === row.sessionId && l.offerId === offer.id && l.personId === personId);
    else revokeLinks((l) => l.sessionId === row.sessionId && l.n === n);
    const { result: token } = await awaitShareLinks(() => mintLink({ orgId, sessionId: row.sessionId, n, personId, ...(offer ? { offerId: offer.id } : {}), key }));
    return {
      url: linkUrl("h", token),
      line: handoffLine(operatorName(), row.publicTitle),
      log: { sessionId: row.sessionId, n, ...(offer ? { offerId: offer.id } : {}) },
      minted: { linkKey: key },
    };
  },
  revoke(minted) {
    if (minted.linkKey) revokeLinks((l) => l.key === minted.linkKey);
  },
};

// ---- a public preview link ------------------------------------------------------------------------


const preview: LinkResolver = {
  kind: "preview",
  sessions: () => [],
  check({ orgId, projectId }, ref) {
    if (ref.kind !== "preview") return "Not a preview link.";
    const p = listPreviews({ orgId }).find((v) => v.id === ref.preview);
    if (!p) return "No such preview in this organization.";
    if (p.projectId !== projectId) return "That preview belongs to another project.";
    if (p.state !== "active") return `That preview is ${p.state === "off" ? "turned off" : "expired"}.`;
    const address = previewAddress();
    if (!address.url) return address.message ?? "No preview address is set.";
    return addressRefusal();
  },
  // The host keeps only a preview's hash, so its URL exists only at a mint: the person gets their own
  // sibling of it (same port, its expiry, turned off with it), listed as "sent to {name}".
  async resolve({ personId }, ref) {
    if (ref.kind !== "preview") throw new Error("Not a preview link.");
    const { result } = await awaitShareLinks(() => mintSibling(ref.preview, personId));
    const origin = previewOrigin(previewAddress().url!, result.label);
    if (!origin) {
      revokePreview(result.record.id);
      throw new Error("The preview address can't make this link.");
    }
    return { url: `${origin}/`, line: `${operatorName()} shared a preview with you.`, log: { previewId: result.record.id }, minted: { previewId: result.record.id } };
  },
  revoke(minted) {
    if (minted.previewId) revokePreview(minted.previewId);
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
