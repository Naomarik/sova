import type { Server } from "node:http";
import type { Socket } from "node:net";
import type { Duplex } from "node:stream";
import { SHARE_PORT_DEFAULT, type PublicLinksFile } from "../../shared/public-links";
import { tailnetIp } from "../mesh/address-identity";
import { gatewayGate, type GatewayIdentity } from "../mesh/gate";
import { getIdentity } from "../mesh/localapi";
import { createShareServer, type ShareDispatch, type ShareUpgrade } from "./edge";
import { bumpRouteGeneration, routeSetting, viaGatewayIdentity, viaGatewayPeer } from "./gateway-client";
import { registryRouteChanged, startRegistryPush, stopRegistryPush } from "./registry-push";
import { trustedClient } from "./security";
import { onPublicLinksChanged } from "./setting-events";

/**
 * A routed host's share ingress (§mesh.public/ingress): with `route: { via }`, a share server on
 * this host's tailnet addresses at `ingressPort`, built by createShareServer with the gateway gate
 * as `admit`, so it serves exactly the public share paths, and only to the `via` gateway. The
 * gateway's single X-Forwarded-For is the client key (trustedClient `admitted`: the edge runs
 * `client` only after `admit` passed). It follows the setting (setting-events) and peers.json, and
 * re-runs the whole gate on every connection it admitted, kept-alive HTTP and upgraded sockets
 * alike, on a setting change and every RECHECK_MS (2 s, with a responsive event loop): whatever no
 * longer passes (the gateway removed or changed, its pins changed, its address now ambiguous or
 * unmapped) is closed. It never mints a link or emits a link change: it serves the share app.
 *
 * startIngress also starts the registry push, which follows the same setting.
 */

const RETRY_MS = 15_000;
const RECHECK_MS = 2000;

export interface IngressDeps {
  /** The gateway to admit, read fresh on every request and every recheck; null admits nobody. */
  expected: () => GatewayIdentity | null;
  /** The addresses to bind (tailnet IPs; tests: loopback). */
  addresses: () => Promise<string[]>;
  port: number;
  /** How often admitted connections are re-judged by the whole gate. */
  recheckMs?: number;
  /** Tests: answer instead of the in-process share app. */
  dispatch?: ShareDispatch;
  upgrade?: ShareUpgrade;
}

export interface IngressInfo {
  addresses: string[];
  port: number;
  error?: string;
}

export interface Ingress {
  start(): Promise<void>;
  close(): void;
  /** Re-run the gate on every admitted connection and close each one it refuses now. */
  recheck(): Promise<void>;
  info(): IngressInfo;
  admittedCount(): number;
}

export function createIngress(deps: IngressDeps): Ingress {
  const gate = gatewayGate(deps.expected);
  /** Every connection the gate admitted (an upgrade keeps its TCP socket). */
  const admitted = new Set<Duplex>();
  const servers: Server[] = [];
  let state: IngressInfo = { addresses: [], port: deps.port };
  let closed = false;
  let retry: NodeJS.Timeout | null = null;
  let recheckTimer: NodeJS.Timeout | null = null;

  /** The policy the gate judges against, as a comparable value; null when it can't be read. */
  const policy = (): string | null => {
    try {
      return JSON.stringify(deps.expected() ?? null);
    } catch {
      return null;
    }
  };

  const admit = async (req: { socket: Socket }): Promise<boolean> => {
    const socket = req.socket;
    const before = policy();
    if (before === null || !(await gate(socket))) return false;
    // The policy changed while the gate was deciding: this admission proves nothing about the new one.
    if (closed || policy() !== before) return false;
    if (!admitted.has(socket)) {
      admitted.add(socket);
      socket.once("close", () => admitted.delete(socket));
    }
    return true;
  };

  const recheck = async (): Promise<void> => {
    await Promise.all(
      [...admitted].map(async (socket) => {
        if (await gate(socket as Socket)) return;
        admitted.delete(socket);
        socket.destroy();
      }),
    );
  };

  const serverFor = (): Server =>
    createShareServer({
      admit: (req) => admit(req),
      client: (req) => trustedClient(req, { trust: "admitted", admitted: true }),
      ...(deps.dispatch ? { dispatch: deps.dispatch } : {}),
      ...(deps.upgrade ? { upgrade: deps.upgrade } : {}),
    });

  const fail = (error: string): void => {
    state = { addresses: [], port: deps.port, error };
    console.warn(`[share] ingress not up (retrying in ${RETRY_MS / 1000}s): ${error}`);
    retry = setTimeout(() => {
      retry = null;
      void start();
    }, RETRY_MS);
    retry.unref();
  };

  const start = async (): Promise<void> => {
    if (closed) return;
    let addresses: string[];
    try {
      addresses = await deps.addresses();
      if (!addresses.length) throw new Error("this node has no tailnet address");
    } catch (err) {
      if (!closed) fail((err as Error).message);
      return;
    }
    const bound: string[] = [];
    const errors: string[] = [];
    let port = deps.port;
    for (const address of addresses) {
      if (closed) return;
      const server = serverFor();
      try {
        await new Promise<void>((resolve, reject) => {
          server.once("error", reject);
          server.listen(port, address, () => {
            server.off("error", reject);
            resolve();
          });
        });
        server.on("error", (err) => console.warn(`[share] ingress ${address}: ${err.message}`));
        port = (server.address() as { port: number }).port; // port 0 (tests): every address on one port
        servers.push(server);
        bound.push(address);
      } catch (err) {
        errors.push(`${address}: ${(err as Error).message}`);
      }
    }
    if (closed) {
      close();
      return;
    }
    if (!bound.length) {
      fail(errors.join("; "));
      return;
    }
    state = { addresses: bound, port, ...(errors.length ? { error: errors.join("; ") } : {}) };
    if (!recheckTimer) {
      recheckTimer = setInterval(() => void recheck(), deps.recheckMs ?? RECHECK_MS);
      recheckTimer.unref();
    }
    console.log(`[share] ingress on ${bound.map((a) => (a.includes(":") ? `[${a}]` : a)).join(", ")} port ${port}`);
  };

  const close = (): void => {
    closed = true;
    if (retry) clearTimeout(retry);
    retry = null;
    if (recheckTimer) clearInterval(recheckTimer);
    recheckTimer = null;
    for (const s of servers.splice(0)) {
      s.close();
      s.closeAllConnections();
    }
    // closeAllConnections leaves upgraded sockets alone.
    for (const socket of admitted) socket.destroy();
    admitted.clear();
    state = { addresses: [], port: deps.port };
  };

  return {
    start,
    close,
    recheck,
    info: () => ({ ...state, addresses: [...state.addresses] }),
    admittedCount: () => admitted.size,
  };
}

