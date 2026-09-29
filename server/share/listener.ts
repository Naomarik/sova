import type { Server } from "node:http";
import { LINK_WARNINGS, type LinkWarningCode, type PublicLinksFile, type ShareState } from "../../shared/public-links";
import { readPeers } from "../mesh/peers";
import { readPublicLinks } from "../public-links";
import { createShareServer } from "./edge";
import { viaGatewayStatus } from "./gateway-client";
import type { ShareLinksOutcome } from "./links-events";
import { gatewayHooks } from "./router";
import { onPublicLinksChanged } from "./setting-events";

/**
 * The share listener (§app.baton/share-listener): the ONE port an organization's home host exposes
 * to people outside the tailnet. A separate `http.Server` built by server/share/edge.ts (the
 * allowlist, the limits and the hooks); this file only binds it, rebinds it, stops it and says
 * where links point.
 *
 * Bound from the Public links setting (§mesh.public/setting): "This host is the gateway" binds
 * 127.0.0.1:<sharePort>, behind the front that terminates TLS. SOVA_SHARE_HOST and SOVA_SHARE_PORT
 * pin the address; with neither the setting nor both variables, nothing is bound. A PUT of the
 * setting rebinds without a restart (setting-events), releasing the old port first.
 */

// The edge's names, where the tests and callers have always imported them.
export { BODY_MAX, clientAddress, createShareServer, HEADERS_TIMEOUT_MS, RateLimiter, REQUEST_TIMEOUT_MS, REQUESTS_PER_MINUTE, shareMayReach } from "./edge";

export interface ShareListenerState {
  host: string;
  port: number;
}

/** What to bind: `port` as asked (0 = any), so a rebind to the same ask keeps the socket. */
interface BindTarget {
  host: string;
  port: number;
}

let bound: { server: Server; state: ShareListenerState; want: BindTarget } | null = null;
let unsubscribe: (() => void) | null = null;
/** Every bind and close runs in this order, one at a time. */
let chain: Promise<unknown> = Promise.resolve();
/** Bumped by stop: a rebind queued before it binds nothing. */
let generation = 0;

/** Where the setting and the environment say to bind; null: nothing to bind. */
export function bindTarget(file: PublicLinksFile, env: NodeJS.ProcessEnv = process.env): BindTarget | null {
  const self = file.route === "self" && file.gateway ? file.gateway : null;
  const host = env.SOVA_SHARE_HOST?.trim() || (self ? "127.0.0.1" : "");
  const portText = env.SOVA_SHARE_PORT?.trim() || (self ? String(self.sharePort) : "");
  if (!host || !portText || !/^\d{1,5}$/.test(portText)) return null;
  const port = Number(portText);
  return port <= 65535 ? { host, port } : null;
}

function close(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections();
  });
}

function bind(want: BindTarget, gen: number): Promise<ShareListenerState | null> {
  const server = createShareServer(gatewayHooks());
  return new Promise((resolve) => {
    server.once("error", (err) => {
      console.warn(`[share] listener not up on ${want.host}:${want.port}: ${err.message}`);
      resolve(null);
    });
    server.listen(want.port, want.host, () => {
      if (gen !== generation) {
        // Stopped while binding: never leave a socket behind.
        void close(server);
        resolve(null);
        return;
      }
      const actual = (server.address() as { port: number }).port;
      bound = { server, state: { host: want.host, port: actual }, want };
      console.log(`[share] share listener on http://${want.host.includes(":") ? `[${want.host}]` : want.host}:${actual}`);
      resolve(bound.state);
    });
  });
}

/** Make the bound socket match `want`: keep it when it already does, else close it (the port is
    free once this resolves) and bind anew. */
function rebind(want: BindTarget | null): Promise<ShareListenerState | null> {
  const gen = generation;
  const run = chain.then(async () => {
    if (gen !== generation) return null;
    if (bound && want && bound.want.host === want.host && bound.want.port === want.port) return bound.state;
    if (bound) {
      const old = bound.server;
      bound = null;
      await close(old);
    }
    if (!want || gen !== generation) return null;
    return bind(want, gen);
  });
  chain = run.catch(() => undefined);
  return run;
}

/** Bind from the setting and the environment (null when nothing is bound), and follow the
    setting's changes from now on. */
export function startShareListener(env: NodeJS.ProcessEnv = process.env): Promise<ShareListenerState | null> {
  unsubscribe?.();
  unsubscribe = onPublicLinksChanged((file) => rebind(bindTarget(file, env)).then(() => undefined));
  return rebind(bindTarget(readPublicLinks(), env));
}

export function stopShareListener(): void {
  generation++;
  unsubscribe?.();
  unsubscribe = null;
  if (!bound) return;
  bound.server.close();
  bound.server.closeAllConnections();
  bound = null;
}

/** The bound address, when one is. */
export const shareListenerState = (): ShareListenerState | null => bound?.state ?? null;

// ---- where links point -----------------------------------------------------------------------

/** The last Verify of this process: an address that failed reads `unreachable` until one passes. */
let lastCheck: { url: string; ok: boolean } | null = null;
export function noteVerify(url: string, ok: boolean): void {
  lastCheck = { url, ok };
}

const boundUrl = (): string | null => (bound ? `http://${bound.state.host.includes(":") ? `[${bound.state.host}]` : bound.state.host}:${bound.state.port}` : null);
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
    lastKnownUrl), the bound address, off. */
export function shareState(env: NodeJS.ProcessEnv = process.env, file: PublicLinksFile = readPublicLinks()): ShareState {
  const pin = env.SOVA_SHARE_PUBLIC_URL?.trim().replace(/\/+$/, "");
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
  return { bound: !!bound, publicUrl: shareState(env).publicUrl };
}

/** Every link as the operator copies it, `/h/` (hand-off) and `/i/` (owner page) alike: the
    effective address, else just the path. */
export function linkUrl(kind: "h" | "i", token: string, env: NodeJS.ProcessEnv = process.env): string {
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
