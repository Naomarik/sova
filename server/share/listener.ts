import type { Server } from "node:http";
import type { PublicLinksFile, ShareListenerFailure } from "../../shared/public-links";
import { readPublicLinks, sharePin } from "../public-links";
import { createShareServer } from "./edge";
import { gatewayHooks, type GatewayRouter } from "./router";
import { hostPort, listenerFailure, setListenerBound, setListenerFailure, type ShareListenerState } from "./share-state";
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
 * setting rebinds without a restart (setting-events), releasing the old port first. A bind that is
 * wanted and fails (the port taken, a SOVA_SHARE_PORT that isn't a port) is kept as the share
 * state's `listener` until one works or none is wanted (§mesh.public/listener-failure). What it
 * bound and where links point are server/share/share-state.ts's, re-exported here.
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

/** What the setting and the environment ask for: an address to bind, a failure (a bind is wanted
    but SOVA_SHARE_PORT isn't a port; only the variable can be one, the setting is parsed
    strictly), or null: nothing to bind. */
function bindAsk(file: PublicLinksFile, env: NodeJS.ProcessEnv): { want: BindTarget } | { failure: ShareListenerFailure } | null {
  const self = file.route === "self" && file.gateway ? file.gateway : null;
  const host = env.SOVA_SHARE_HOST?.trim() || (self ? "127.0.0.1" : "");
  const portText = env.SOVA_SHARE_PORT?.trim() || (self ? String(self.sharePort) : "");
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
  const router = makeHooks();
  const server = createShareServer(router);
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
  unsubscribe?.();
  unsubscribe = onPublicLinksChanged((file) => rebind(bindAsk(file, env)).then(() => undefined));
  sharePin(env); // a refused pin says so at startup, not first at a mint
  return rebind(bindAsk(readPublicLinks(), env));
}

/** Resolves once every bind and close queued so far has run: a PUT of the setting answers with
    the bind as it came out (§mesh.public/listener-failure). */
export const shareListenerSettled = (): Promise<void> => chain.then(() => undefined);

export function stopShareListener(): void {
  generation++;
  setListenerFailure(null);
  unsubscribe?.();
  unsubscribe = null;
  if (!bound) return;
  void close(bound.server, bound.router);
  bound = null;
  setListenerBound(null);
}
