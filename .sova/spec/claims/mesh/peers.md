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
write to `auth.json`, to Claude Code credentials or to any settings file (apart from what the user
asks for in Settings → Accounts, §app.claude-logins/add-remove, which works the same with the mesh
off, and the lease a process running `claude` on an added login keeps in that login's directory,
§app.claude-logins/drain). There is no pool of Claude logins: every login on the host is its own
(§app.claude-logins/migration). Every existing route and
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
fingerprint of its wire protocol, its pi version and its clock; a build that records its boot commit
(§mesh.peers/resync) also says that commit, outside the fingerprint, so hosts on older builds still
match. A peer whose fingerprint differs
is shown as `skewed`: listed, but its sessions can't be opened or created until the hosts match.

## §mesh.peers/health — Peer status

While the mesh is on, the host polls each peer's `hello` and reports each as `up`, `down` or
`skewed` with when it was last seen. A peer that stops answering is `down` on the first
failed hello; its absence never breaks this host's own sessions or pages. A `skewed` peer
answers, so it counts as reachable wherever this host acts on a peer coming back up: every
reading of it (its hello, its session list, its own calls) agrees, and a poll never reads it as
gone and back.

## §mesh.peers/discovery — Discovery hints

On the Mesh page, on request, the host reads its Tailscale status and suggests tailnet nodes that
answer `hello`. Suggestions are never added to `peers.json` without the user's action, and discovery
never runs while the page doesn't ask for it.

## §mesh.peers/resync — Bring a peer that is behind up to this host's build

At boot a host records, in one step, the commit it runs (its `BUILD_COMMIT`, else its checkout's
`HEAD`), whether the checkout's tracked files differed from that commit, and its protocol
fingerprint, and checks that the commit's own `shared/protocol.ts` has that fingerprint. That record
names "this host's build" from then on, however the checkout moves.

In the session pane's host menu, a host on another version (`skewed`) carries a line under its
name that places its commit against this host's by this checkout's history: behind by N commits,
newer, on another branch, or not known here. Only a host that is behind gets a `Resync` button beside
it; a newer host gets the hint to update this host instead (Sova never downgrades a host from the
page). The button is disabled with its reason: under the host when this host has no recipe for that
host or the recipe's own settings are missing, and once for the whole menu, above `Mesh details…`,
when this host's build can't be named (it booted with uncommitted changes, its protocol doesn't match
its commit, or it has no commit).

The button opens a confirm sheet that names both commits and how far apart they are, says that the
host restarts onto this host's build and, when its details say so, how many turns are running and
workers working there that the restart stops (a warning; it never refuses), and that the job runs
from this host, so restarting this host's server stops it. Confirming deploys exactly the commit
this host booted from, never the checkout's newer `HEAD`: the request names that commit and is
refused once it is no longer this host's boot commit, and refused unless it is JSON. One job runs
per host at a time (a second is refused while one runs). The sheet follows the job: the script
running, then waiting until the host's `hello` carries this host's fingerprint, then done or failed
with the reason and the last lines of the script's output, which are also kept in
`<agent dir>/sova/mesh-resync/<host id>.log`.

Recipes live in `<agent dir>/sova/mesh-resync.json`, on this host only (sync never copies it), keyed
by peer id: `{"hosts": {"<id>": {"kind": "vps"}}}` runs `scripts/mesh-vps/deploy.sh --rev <commit>`
(with its own `local.env`); `{"kind": "termux", "ssh"?: "<user@host>", "sshPort"?: <n>, "args"?:
[…]}` runs `scripts/mesh-termux/deploy.sh`, which streams `git archive` of the commit over ssh into
the phone's installer with those installer arguments. A recipe names a kind and arguments, never a
shell command. The routes are `/api/mesh/resync` (read) and `/api/mesh/resync/<id>` (start), on the
main listener only; the peer listener never answers them.
