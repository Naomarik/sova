// One way to dial a peer (§mesh.lan/as-a-peer): a tailnet peer by its URL, a dial-out pairing over
// the channel this host asks it on (lan.ts). Every caller that talks to a peer server-side goes
// through here (peerFetch, the hello probe, the session list, the /peer proxy), so a pairing is
// reached exactly where a tailnet peer is, and a pairing with no live connection fails at once.

import type { Agent } from "node:http";
import { agentFetch } from "./lan-fetch";
import type { ReverseClient } from "./lan-reverse";
import { type PeerEntry, peerUrl } from "./peers";

interface LanClients {
  /** The client this host asks pairing `peerId` with, while connected. */
  client(peerId: string): ReverseClient | null;
}

let lan: LanClients | null = null;

/** Set once by the mesh runtime. */
export function setLanClients(clients: LanClients | null): void {
  lan = clients;
}

/** How a tailnet peer's URL is reached: the network, unless a test answers in-process. */
export interface PeerWire {
  fetch(req: Request): Promise<Response>;
  /** The bare TCP check before a hop (proxy.ts's preflight and stall watch). */
  reachable(url: string): Promise<boolean>;
}

let wire: PeerWire | null = null;

/** Tests: answer tailnet peers in-process; null is the network again. */
export function setPeerWire(w: PeerWire | null): void {
  wire = w;
}

/** The wire a test set, or null (the network). */
export const peerWire = (): PeerWire | null => wire;

/** fetch(url, init) to a tailnet peer's URL, over the test's wire when one is set. */
export function urlFetch(url: string, init?: RequestInit): Promise<Response> {
  return wire ? wire.fetch(new Request(url, init)) : fetch(url, init);
}

/** A pairing with no live connection: what fetch's own failures look like, with a fixed reason. */
export class NotConnected extends TypeError {
  constructor() {
    super("fetch failed", { cause: { code: "not connected" } });
  }
}

/** The agent for a pairing, or null when it isn't connected (or `peer` isn't a pairing). */
export function lanAgent(peer: PeerEntry): Agent | null {
  return lanClient(peer)?.agent ?? null;
}

/** The client for a pairing (streams, sockets), or null when it isn't connected. */
export function lanClient(peer: PeerEntry): ReverseClient | null {
  return peer.lan ? (lan?.client(peer.id) ?? null) : null;
}

/** What this host reads from a pairing's answer to a probe (hello, details), at most. */
export const PROBE_MAX_BYTES = 1024 * 1024;
/** The same for a session list; SOVA_MESH_LIST_MAX_BYTES sets another. */
export const LIST_MAX_BYTES = 32 * 1024 * 1024;

/** The cap on a pairing's answer to `path` that this host parses itself, or none (a sync or
    transfer body, which has its own limits). */
export function responseCap(path: string, env: NodeJS.ProcessEnv = process.env): number | undefined {
  const p = path.split("?")[0];
  if (p === "/api/peer/hello" || p === "/api/peer/details") return PROBE_MAX_BYTES;
  if (p === "/api/sessions") {
    const n = Number(env.SOVA_MESH_LIST_MAX_BYTES);
    return Number.isInteger(n) && n > 0 ? n : LIST_MAX_BYTES;
  }
  return undefined;
}

/** fetch(<peer>/<path>, init). `path` starts with "/". A pairing's answers to probes and lists are
    capped (responseCap): it may roam anywhere, and nothing else bounds a body it streams. */
export function fetchPeer(peer: PeerEntry, path: string, init?: RequestInit): Promise<Response> {
  if (!peer.lan) return urlFetch(`${peerUrl(peer)}${path}`, init);
  const agent = lanAgent(peer);
  const maxBytes = responseCap(path);
  return agent ? agentFetch(agent, path, init, maxBytes === undefined ? {} : { maxBytes }) : Promise.reject(new NotConnected());
}

/** A Request the proxy built for `peer`, sent the same way. */
export function fetchPeerRequest(peer: PeerEntry, req: Request): Promise<Response> {
  if (!peer.lan) return wire ? wire.fetch(req) : fetch(req);
  const agent = lanAgent(peer);
  return agent ? agentFetch(agent, req) : Promise.reject(new NotConnected());
}

/** A key that names where a peer is reached, for caches: its URL, or its pairing. */
export const peerKey = (peer: PeerEntry): string => (peer.lan ? `lan:${peer.id}:${peer.nodeId}` : peerUrl(peer));
