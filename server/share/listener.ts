import type { Server } from "node:http";
import type { IncomingMessage } from "node:http";
import { SHARE_PORT_DEFAULT, type PublicLinksFile, type ShareListenerFailure, type TunnelStatus } from "../../shared/public-links";
import { readPublicLinks, sharePin } from "../public-links";
import { createShareServer } from "./edge";
import { gatewayHooks, type GatewayRouter } from "./router";
import { hostPort, listenerFailure, setListenerBound, setListenerFailure, type ShareListenerState } from "./share-state";
import { previewTunnelHooks } from "./preview-tunnel";
import { onPublicLinksChanged } from "./setting-events";
import { tunnelStatus } from "./tunnel/manager";

/**
 * The share listener (§app.baton/share-listener): the ONE port an organization's home host exposes
 * to people outside the tailnet. A separate `http.Server` built by server/share/edge.ts (the
 * allowlist, the limits and the hooks); this file only binds it, rebinds it, stops it and says
 * where links point.
 *
 * Bound from the Public links setting (§mesh.public/setting): "This host is the gateway" binds
 * 127.0.0.1:<sharePort>, behind the front that terminates TLS. SOVA_SHARE_HOST and SOVA_SHARE_PORT
 * pin the address; with neither the setting nor both variables, nothing is bound. A PUT of the
 * setting rebinds without a restart (setting-events), releasing the old port first. A bind that is
 * wanted and fails (the port taken, a SOVA_SHARE_PORT that isn't a port) is kept as the share
 * state's `listener` until one works or none is wanted (§mesh.public/listener-failure). What it
 * bound and where links point are server/share/share-state.ts's, re-exported here.
 *
 * Under Cloudflare Free and Account (§mesh/tunnel) it binds 127.0.0.1:<port> only while a tunnel
 * wants it: the tunnel wiring (server/share/tunnel/wiring.ts) asks with bindForTunnel before each
 * tunnel start, and lets it go with releaseTunnelBind once no tunnel is left. The port is the one a
 * surviving tunnel recorded, else the gateway block's sharePort, else 4802, else any free one.
 */

// The edge's names, where the tests and callers have always imported them.
export { BODY_MAX, clientAddress, createShareServer, HEADERS_TIMEOUT_MS, RateLimiter, REQUEST_TIMEOUT_MS, REQUESTS_PER_MINUTE, shareMayReach } from "./edge";

// Where links point, where the callers have always imported it.
export { linkUrl, linkWarning, noteVerify, sessionLinkWarning, shareInfo, shareListenerState, shareState, type ShareListenerState } from "./share-state";

/** What to bind: `port` as asked (0 = any), so a rebind to the same ask keeps the socket. */
interface BindTarget {
  host: string;
  port: number;
}

let bound: { server: Server; router: GatewayRouter; state: ShareListenerState; want: BindTarget } | null = null;
/** Builds each bound server's hooks: the gateway's router (M5); tests pass their own. */
let makeHooks: () => GatewayRouter = gatewayHooks;
let unsubscribe: (() => void) | null = null;
/** Every bind and close runs in this order, one at a time. */
let chain: Promise<unknown> = Promise.resolve();
/** Bumped by stop: a rebind queued before it binds nothing. */
let generation = 0;

/** The port a Cloudflare tunnel asked for (bindForTunnel), or null: no tunnel wants the listener. */
let tunnelPort: number | null = null;
/** The environment startShareListener was given, for the tunnel's own binds. */
let listenEnv: NodeJS.ProcessEnv = process.env;

const tunnelRoute = (file: PublicLinksFile): boolean => file.route === "quick" || file.route === "account";

/** A candidate address being verified right now (withCandidate): its host passes the Host gate, and
    `port` (a gateway candidate's sharePort) is bound when nothing else is. Only during a Verify. */
let candidate: { host: string; port: number | null } | null = null;

/** What the setting and the environment ask for: an address to bind, a failure (a bind is wanted
    but SOVA_SHARE_PORT isn't a port; only the variable can be one, the setting is parsed
    strictly), or null: nothing to bind. */
function bindAsk(file: PublicLinksFile, env: NodeJS.ProcessEnv): { want: BindTarget } | { failure: ShareListenerFailure } | null {
  const self = file.route === "self" && file.gateway ? file.gateway : null;
  const tunnel = (tunnelRoute(file) || candidate) && tunnelPort !== null ? tunnelPort : candidate?.port ?? null;
  const host = env.SOVA_SHARE_HOST?.trim() || (self || tunnel !== null ? "127.0.0.1" : "");
  const portText = env.SOVA_SHARE_PORT?.trim() || (self ? String(self.sharePort) : tunnel !== null ? String(tunnel) : "");
  if (!host || !portText) return null;
  const port = /^\d{1,5}$/.test(portText) ? Number(portText) : NaN;
  return port <= 65535 ? { want: { host, port } } : { failure: { host, port: null, reason: "SOVA_SHARE_PORT isn't a port number." } };
}

