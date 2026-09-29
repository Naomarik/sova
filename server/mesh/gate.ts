import type { Socket } from "node:net";

/**
 * The share ingress gate (§mesh.public/ingress): whether a connection to a routed host's ingress
 * comes from its `via` gateway, by the caller's Tailscale StableID (LocalAPI whois), or by its
 * exact pinned address in address-identity mode (§mesh.peers/address-identity). A missing,
 * ambiguous or non-matching identity fails closed. Address identity cannot tell a reassigned
 * address's new holder from the peer: that is a residual risk, mitigated by removing or re-pairing
 * the peer promptly, never something the gate detects.
 *
 * Frozen here for the milestones that build on it; until the reviewed implementation lands,
 * callerNode knows nobody and every gate admits nobody.
 */

/** The gateway a routed host expects, as its setting and peers.json say now. */
export interface GatewayIdentity {
  /** Its Tailscale StableID. */
  nodeId: string;
  /** Its pinned tailnet addresses, for address-identity mode (a phone). */
  addresses?: string[];
}

/** The caller's StableID for a connection (LocalAPI whois of its source address, cached per
    socket), or null: not a tailnet node, or whois failed. The peer listener's check, shared. */
export function callerNode(socket: Socket): Promise<string | null> {
  void socket;
  return Promise.resolve(null);
}

/** A gate for the ingress's `admit`: true only when the connection is `expected()`'s node, read
    fresh on every call (a changed `via` or a removed peer refuses the next request at once; the
    ingress closes what it already admitted). null, or no identity, is false. */
export function gatewayGate(expected: () => GatewayIdentity | null): (socket: Socket) => Promise<boolean> {
  return async (socket) => {
    void socket;
    void expected;
    return false;
  };
}
