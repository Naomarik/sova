import { entryAddresses, tailnetIp } from "../mesh/address-identity";
import { getIdentity, type TailnetStatus } from "../mesh/localapi";
import type { PeerEntry } from "../mesh/peers";

/**
 * Where a gateway may dial a routed host (§mesh.public/routing): a literal tailnet IP that belongs
 * to the StableID the registry row names, never whatever the system resolver makes of a peers.json
 * name (which could point at loopback, another node, the LAN or the internet, and could change
 * between two lookups). The same literal serves the preflight and the dial.
 *
 * - Tailscale LocalAPI (the default): the addresses tailscaled's status lists for that StableID.
 * - Address identity (SOVA_MESH_IDENTITY=addresses, §mesh.peers/address-identity): the tailnet IP
 *   literal pinned in the peer's peers.json entry, and only while no other entry pins it, the
 *   same binding the peer gate trusts. An operator's pin is no StableID proof: a reassigned
 *   address is that mode's documented residual risk.
 *
 * Bounded staleness: in the default mode the answer comes from tailscaled's status as last read,
 * at most STATUS_MS (5 s) old, not a fresh check per connection. An address the control plane
 * reassigns within that window can still be dialed; the router checks it again after its
 * preflight and on every sweep, so a change cuts an open hop within about that bound.
 *
 * Anything else (no status, the node not in it, no tailnet address) is null: the hop is refused.
 * The port is the snapshot's registered ingress port, a separately bounded number; nothing here
 * proves the service on it is Sova's ingress (the peer is trusted as the same user's host).
 */

const STATUS_MS = 5000;
let cached: { at: number; status: Promise<TailnetStatus | null> } | null = null;

function status(): Promise<TailnetStatus | null> {
  if (cached && Date.now() - cached.at < STATUS_MS) return cached.status;
  const next = getIdentity()
    .status()
    .catch(() => null);
  cached = { at: Date.now(), status: next };
  return next;
}

/** IPv4 first: one choice, stable across calls. */
function pick(addresses: string[]): string | null {
  const ips = addresses.map((a) => tailnetIp(a.replace(/\/\d+$/, ""))).filter((a): a is string => !!a);
  return ips.find((a) => !a.includes(":")) ?? ips[0] ?? null;
}

/** The verified literal address to dial for `peer`, or null (refuse). */
export async function verifiedAddress(peer: PeerEntry, env: NodeJS.ProcessEnv = process.env, others: () => PeerEntry[] = () => []): Promise<string | null> {
  if (!peer.nodeId) return null;
  // The same switch server/mesh/index.ts reads (identityMode), without its per-call typo warning.
  if (env.SOVA_MESH_IDENTITY === "addresses") {
    const address = pick(entryAddresses(peer));
    const shared = others().some((p) => p.nodeId !== peer.nodeId && address !== null && entryAddresses(p).includes(address));
    return shared ? null : address;
  }
  const s = await status();
  const node = s?.peers.filter((n) => n.nodeId === peer.nodeId) ?? [];
  return node.length === 1 ? pick(node[0]!.addresses) : null;
}

/** Tests: forget the cached status. */
export const clearDestinationCache = (): void => {
  cached = null;
};