/** Where the setting and the environment say to bind; null: nothing to bind, or nothing valid. */
export function bindTarget(file: PublicLinksFile, env: NodeJS.ProcessEnv = process.env): BindTarget | null {
  const ask = bindAsk(file, env);
  return ask && "want" in ask ? ask.want : null;
}

/** A failed listen in one sentence (§design.copy-deck/public-links). */
function failureReason(err: NodeJS.ErrnoException, want: BindTarget): string {
  switch (err.code) {
    case "EADDRINUSE":
      return `Another program is already using ${hostPort(want.host, want.port)}.`;
    case "EACCES":
      return `This host doesn't let Sova use port ${want.port}.`;
    case "EADDRNOTAVAIL":
      return `${want.host} isn't an address of this host.`;
    default:
      return `Couldn't open ${hostPort(want.host, want.port)} (${err.code ?? err.message}).`;
  }
}

/** Cut the router's open hops (dispose: nothing routes through it again), then close the
    server; resolves once the port is free. */
function close(server: Server, router: GatewayRouter): Promise<void> {
  try {
    router.dispose();
  } catch (err) {
    console.warn(`[share] router dispose failed: ${(err as Error)?.name ?? "error"}`);
  }
  return new Promise((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections();
  });
}

function bind(want: BindTarget, gen: number): Promise<ShareListenerState | null> {
  const hooks = makeHooks();
  // A Free preview tunnel's requests come here too; the edge picks them by Host (§mesh.public/preview-tunnels).
  const previewTunnel = previewTunnelHooks();
  const router: GatewayRouter = {
    ...hooks,
    dispose: () => {
      hooks.dispose();
      previewTunnel.dispose();
    },
  };
  const server = createShareServer({ ...router, previewTunnel, shareHost: (req) => shareHostAllowed(req.headers.host, readPublicLinks(listenEnv), tunnelStatus({ kind: "share" }), listenEnv, candidate?.host ?? null) });
  return new Promise((resolve) => {
    server.once("error", (err: NodeJS.ErrnoException) => {
      console.warn(`[share] listener not up on ${want.host}:${want.port}: ${err.message}`);
      if (gen === generation) setListenerFailure({ host: want.host, port: want.port, reason: failureReason(err, want) });
      void close(server, router);
      resolve(null);
    });
    server.listen(want.port, want.host, () => {
      if (gen !== generation) {
        // Stopped while binding: never leave a socket or a router behind.
        void close(server, router);
        resolve(null);
        return;
      }
      const actual = (server.address() as { port: number }).port;
      bound = { server, router, state: { host: want.host, port: actual }, want };
      setListenerBound(bound.state);
      setListenerFailure(null);
      console.log(`[share] share listener on http://${want.host.includes(":") ? `[${want.host}]` : want.host}:${actual}`);
      resolve(bound.state);
    });
  });
}

/** Make the bound socket match the ask: keep it when it already does, else close it (the port is
    free once this resolves) and bind anew; an ask that is a failure binds nothing and keeps it. */
function rebind(ask: ReturnType<typeof bindAsk>): Promise<ShareListenerState | null> {
  const gen = generation;
  const want = ask && "want" in ask ? ask.want : null;
  const run = chain.then(async () => {
    if (gen !== generation) return null;
    if (bound && want && bound.want.host === want.host && bound.want.port === want.port) return bound.state;
    if (bound) {
      const old = bound;
      bound = null;
      setListenerBound(null);
      await close(old.server, old.router);
    }
    if (gen !== generation) return null;
    if (ask && "failure" in ask) {
      if (listenerFailure()?.reason !== ask.failure.reason) console.warn(`[share] listener not up: ${ask.failure.reason}`);
      setListenerFailure(ask.failure);
    }
    if (!want) {
      if (!ask) setListenerFailure(null);
      return null;
    }
    return bind(want, gen);
  });
  chain = run.catch(() => undefined);
  return run;
}

/** Bind from the setting and the environment (null when nothing is bound), and follow the
    setting's changes from now on. */
export function startShareListener(env: NodeJS.ProcessEnv = process.env, opts: { hooks?: () => GatewayRouter } = {}): Promise<ShareListenerState | null> {
  makeHooks = opts.hooks ?? gatewayHooks;
  listenEnv = env;
  unsubscribe?.();
  unsubscribe = onPublicLinksChanged((file) => rebind(bindAsk(file, env)).then(() => undefined));
  sharePin(env); // a refused pin says so at startup, not first at a mint
  return rebind(bindAsk(readPublicLinks(), env));
}

/** Resolves once every bind and close queued so far has run: a PUT of the setting answers with
    the bind as it came out (§mesh.public/listener-failure). */
export const shareListenerSettled = (): Promise<void> => chain.then(() => undefined);

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

