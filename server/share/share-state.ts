import { LINK_WARNINGS, type LinkWarningCode, type PublicLinksFile, type ShareListenerFailure, type ShareState } from "../../shared/public-links";
import { SESSION_SHARE_GATEWAY_OLD, type SessionShareWarningCode } from "../../shared/session-share";
import { readPeers } from "../mesh/peers";
import { readPublicLinks, sharePin } from "../public-links";
import { viaGatewayStatus } from "./gateway-client";
import type { IngressInfo } from "./ingress";
import type { ShareLinksOutcome } from "./links-events";

/**
 * Where links point and what is bound, read without the servers (§app.baton/share-listener,
 * §mesh.public/setting): the share listener (server/share/listener.ts) and a routed host's ingress
 * (server/share/ingress.ts) record here what they bound; everything that only reads it (a mint's
 * warning, Sova's own ports) imports this file, never the servers and the pages they serve. Nothing
 * recorded: nothing is bound.
 */

export interface ShareListenerState {
  host: string;
  port: number;
}

/** The share listener's bound address, as listener.ts last recorded it. */
let listener: ShareListenerState | null = null;
/** The last wanted bind that failed, until one works or none is wanted. */
let failure: ShareListenerFailure | null = null;
/** The running ingress's info, when ingress.ts is loaded. */
let ingress: () => IngressInfo | null = () => null;

export const setListenerBound = (state: ShareListenerState | null): void => void (listener = state);
export const setListenerFailure = (f: ShareListenerFailure | null): void => void (failure = f);
export const listenerFailure = (): ShareListenerFailure | null => failure;
export const setIngressInfo = (read: () => IngressInfo | null): void => void (ingress = read);

/** The bound address, when one is. */
export const shareListenerState = (): ShareListenerState | null => listener;

/** The routed host's ingress, when one runs. */
export const ingressInfo = (): IngressInfo | null => ingress();

export const hostPort = (host: string, port: number) => `${host.includes(":") ? `[${host}]` : host}:${port}`;

// ---- where links point -----------------------------------------------------------------------

/** The last Verify of this process: an address that failed reads `unreachable` until one passes. */
let lastCheck: { url: string; ok: boolean } | null = null;
export function noteVerify(url: string, ok: boolean): void {
  lastCheck = { url, ok };
}

const boundUrl = (): string | null => (listener ? `http://${hostPort(listener.host, listener.port)}` : null);
/** A warning's text with the gateway named; a sentence that starts with the name starts with a capital. */
function fill(code: LinkWarningCode, gateway: string): string {
  const text = LINK_WARNINGS[code].replaceAll("{gateway}", gateway);
  return text.charAt(0).toUpperCase() + text.slice(1);
}
const GATEWAY_FALLBACK = "the gateway";

/** The via gateway's peer entry, looked up by its StableID when read (so a rename shows). */
function viaPeer(nodeId: string): { id: string; label: string } | null {
  const r = readPeers();
  const p = r.ok ? r.config.peers.find((x) => x.nodeId === nodeId) : undefined;
  return p ? { id: p.id, label: p.label } : null;
}

/** An address of this host's own (the env pin, its gateway setting, the bound one): verified by a
    Verify that passed, unreachable after one that failed, else only configured. */
function ownState(source: ShareState["source"], publicUrl: string, file: PublicLinksFile): ShareState {
  const checked = lastCheck?.url === publicUrl ? lastCheck.ok : null;
  if (checked === true || (checked === null && file.verifiedAt !== undefined && source !== "bound")) return { state: "verified", source, publicUrl };
  return { state: checked === false ? "unreachable" : "configured", source, publicUrl, warning: LINK_WARNINGS.unverified, warningCode: "unverified" };
}

/** Where links minted here point, and whether they open from outside (ShareState). First match:
    SOVA_SHARE_PUBLIC_URL (a pin), this host's own gateway setting, the via gateway (live, else
    lastKnownUrl), the bound address, off; with `listener` while a wanted bind failed. */
export function shareState(env: NodeJS.ProcessEnv = process.env, file: PublicLinksFile = readPublicLinks()): ShareState {
  const s = effectiveState(env, file);
  return failure ? { ...s, listener: { ...failure } } : s;
}

