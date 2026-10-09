import { isIP } from "node:net";
import { entryAddresses, tailnetIp } from "./address-identity";
import { getIdentity, type TailnetNode, type TailnetStatus } from "./localapi";
import { type PeerEntry, peerPort, peerUrl } from "./peers";

// Where this host dials a tailnet peer (§mesh/peers): only at an address Tailscale binds to the
// peer's node identity, never wherever its name resolves. WireGuard delivers a tailnet IP only to
// the node that owns it, so the IP that LocalAPI `status` lists for exactly the entry's StableID is
// that peer; a DNS name answered by a spoofed resolver, or a LAN route, is not. Ported from the share
// gateway's verifiedEndpoint (server/share/gateway-client.ts), with a short cache:
// - an IP literal (tailnet, loopback, or with a warning anything else) and an https URL (TLS
//   authenticates the name) are dialed as written;
// - a DNS name (the entry's name, or an http url's host) is dialed at the node's tailnet IP, IPv4
//   first, on the same scheme and port. A node LocalAPI doesn't list, or lists twice, is down.
// - address-identity mode has no LocalAPI: the entry's own tailnet IP, else the name as before.
// The verified IP is kept per StableID for CACHE_MS, kept past that while LocalAPI errors, and
// dropped when a dial to it fails (forgetPeerAddress), so a node that moved is asked about again.

const CACHE_MS = 30_000;

interface Deps {
  now: () => number;
  addressMode: () => boolean;
}

const defaults: Deps = {
  now: Date.now,
  addressMode: () => process.env.SOVA_MESH_IDENTITY === "addresses",
};
let deps: Deps = defaults;

/** Tests: replace some dependencies; returns the undo. */
export function setPeerAddressDeps(partial: Partial<Deps>): () => void {
  const before = deps;
  deps = { ...deps, ...partial };
  return () => {
    deps = before;
  };
}

const verified = new Map<string, { ip: string; at: number }>();
/** One LocalAPI status at a time, shared by every peer that asks meanwhile. */
let asking: Promise<TailnetStatus> | null = null;
const warned = new Set<string>();

/** Tests: forget every verified address and warning. */
export function clearPeerAddresses(): void {
  verified.clear();
  warned.clear();
  asking = null;
}

/** A dial to this peer failed: ask LocalAPI again next time. */
export function forgetPeerAddress(peer: PeerEntry): void {
  verified.delete(peer.nodeId);
}

/** What fetch's own connection failures look like, so every caller reads it as "peer down". */
export class PeerUnverified extends TypeError {
  constructor(reason: string) {
    super("fetch failed", { cause: { code: reason } });
  }
}

const isLoopback = (ip: string): boolean => (isIP(ip) === 4 ? ip.startsWith("127.") : ip === "::1");

/** A node's own address as Tailscale lists it: a tailnet IP (a loopback one, for tests), IPv4 first. */
function nodeIp(addresses: string[]): string | null {
  const ips = addresses.map((a) => tailnetIp(a) ?? (isLoopback(a.trim()) ? a.trim() : null)).filter((a): a is string => !!a);
  return ips.find((a) => isIP(a) === 4) ?? ips[0] ?? null;
}

const withHost = (u: URL, ip: string): string => `${u.protocol}//${ip.includes(":") ? `[${ip}]` : ip}${u.port ? `:${u.port}` : ""}`;

function logOnce(key: string, line: string): void {
  if (warned.has(key)) return;
  warned.add(key);
  console.warn(line);
}

function status(): Promise<TailnetStatus> {
  asking ??= getIdentity()
    .status()
    .finally(() => {
      asking = null;
    });
  return asking;
}

/** The base URL to dial a tailnet peer at (see above); rejects, as a refused connection does, when
    there is no address bound to its node. */
