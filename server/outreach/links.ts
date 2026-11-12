import { OPERATOR } from "../../shared/baton";
import { LINK_WARNINGS, SHARING_OFF_ERROR, SHARING_OFF_MESSAGE, type LinkWarningCode } from "../../shared/public-links";
import { handoffLine, ownerLine, type LinkKind, type LinkRef, type LinkRefusal, type OutreachLogLine } from "../../shared/outreach";
import { linksOfKey, mintLink, revokeLinks } from "../baton-links";
import { batonById, currentOffer, keptLinks, reachedBy } from "../baton";
import { operatorName, ownerOf, readIndex, readOrgOrPlaceholder, readProjects, readRoster } from "../orgs";
import { markOwnerLinkDelivered } from "../person-links";
import { dropSiblingLinks, keepSiblingKey, keepSiblingLink } from "../preview-kept";
import { listPreviews, mintSibling, PreviewRefused, revokePreview } from "../preview-links";
import { awaitShareLinks } from "../share/links-events";
import { linkUrl, shareState } from "../share/listener";
import { previewAddress } from "../share/preview-address";
import { previewHome, previewLinkOf, previewRefusal, type PreviewHome } from "../share/preview-link";
import { isSharingOffError, sharingOff } from "../share/sharing-off";
import { readyShareAddress } from "../share/tunnel/wiring";

/**
 * Link references (§app.outreach/links): a send carries a reference, never a URL; the resolver of its
 * kind checks it for the person and makes the URL in the send's own step, so no token outlives it and
 * none reaches a model. The core knows only this interface: a new kind is a new entry in RESOLVERS.
 */

