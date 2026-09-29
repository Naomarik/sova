import type { Socket } from "node:net";
import { canonicalIp } from "../share/security";
import { getIdentity, localApiIdentity, whoisAddr } from "./localapi";

/**
 * The caller check shared by the peer listener (§mesh.peers/listener) and the share ingress gate
 * (§mesh.public/ingress): whether a connection comes from a given node, by the caller's Tailscale
 * StableID (LocalAPI whois), or by its exact pinned address in address-identity mode
 * (§mesh.peers/address-identity, where whois itself maps one peers.json entry's address). A
 * missing, ambiguous or non-matching identity fails closed. Address identity cannot tell a
 * reassigned address's new holder from the peer: that is a residual risk, mitigated by removing
 * or re-pairing the peer promptly, never something the gate detects.
 */

/** The gateway a routed host expects, as its setting and peers.json say now. */
export interface GatewayIdentity {
  /** Its Tailscale StableID. */
  nodeId: string;
  /** Its pinned tailnet addresses, for address-identity mode (a phone): when given, the
      connection's source address must also be one of them, and an empty list admits nobody. */
  addresses?: string[];
}

// The caller's StableID per TCP connection (null: not a tailnet node), for Tailscale's own whois
// only: a connection's node never changes. Any other identity (address identity derives the
// caller from peers.json as it is now) is asked on every request, so an edit that makes an
// address ambiguous or unmapped refuses a kept-alive connection's next request too. Who is allowed
// is re-checked by the caller on every request either way.
const whoisBySocket = new WeakMap<Socket, Promise<string | null>>();

/** The caller's StableID for a connection (whois of its source address; cached per socket for
    LocalAPI), or null: not a tailnet node, ambiguous, or whois failed. */
export function callerNode(socket: Socket): Promise<string | null> {
  const stable = getIdentity() === localApiIdentity;
  let hit = stable ? whoisBySocket.get(socket) : undefined;
  if (!hit) {
    const addr = socket.remoteAddress;
    const port = socket.remotePort;
    hit =
      addr && port
        ? getIdentity()
            .whois(whoisAddr(addr, port))
            .then((w) => w?.nodeId ?? null)
            .catch((err) => {
              console.warn(`[mesh] whois ${addr}:${port} failed: ${(err as Error).message}`);
              return null;
            })
        : Promise.resolve(null);
    if (stable) whoisBySocket.set(socket, hit);
  }
  return hit;
}

/** A gate for the ingress's `admit`: true only when the connection is `expected()`'s node, read
    fresh on every call, after whois answers (a changed `via` or a removed peer refuses the next
    request at once; the ingress closes what it already admitted). null, no identity, a throw, or
    `addresses` given (even empty) without the source address among them is false. */
export function gatewayGate(expected: () => GatewayIdentity | null): (socket: Socket) => Promise<boolean> {
  return async (socket) => {
    try {
      const node = await callerNode(socket);
      const want = expected();
      if (!node || !want || typeof want.nodeId !== "string" || !want.nodeId || node !== want.nodeId) return false;
      if (want.addresses !== undefined) {
        const from = canonicalIp(socket.remoteAddress ?? "");
        if (!from || !Array.isArray(want.addresses) || !want.addresses.some((a) => canonicalIp(a) === from)) return false;
      }
      return true;
    } catch {
      return false;
    }
  };
}
