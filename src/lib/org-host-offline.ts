// The org page's offline-host warning (§app.organizations/host-offline): an org attached on a peer
// that is down can't serve its links, so its page says so, from the mesh's own peer state.
import type { PeerStatus } from "../../shared/protocol";

/** The warning for an org whose host is `host` (null: this host), or null when none applies. */
export function orgHostOffline(host: string | null, peers: readonly PeerStatus[]): string | null {
  if (!host) return null;
  const p = peers.find((x) => x.id === host);
  if (!p || p.state !== "down") return null;
  return `${p.label || p.id} is offline, so its links can't be opened.`;
}