export interface LinkContext {
  orgId: string;
  /** Absent on an organization's own send (an owner page link): a project's kinds refuse then. */
  projectId?: string;
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
  /** The public address's note for whoever sent it (Cloudflare Free: the address changes when this
      computer restarts), never a refusal. */
  warning?: string;
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

/** The address warnings that mean nobody outside can open the link, and their send log codes. */
const REFUSING: Partial<Record<LinkWarningCode, string>> = {
  off: "address-off",
  unreachable: "address-unreachable",
  "not-accepted": "address-not-accepted",
  broken: "address-broken",
  "quick-turn-on": "address-turn-on",
  "quick-setup": "address-setup",
  "tunnel-down": "address-down",
};

/** The public address's own refusal: a link nobody outside can open is not sent, nor any while sharing
    is off (§mesh.public/sharing-off). A Free tunnel still starting isn't refused here: the send's own
    step starts it and waits (addressAfterWait). */
function addressRefusal(): LinkRefusal | null {
  if (sharingOff()) return { code: SHARING_OFF_ERROR, why: SHARING_OFF_MESSAGE };
  const s = shareState();
  const code = s.warningCode ? REFUSING[s.warningCode] : undefined;
  return code ? { code, why: s.warning ?? LINK_WARNINGS[s.warningCode!] } : null;
}

/** After the send's step made or took its link and waited for the address: still no public address
    (a Free tunnel that didn't come up in time included) is a refusal. */
function addressAfterWait(): LinkRefusal | null {
  const s = shareState();
  if (s.warningCode === "quick-starting") return { code: "address-starting", why: s.warning ?? LINK_WARNINGS["quick-starting"] };
  return addressRefusal();
}

/** Free's note for the sender, while the link goes at a Free tunnel's address. */
const quickNote = (): { warning?: string } => (shareState().warningCode === "quick" ? { warning: LINK_WARNINGS.quick } : {});

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
    // nothing, so neither a failure nor a success turns anything off (no linkKey). A link another send
    // still in flight made is never it: that send's failure would turn it off.
    const kept = keptLinks(row, Date.now(), { reuse: true })[personId];
    if (kept && kept.n === n) {
      // Nothing is minted: the address is made ready here instead (a Free tunnel stopped since).
      await readyShareAddress();
      const late = addressAfterWait();
      if (late) throw new LinkRefused(late.code, late.why);
      return {
        url: linkUrl("h", kept.token),
        line: handoffLine(operatorName(), row.publicTitle),
        ...quickNote(),
        log: { sessionId: row.sessionId, n, ...(offer ? { offerId: offer.id } : {}) },
        minted: {},
      };
    }
    const { result: token } = await awaitShareLinks(() => mintLink({ orgId, sessionId: row.sessionId, n, personId, ...(offer ? { offerId: offer.id } : {}), key }));
    const late = addressAfterWait();
    if (late) {
      // Never sent: what this step made stops again.
      revokeLinks((l) => l.key === key);
      throw new LinkRefused(late.code, late.why);
    }
    return {
      url: linkUrl("h", token),
      ...quickNote(),
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

/** A preview home's refusal as the send log's code (§app.outreach/links): never a URL or a number. */
function previewHomeRefusal(err: PreviewRefused): LinkRefusal {
  const code =
    err.code === "too-many-tunnels" ? "too-many-tunnels"
    : err.code === "quick-turn-on" ? "address-turn-on"
    : err.code === "quick-setup" ? "address-setup"
    : err.code === "tunnel-down" ? "address-down"
    : "preview-address";
  return { code, why: err.message };
}


const preview: LinkResolver = {
  kind: "preview",
  sessions: () => [],
  check({ orgId, projectId }, ref) {
    if (ref.kind !== "preview") return no("link", "Not a preview link.");
    const p = listPreviews().find((v) => v.id === ref.preview);
    if (!p || !readProjects(orgId).some((x) => x.id === p.projectId)) return no("preview-unknown", "No such preview in this organization.");
    if (p.projectId !== projectId) return no("other-project", "That preview belongs to another project.");
    if (p.state !== "active") return p.state === "off" ? no("preview-off", "That preview is turned off.") : no("preview-expired", "That preview is expired.");
    if (sharingOff()) return { code: SHARING_OFF_ERROR, why: SHARING_OFF_MESSAGE };
    const refused = previewRefusal(p.port);
    if (refused) return previewHomeRefusal(refused);
    // Under Cloudflare Free a preview rides its app's own tunnel, never the share tunnel: the share address's
    // state says nothing about it (previewRefusal judged Turn On, the switch and the cap).
    return previewAddress().mode === "tunnel" ? null : addressRefusal();
  },
  // The host keeps only a preview's hash, so its URL exists only at a mint: the person gets their own
  // sibling of it (same port, its expiry, turned off with it), listed as "sent to {name}".
  async resolve({ personId, createdBy }, ref) {
    if (ref.kind !== "preview") throw new LinkRefused("link", "Not a preview link.");
    // One reading, before the mint: a routed host's address reads as unset for a moment while its gateway
    // states its kinds again after a comeback, which the mint's own wait for the gateway can land in. Under
    // Cloudflare Free it is the app's own tunnel, started now if it isn't running (§mesh.public/preview-tunnels).
    const port = listPreviews().find((v) => v.id === ref.preview)?.port;
    if (port === undefined) throw new LinkRefused("preview-unknown", "No such preview in this organization.");
    let home: PreviewHome;
    try {
      home = await previewHome(port, createdBy ?? "operator");
    } catch (err) {
      if (err instanceof PreviewRefused) {
        const r = previewHomeRefusal(err);
        throw new LinkRefused(r.code, r.why);
      }
      if (isSharingOffError(err)) throw new LinkRefused("sharing-off", err.message);
      throw err;
    }
    let result: ReturnType<typeof mintSibling>;
    try {
      result = (await awaitShareLinks(() => mintSibling(ref.preview, personId, createdBy ?? "operator"))).result;
    } catch (err) {
      throw new LinkRefused("preview-off", err instanceof Error ? err.message : String(err));
    }
    const url = previewLinkOf(home, result.label);
    // Kept for the operator's Sent to line only (§mesh.public/preview): never in the log, a result or a model's context.
    try {
      if (home.mode === "tunnel") keepSiblingKey(result.record.id, result.label);
      else keepSiblingLink(result.record.id, url);
    } catch (err) {
      console.warn(`[outreach] a person's preview link isn't kept (${err instanceof Error ? err.name : "error"}); it still goes`);
    }
    // On Cloudflare Free the sender hears that its address changes when this computer restarts (§app.outreach/links).
    return { url, line: `${operatorName()} shared a preview with you.`, ...(home.mode === "tunnel" ? { warning: LINK_WARNINGS.quick } : {}), log: { previewId: result.record.id }, minted: { previewId: result.record.id } };
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

// ---- the org's owner page link (§app.owner-page/send) -----------------------------------------------

const owner: LinkResolver = {
  kind: "owner",
  sessions: () => [],
  check({ orgId, personId }, ref) {
    if (ref.kind !== "owner") return no("link", "Not an owner page link.");
    if (!readIndex().orgs.some((o) => o.id === orgId)) return no("not-owner", "That organization isn't attached here.");
    if (ownerOf(orgId)?.id !== personId) return no("not-owner", `${nameOf(orgId, personId)} isn't ${readOrgOrPlaceholder(orgId).name}'s owner.`);
    return addressRefusal();
  },
  // Their live link when its token is kept (nothing made, nothing turned off), else a new one as Get New Owner
  // Link makes it: every older owner link of the org stops at once (one live link per org). Lazy: owner.ts
  // loads the share listener's owner versions.
  async resolve({ orgId, personId }, ref) {
    if (ref.kind !== "owner") throw new LinkRefused("link", "Not an owner page link.");
    const { ownerLinkToSend } = await import("../owner");
    let got: ReturnType<typeof ownerLinkToSend>;
    try {
      got = (await awaitShareLinks(() => ownerLinkToSend(orgId, personId))).result;
    } catch (err) {
      if (isSharingOffError(err)) throw new LinkRefused(SHARING_OFF_ERROR, err.message);
      throw new LinkRefused("not-owner", err instanceof Error ? err.message : String(err));
    }
    if (!got.made) await readyShareAddress();
    const late = addressAfterWait();
    // A link it made stays the org's one live link, undelivered, as after any failure (revoke below).
    if (late) throw new LinkRefused(late.code, late.why);
    return {
      url: linkUrl("i", got.token),
      ...quickNote(),
      line: ownerLine(operatorName(), readOrgOrPlaceholder(orgId).name),
      log: {},
      minted: { ownerHash: got.hash, ...(got.made ? { made: "1" } : {}) },
    };
  },
  // A failure turns nothing off: a link it made is the org's one live link (the older ones stopped at its
  // mint); it stays undelivered, so the owner's ask stays in Needs you.
  revoke() {},
  // The message went: the link answers the owner's ask. Nothing else changes (a new owner's link included).
  settle(m) {
    if (m.ownerHash) markOwnerLinkDelivered(m.ownerHash);
  },
};

export const RESOLVERS: Record<LinkKind, LinkResolver> = { handoff, preview, owner };

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