export async function verifiedPeerBase(peer: PeerEntry): Promise<string> {
  if (peer.lan) throw new PeerUnverified("not connected"); // reached over its own connection (dial.ts)
  const raw = peerUrl(peer);
  const u = new URL(raw);
  if (u.protocol === "https:") return raw;
  const host = u.hostname.replace(/^\[|\]$/g, "");
  if (isIP(host)) {
    if (!tailnetIp(host) && !isLoopback(host)) logOnce(`ip:${peer.id}:${host}`, `[mesh] ${peer.id}: ${raw} is not a tailnet address, so nothing proves who answers there`);
    return raw;
  }
  if (deps.addressMode()) {
    const ip = entryAddresses(peer).find((a) => isIP(a) === 4) ?? entryAddresses(peer)[0];
    return ip ? withHost(u, ip) : raw;
  }
  const known = verified.get(peer.nodeId);
  if (known && deps.now() - known.at < CACHE_MS) return withHost(u, known.ip);
  let nodes: TailnetNode[];
  try {
    nodes = (await status()).peers.filter((n) => n.nodeId === peer.nodeId);
  } catch (err) {
    if (known) return withHost(u, known.ip);
    logOnce(`api:${peer.id}`, `[mesh] ${peer.id}: not dialed, Tailscale can't say where node ${peer.nodeId} is (${(err as Error).message})`);
    throw new PeerUnverified("tailscale status unavailable");
  }
  const ip = nodes.length === 1 ? nodeIp(nodes[0]!.addresses) : null;
  if (!ip) {
    verified.delete(peer.nodeId);
    logOnce(`node:${peer.id}`, `[mesh] ${peer.id}: not dialed, Tailscale lists ${nodes.length ? `${nodes.length} nodes with no usable address` : "no node"} for ${peer.nodeId}`);
    throw new PeerUnverified("not on the tailnet");
  }
  warned.delete(`api:${peer.id}`);
  warned.delete(`node:${peer.id}`);
  verified.set(peer.nodeId, { ip, at: deps.now() });
  return withHost(u, ip);
}

/** Where discovery probes a tailnet node: its own tailnet IP on the default peer port, never its name. */
export function candidateBase(n: TailnetNode): string | null {
  const ip = nodeIp(n.addresses);
  return ip ? `http://${ip.includes(":") ? `[${ip}]` : ip}:${peerPort()}` : null;
}

/** The client socket verifiedPeerSocket wraps (ws's WebSocket satisfies it). */
export interface ClientSocket {
  on(event: string, fn: (...args: any[]) => void): unknown;
  close(): void;
  ping?(): void;
  terminate?(): void;
}

/**
 * A socket to a tailnet peer at its verified address, for a caller that needs one at once (the LLM
 * in-flight feed): `open` runs once the address is known, and the handlers given meanwhile are
 * attached to it then. No verified address: "error", then "close", as a refused connection does.
 * Closed before it opened: "close", and it never opens.
 */
export function verifiedPeerSocket(peer: PeerEntry, open: (base: string) => ClientSocket): ClientSocket {
  const handlers: Array<[string, (...args: any[]) => void]> = [];
  let socket: ClientSocket | null = null;
  let ended = false;
  const fire = (event: string, ...args: unknown[]) => {
    for (const [e, fn] of handlers) if (e === event) fn(...args);
  };
  const fail = (err: unknown) => {
    if (ended) return;
    ended = true;
    fire("error", err);
    fire("close");
  };
  void verifiedPeerBase(peer).then((base) => {
    if (ended) return;
    try {
      socket = open(base);
    } catch (err) {
      fail(err);
      return;
    }
    socket.on("error", () => forgetPeerAddress(peer));
    for (const [e, fn] of handlers) socket.on(e, fn);
  }, fail);
  const wrapper: ClientSocket = {
    on(event, fn) {
      handlers.push([event, fn]);
      socket?.on(event, fn);
      return wrapper;
    },
    close() {
      if (socket) socket.close();
      else if (!ended) {
        ended = true;
        queueMicrotask(() => fire("close"));
      }
    },
    ping() {
      socket?.ping?.();
    },
    terminate() {
      if (socket) socket.terminate?.();
      else wrapper.close();
    },
  };
  return wrapper;
}
