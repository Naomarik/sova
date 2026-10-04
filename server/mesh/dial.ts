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

/** fetch(<peer>/<path>, init). `path` starts with "/". */
export function fetchPeer(peer: PeerEntry, path: string, init?: RequestInit): Promise<Response> {
  if (!peer.lan) return fetch(`${peerUrl(peer)}${path}`, init);
  const agent = lanAgent(peer);
  return agent ? agentFetch(agent, path, init) : Promise.reject(new NotConnected());
}

/** A Request the proxy built for `peer`, sent the same way. */
export function fetchPeerRequest(peer: PeerEntry, req: Request): Promise<Response> {
  if (!peer.lan) return fetch(req);
  const agent = lanAgent(peer);
  return agent ? agentFetch(agent, req) : Promise.reject(new NotConnected());
}

/** A key that names where a peer is reached, for caches: its URL, or its pairing. */
export const peerKey = (peer: PeerEntry): string => (peer.lan ? `lan:${peer.id}:${peer.nodeId}` : peerUrl(peer));