// ---- this host's ingress ------------------------------------------------------------------------

/** SOVA_PEER_HOST, else this node's tailnet addresses from LocalAPI; tailnet addresses only. */
async function tailnetBind(): Promise<string[]> {
  const pinned = process.env.SOVA_PEER_HOST?.split(",").map((a) => a.trim()).filter(Boolean);
  const raw = pinned?.length ? pinned : (await getIdentity().status()).self.addresses;
  return [...new Set(raw.map((a) => tailnetIp(a)).filter((a): a is string => !!a))];
}

let running: { ingress: Ingress; port: number } | null = null;
/** The via gateway last seen (routed and a peer), so a change reaches the registry push too. */
let lastGateway: string | null = null;
let unsubscribe: (() => void) | null = null;
let watch: NodeJS.Timeout | null = null;

function routedPort(file: PublicLinksFile | null): number | null {
  const route = file?.route;
  return typeof route === "object" && route !== null ? (file!.ingressPort ?? SHARE_PORT_DEFAULT) : null;
}

/** Bind, rebind, re-judge or unbind to match the setting and peers.json now. */
function apply(file: PublicLinksFile | null = routeSetting()): void {
  const port = routedPort(file);
  const gateway = port !== null ? (viaGatewayPeer()?.nodeId ?? null) : null;
  if (gateway !== lastGateway) {
    lastGateway = gateway;
    registryRouteChanged();
  }
  // Bound only while routed through a gateway that is a peer: nobody else could be admitted.
  const want = port !== null && viaGatewayPeer() ? port : null;
  if (running && running.port !== want) {
    running.ingress.close();
    running = null;
  }
  if (want === null) return;
  if (running) {
    void running.ingress.recheck();
    return;
  }
  const ingress = createIngress({ expected: viaGatewayIdentity, addresses: tailnetBind, port: want });
  running = { ingress, port: want };
  void ingress.start();
}

export async function startIngress(): Promise<void> {
  if (unsubscribe) return;
  unsubscribe = onPublicLinksChanged((file) => {
    bumpRouteGeneration(); // whatever was in flight was for the old setting
    apply(file);
    registryRouteChanged();
  });
  lastGateway = null;
  // peers.json has no change event here: a removed gateway or a newly paired one is noticed by
  // this poll (one stat), and the gate itself refuses a removed gateway's next request at once.
  watch = setInterval(() => apply(), RECHECK_MS);
  watch.unref();
  startRegistryPush();
  apply();
}

export function stopIngress(): void {
  unsubscribe?.();
  unsubscribe = null;
  if (watch) clearInterval(watch);
  watch = null;
  running?.ingress.close();
  running = null;
  stopRegistryPush();
}

/** This host's ingress as bound now, or null (not routed, or not started). */
export function ingressInfo(): IngressInfo | null {
  return running ? running.ingress.info() : null;
}
