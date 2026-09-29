import type { Server } from "node:http";
import type { ShareState } from "../../shared/public-links";
import { createShareServer } from "./edge";
import { gatewayHooks } from "./router";

/**
 * The share listener (§app.baton/share-listener): the ONE port an organization's home host exposes
 * to people outside the tailnet. A separate `http.Server` built by server/share/edge.ts (the
 * allowlist, the limits and the hooks); this file only binds it, stops it and says where links
 * point.
 *
 * Bound only when SOVA_SHARE_HOST and SOVA_SHARE_PORT are both set. Public exposure (a TLS reverse
 * proxy in front of it) is a deployment step outside Sova.
 */

// The edge's names, where the tests and callers have always imported them.
export { BODY_MAX, clientAddress, createShareServer, HEADERS_TIMEOUT_MS, RateLimiter, REQUEST_TIMEOUT_MS, REQUESTS_PER_MINUTE, shareMayReach } from "./edge";

export interface ShareListenerState {
  host: string;
  port: number;
}

let bound: { server: Server; state: ShareListenerState } | null = null;

/** Bind from the environment; a no-op (and null) unless SOVA_SHARE_HOST and SOVA_SHARE_PORT are set. */
export function startShareListener(env: NodeJS.ProcessEnv = process.env): Promise<ShareListenerState | null> {
  const host = env.SOVA_SHARE_HOST?.trim();
  const port = Number(env.SOVA_SHARE_PORT);
  if (!host || !env.SOVA_SHARE_PORT || !Number.isInteger(port) || port < 0 || port > 65535) return Promise.resolve(null);
  const server = createShareServer(gatewayHooks());
  return new Promise((resolve) => {
    server.once("error", (err) => {
      console.warn(`[share] listener not up on ${host}:${port}: ${err.message}`);
      resolve(null);
    });
    server.listen(port, host, () => {
      const actual = (server.address() as { port: number }).port;
      bound = { server, state: { host, port: actual } };
      console.log(`[share] share listener on http://${host}:${actual}`);
      resolve(bound.state);
    });
  });
}

export function stopShareListener(): void {
  if (!bound) return;
  bound.server.close();
  bound.server.closeAllConnections();
  bound = null;
}

/** Where the operator app builds full links: SOVA_SHARE_PUBLIC_URL, else the bound address. Its
    shape is on the wire (shared/baton.ts BatonInfo.share); shareState() is the full answer. */
export function shareInfo(env: NodeJS.ProcessEnv = process.env): { bound: boolean; publicUrl: string | null } {
  const pub = env.SOVA_SHARE_PUBLIC_URL?.trim().replace(/\/+$/, "");
  if (pub) return { bound: !!bound, publicUrl: pub };
  return { bound: !!bound, publicUrl: bound ? `http://${bound.state.host.includes(":") ? `[${bound.state.host}]` : bound.state.host}:${bound.state.port}` : null };
}

/** Where links minted here point, and whether they open from outside (ShareState; the resolution
    order is in shared/public-links.ts). Today: the env pin, else the bound address, else off. */
export function shareState(env: NodeJS.ProcessEnv = process.env): ShareState {
  const { publicUrl } = shareInfo(env);
  if (!publicUrl) return { state: "off", source: "setting", publicUrl: null };
  return { state: "configured", source: env.SOVA_SHARE_PUBLIC_URL?.trim() ? "env" : "bound", publicUrl };
}
