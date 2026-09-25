# §mesh/peers — Peers
> Part of the Sova design spec · [overview](../design/overview.md)

A Sova host can know other Sova hosts on the same tailnet, its **peers**. Each host owns the
sessions on its own disk (residence = ownership); a peer is another host whose sessions and
settings this host can reach. The tailnet is the gate: there is no Sova login, no per-pair token and
no page-origin check.

## §mesh.peers/off — With no peer configured, nothing changes

The mesh is **on** exactly when this host's `peers.json` lists at least one peer. While it is off,
Sova behaves as it did before the mesh existed, except for the Mesh card, the `#/mesh` page and the
Mesh section of Settings: no new listening port, no Tailscale call, no timer, no outbound request, no
write to `auth.json`, to Claude Code credentials or to any settings file. Every existing route and
WebSocket answers byte-for-byte as before, protocol additions are optional fields or new types
only, and a `SessionSummary` carries no host or peer field.

## §mesh.peers/allowlist — peers.json is the allowlist

`peers.json` in Sova's state directory (mode 0600, written atomically) names this host and the
peers it trusts, by Tailscale node identity. The user curates it, from the Mesh page or by hand.
Discovery only suggests candidates; a node never becomes a peer by being on the tailnet.

## §mesh.peers/listener — The peer listener and its one check

While the mesh is on, the host opens a second listener on its tailnet address for other hosts.
Every request and WebSocket upgrade on it is checked once: the host asks its own Tailscale
LocalAPI `whois` who the caller is, and serves it only if that node is listed in `peers.json`.
A tailnet node not in the list, and any caller Tailscale cannot identify, is refused before any
route runs. The peer listener never forwards to a third host.

The serving host's own page and API (including `/peer/<id>/…`) are gated by the tailnet alone, as
before the mesh: any device that can reach one Sova host can use every peer through it. So every
Sova host must be reachable by the same devices; a host that others must not reach through it (a
shared or tagged server) does not belong in the same mesh yet.

## §mesh.peers/address-identity — Hosts without Tailscale LocalAPI

A host that can't ask Tailscale who a caller is (the Android app offers no LocalAPI) can opt into
identifying callers by address instead (`SOVA_MESH_IDENTITY=addresses`). Such a host must name its own
tailnet address (`SOVA_PEER_HOST`, tailnet addresses only), and its peer listener opens there and
nowhere else; without a valid one it stays closed. A caller is served only if its connection comes
from a tailnet address that is not this host's own and exactly one `peers.json` entry names that
address (as its name or its URL's host); that entry is the caller. Any other caller is refused before
any route runs, as with `whois`. Unset, the host uses `whois` as before.

This is weaker than `whois`: it trusts that the tailnet delivers packets only from the node that
owns their source address (the device's Tailscale VPN checks this), and if the control plane gives
a deleted node's address to a new node, the new node passes as the old peer until `peers.json` is
edited. Remove a deleted peer from `peers.json` promptly.

## §mesh.peers/hello — hello

Each host answers `hello` on its peer listener with its id, label, host name, Sova version, a
fingerprint of its wire protocol, its pi version and its clock. A peer whose fingerprint differs
is shown as `skewed`: listed, but its sessions can't be opened or created until the hosts match.

## §mesh.peers/health — Peer status

While the mesh is on, the host polls each peer's `hello` and reports each as `up`, `down` or
`skewed` with when it was last seen. A peer that stops answering is `down` after a few missed
polls; its absence never breaks this host's own sessions or pages.

## §mesh.peers/discovery — Discovery hints

On the Mesh page, on request, the host reads its Tailscale status and suggests tailnet nodes that
answer `hello`. Suggestions are never added to `peers.json` without the user's action, and discovery
never runs while the page doesn't ask for it.