/** A Host header's host, lowercased, without its port; null when it isn't one. Pure. */
function hostOnly(raw: string | undefined): string | null {
  const h = (raw ?? "").trim().toLowerCase();
  if (!h) return null;
  const m = /^(\[[0-9a-f:.]+\]|[a-z0-9.-]+)(?::\d{1,5})?$/.exec(h);
  return m ? m[1]! : null;
}

/**
 * The share host's gate under Cloudflare Free and Account (fails closed): a request reaches the share
 * routes only when its Host is exactly the share tunnel's current host (Account: its saved address's
 * host), or loopback for the operator's own checks. Any other Host is the plain 404: another
 * tunnel's words, an address from before a restart, and every request while the tunnel's address
 * isn't known yet (adopt still running, a host change). Other routes and the env pins judge no Host.
 * Pure.
 */
export function shareHostAllowed(raw: string | undefined, file: PublicLinksFile, share: TunnelStatus, env: NodeJS.ProcessEnv = process.env, candidateHost: string | null = null): boolean {
  if (!tunnelRoute(file) || env.SOVA_SHARE_PUBLIC_URL?.trim()) return true;
  const host = hostOnly(raw);
  if (!host) return false;
  if (LOOPBACK.has(host)) return true;
  // The candidate's own address, while its Verify runs.
  if (candidateHost && candidateHost === host) return true;
  const origin = file.route === "account" ? (file.account?.publicUrl ?? null) : share.state === "up" || share.state === "degraded" ? share.origin : null;
  if (!origin) return false;
  try {
    return new URL(origin).hostname.toLowerCase() === host;
  } catch {
    return false;
  }
}

/** Sova's own ports: never behind a tunnel (§mesh/tunnel). */
function ownPort(port: number, env: NodeJS.ProcessEnv): boolean {
  return [4800, 4801, 4810, Number(env.PORT), Number(env.SOVA_PORT)].includes(port);
}

/**
 * Bind the share listener for a Cloudflare tunnel and answer the loopback port it forwards to
 * (tunnel-core's shareTarget, before every tunnel start). `recorded`: the port a surviving tunnel
 * points at, bound exactly; else the gateway block's sharePort, else 4802, and any free port when
 * that one is taken. Idempotent: an already bound listener answers its port. Throws when nothing
 * could be bound, or the route runs no tunnel.
 */
export async function bindForTunnel(recorded: number | null, file: PublicLinksFile = readPublicLinks(listenEnv)): Promise<number> {
  if (!tunnelRoute(file) && !candidate) throw new Error("The route runs no Cloudflare tunnel.");
  // Account's dashboard points at exactly sharePort (its guide says so): no fallback there, a taken
  // port is the listener failure. Free's own tunnel follows whatever port it got.
  const asked = file.gateway?.sharePort ?? SHARE_PORT_DEFAULT;
  const tries = recorded !== null ? [recorded] : file.route === "quick" ? [asked, 0] : [asked];
  for (const port of tries) {
    if (bound && (port === 0 || bound.want.port === port || bound.state.port === port)) return guard(bound.state.port);
    tunnelPort = port;
    const got = await rebind(bindAsk(file, listenEnv));
    if (got) return guard(got.port);
  }
  throw new Error(listenerFailure()?.reason ?? "The share listener couldn't be opened.");
}

function guard(port: number): number {
  if (ownPort(port, listenEnv)) throw new Error(`Port ${port} is Sova's own, never behind a tunnel.`);
  return port;
}

/** No tunnel wants the listener any more: under Free or Account it closes. */
export function releaseTunnelBind(file: PublicLinksFile = readPublicLinks(listenEnv)): Promise<ShareListenerState | null> {
  tunnelPort = null;
  return rebind(bindAsk(file, listenEnv));
}

/**
 * Run `check` (a candidate's Verify) with the candidate's address let in: its host passes the Host
 * gate, and a gateway candidate's `port` is bound when the listener has nothing else to bind. Put
 * back as it was afterwards, whatever `check` did.
 */
export async function withCandidate<T>(c: { host: string; port: number | null }, check: () => Promise<T>): Promise<T> {
  candidate = { host: c.host.toLowerCase(), port: c.port };
  try {
    if (c.port !== null && !bound) await rebind(bindAsk(readPublicLinks(listenEnv), listenEnv));
    return await check();
  } finally {
    candidate = null;
    const file = readPublicLinks(listenEnv);
    // A candidate's tunnel bound for itself under a route that runs none: that ask ends with it.
    if (!tunnelRoute(file)) tunnelPort = null;
    await rebind(bindAsk(file, listenEnv)).catch(() => null);
  }
}

/** The address the listener is bound on, for a candidate's reason. */
export const boundPort = (): number | null => bound?.state.port ?? null;

export function stopShareListener(): void {
  generation++;
  tunnelPort = null;
  setListenerFailure(null);
  unsubscribe?.();
  unsubscribe = null;
  if (!bound) return;
  void close(bound.server, bound.router);
  bound = null;
  setListenerBound(null);
}