function effectiveState(env: NodeJS.ProcessEnv, file: PublicLinksFile): ShareState {
  const pin = sharePin(env);
  if (pin) return ownState("env", pin, file);
  if (file.route === "self" && file.gateway) return ownState("setting", file.gateway.publicUrl, file);
  if (typeof file.route === "object") {
    const status = viaGatewayStatus();
    const url = status?.publicUrl ?? file.lastKnownUrl ?? null;
    if (url) {
      const peer = viaPeer(file.route.via.nodeId);
      const name = status?.label || peer?.label || GATEWAY_FALLBACK;
      const base: ShareState = { state: "configured", source: "gateway", publicUrl: url, ...(peer ? { via: peer.id } : {}) };
      if (status && !status.reachable) return { ...base, state: "unreachable", warning: fill("unreachable", name), warningCode: "unreachable" };
      if (status?.accepting === false) return { ...base, warning: fill("not-accepted", name), warningCode: "not-accepted" };
      if (status?.reachable && status.accepting === true) return { ...base, state: "verified" };
      return { ...base, warning: fill("unconfirmed", name), warningCode: "unconfirmed" };
    }
  }
  const at = boundUrl();
  if (at) return ownState("bound", at, file);
  return { state: "off", source: "setting", publicUrl: null, warning: LINK_WARNINGS.off, warningCode: "off" };
}

/** Where the operator app builds full links: the effective address (shareState). Its shape is on
    the wire (shared/baton.ts BatonInfo.share); shareState() is the full answer. */
export function shareInfo(env: NodeJS.ProcessEnv = process.env): { bound: boolean; publicUrl: string | null } {
  return { bound: !!listener, publicUrl: shareState(env).publicUrl };
}

/** Every link as the operator copies it, `/h/` (hand-off), `/i/` (owner page) and `/s/` (session
    share) alike: the effective address, else just the path. */
export function linkUrl(kind: "h" | "i" | "s", token: string, env: NodeJS.ProcessEnv = process.env): string {
  return `${shareState(env).publicUrl ?? ""}/${kind}/${token}`;
}

/** What a response carrying a just-minted link says about it (§app.baton/links): the address's own
    warning first; else the mint's (awaitShareLinks): a listener's warning, or `unconfirmed` when
    one timed out or failed; else nothing. */
export function linkWarning(outcome?: ShareLinksOutcome, env: NodeJS.ProcessEnv = process.env): { linkWarning?: string; linkWarningCode?: LinkWarningCode } {
  const s = shareState(env);
  if (s.warning) return { linkWarning: s.warning, ...(s.warningCode ? { linkWarningCode: s.warningCode } : {}) };
  if (!outcome) return {};
  const file = readPublicLinks();
  const name = (typeof file.route === "object" && (viaGatewayStatus()?.label || viaPeer(file.route.via.nodeId)?.label)) || GATEWAY_FALLBACK;
  if (outcome.warning) {
    const code = (Object.keys(LINK_WARNINGS) as LinkWarningCode[]).find((k) => fill(k, name) === outcome.warning);
    return { linkWarning: outcome.warning, ...(code ? { linkWarningCode: code } : {}) };
  }
  if (outcome.timedOut || outcome.failed) return { linkWarning: fill("unconfirmed", name), linkWarningCode: "unconfirmed" };
  return {};
}

/** linkWarning for session links (§app.session-share/link): the address's own warning first; then,
    on a host routed through a gateway that doesn't list kind `s` (an older gateway, or one not
    asked yet), `gateway-old`, since its snapshot carries no session row; else the mint's. */
export function sessionLinkWarning(outcome?: ShareLinksOutcome, env: NodeJS.ProcessEnv = process.env): { linkWarning?: string; linkWarningCode?: SessionShareWarningCode } {
  const s = shareState(env);
  if (s.warning) return linkWarning(outcome, env);
  const file = readPublicLinks();
  if (typeof file.route === "object" && !viaGatewayStatus()?.kinds?.includes("s")) {
    const name = viaGatewayStatus()?.label || viaPeer(file.route.via.nodeId)?.label || GATEWAY_FALLBACK;
    return { linkWarning: SESSION_SHARE_GATEWAY_OLD.replaceAll("{gateway}", name), linkWarningCode: "gateway-old" };
  }
  return linkWarning(outcome, env);
}
