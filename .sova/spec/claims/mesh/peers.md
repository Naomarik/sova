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
Pairing a peer from the Mesh page's form also records what it may see and do here (§mesh.peers/grants),
`presence` unless the user picks more.

## §mesh.peers/listener — The peer listener and its one check

While the mesh is on, the host opens a second listener on its tailnet address for other hosts.
Every request and WebSocket upgrade on it is checked once: the host asks its own Tailscale
LocalAPI `whois` who the caller is, and serves it only if that node is listed in `peers.json`.
A tailnet node not in the list, and any caller Tailscale cannot identify, is refused before any
route runs. The peer listener never forwards to a third host.

A caller that passes this check is then held to what this host grants it (§mesh.peers/grants).

The serving host's own page and API (including `/peer/<id>/…`) are gated by the tailnet alone, as
before the mesh: any device that can reach one Sova host can use every peer through it, as far as
each peer grants that host. So a host that others must not reach through another host denies that
host what it must not reach (§mesh.peers/grants).

## §mesh.peers/grants — What each peer may see and do here

Each host decides, on its own Mesh page, what each peer may see and do on it, and its peer listener
enforces that after the identity check. Grants are per direction: what this host can see on a peer
is that peer's grant to this host, never this host's choice. So reading a peer about itself or one
of its sessions by id (the link identity probe, the peer transcript read) is only ever that peer's
grant to this host, never held to this host's own grant to that peer; the peer serves the
transcript read only to a host it grants sessions.

The grants live in `mesh-access.json` in Sova's state directory (mode 0600, written atomically),
keyed by each peer's node identity, so renaming a peer's id keeps its grant. The file is this host's
alone: it is never synced, never sent to a peer and never shown to one. A grant is a preset, with
optional per-capability switches on top:
- `full`: everything, as before grants existed.
- `sessions`: presence, sessions, links and the LLM in-flight count.
- `presence`: the peer lists this host and reads its hello and details, nothing else.
- `none`: nothing at all, hello included. The peer still passes the identity check, so it is not
  "refused".

The capabilities are:
- presence: hello, details, and this host's name and Browser access tells;
- sessions: the session list, transcripts and the chat and watch sockets, and starting and driving
  sessions, files, models and modes;
- links (§mesh/links);
- the LLM in-flight count (§app.insights/llm-inflight);
- each sync category (settings, themes, extensions, logins);
- outreach (§app.outreach/sender-route) and share (§mesh/public);
- admin: renaming this host, its Browser access, settings and every other write.

Starting a session runs commands as the user, so the page says that granting sessions grants
everything else in effect, and that the finer switches matter only while sessions is off.

The logins grant also lists which logins (each provider in pi's `auth.json`, §mesh.sync/logins) go
to that peer, chosen one by one on the Mesh page. Until the user turns one off, every login goes,
including logins added later; after that, a login added later is not shared until it is chosen.
Turning a login off stops future exchanges of it
with that peer, but it cannot recall a copy the peer already holds. The page says so, and points to
logging that login out there or rotating it. A sync category the peer isn't granted is neither
served, pushed, pulled nor merged with it, in either direction. Sync still replicates through other
hosts, each passing on what it took at its next exchange with that peer (its 5-minute reconcile, the
peer coming back up, or a settings save), so the page warns that a category can reach the peer through any other host that shares it
with that peer. The Claude login pool (§app.claude-logins/pool) goes with the logins grant: a peer
without it neither borrows from nor lends to this host, and to that peer this host reads as away.

Defaults:
- With no `mesh-access.json`, and for any peer the file doesn't list, a peer has `full`, exactly
  as before grants existed. A dial-out pairing is the exception: unlisted, or with no file, it has
  `presence` (§mesh.lan/pairing); tailnet peers are unchanged.
- A peer paired from the Mesh page's form gets the preset chosen there, `presence` by default.
- A `mesh-access.json` that exists but can't be read or parsed fails closed: every peer gets hello
  only, and the Mesh page shows the error.
- An older build ignores the file, so moving a host back to one drops its grants.

Every route and socket on the peer listener belongs to exactly one capability, and a route the
listener doesn't classify needs `full`. A request the grant doesn't cover is refused with 403 and
`X-Sova-Mesh: denied` ("refused" keeps meaning "not a peer"). Lowering a grant ends that peer's open
sockets and kept-alive connections whose capability is gone, at once. On its own initiative the host
never sends a peer what it doesn't grant it: no sync exchange, pool call, link delivery or offer,
and no name or Browser access tell. While this host's grant to a peer is anything but `full`, a
browser request it relays to that peer carries no name of this host and none of the browser's
Origin, Referer, User-Agent, Accept-Language or forwarding headers.

Grants are edited only from this host's own browser, at `/api/mesh/access`. No peer and no browser
relayed through another host reaches it, so a peer can never raise its own grant. A browser holding
this host's own token is the user operating this host, not a peer, and grants don't apply to it
(§app.access/gate).

A peer that answers `denied` is `hidden`, not down. It stays listed, and the host doesn't retry it
any faster than its normal cadence. A peer that withholds its sessions keeps no rows in the session
list, which says "Hidden by {host}" when filtered to it; the host menu says "hidden" beside it, and
New Session's Host choice disables it. The Mesh page shows, for each peer, what this host can
see there, as learned from that peer's answers, never from anything the peer claims.

## §mesh.peers/address-identity — Hosts without Tailscale LocalAPI

A host that can't ask Tailscale who a caller is (the Android app offers no LocalAPI) can opt into
identifying callers by address instead (`SOVA_MESH_IDENTITY=addresses`). Such a host must name its own
tailnet address (`SOVA_PEER_HOST`, tailnet addresses only), and its peer listener opens there and
nowhere else; without a valid one it stays closed. A caller is served only if its connection comes
from a tailnet address that is not this host's own and exactly one `peers.json` entry names that
address (as its name or its URL's host); that entry is the caller. A dial-out pairing
(§mesh/lan) never counts as such an entry. Any other caller is refused before
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
gone and back. A peer that identifies this host but grants it nothing (its hello answers `denied`,
§mesh.peers/grants) is `hidden`: reachable and not down, with nothing of it shown.

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
