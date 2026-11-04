# §mesh/peers — Peers
> Part of the Sova design spec · [overview](../design/overview.md)

A Sova host can know other Sova hosts on the same tailnet, its **peers**. Each host owns the
sessions on its own disk (residence = ownership); a peer is another host whose sessions and
settings this host can reach. The tailnet is the gate: there is no Sova login, no per-pair token and
no page-origin check.

So this host dials a tailnet peer only at an address Tailscale binds to that peer's node identity.
A peer named by a DNS name (its name, or the host of an `http` URL) is reached at the tailnet IP
that Tailscale lists for exactly its node (IPv4 first, the same port), never wherever the name
resolves; a node Tailscale doesn't list, or lists twice, reads as down. While Tailscale can't be
asked, the address it last gave is used. An entry's IP literal or `https` URL is dialed as written
(a non-tailnet IP only with a warning in the log), and a host in address-identity mode
(§mesh.peers/address-identity) dials the entry's own tailnet IP, else its name. Discovery probes each
node at its own tailnet address (§mesh.peers/discovery).

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
route runs. The peer listener never forwards to a third host. How the host reaches its own
Tailscale, on Linux and on a Mac, is §mesh.peers/tailscale-on-mac; while it can't, every caller is
refused.

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
- admin: renaming this host, its Browser access, settings and every other write, and reconnecting
  this host's WhatsApp sender for the peer (§app.outreach/sender-controls), which the outreach
  capability alone never allows.

Starting a session runs commands as the user, so the page says that granting sessions grants
everything else in effect, and that the finer switches matter only while sessions is off.

The logins grant also lists which logins (each provider in pi's `auth.json`, §mesh.sync/logins) go
to that peer, chosen one by one on the Mesh page. Until the user turns one off, every login goes,
including logins added later; after that, a login added later is not shared until it is chosen.
Turning a login off stops future exchanges of it
with that peer, but it cannot recall a copy the peer already holds. The page says so, and points to
logging that login out there or rotating it. A sync category the peer isn't granted is neither
served, pushed, pulled nor merged with it, in either direction. Session profiles go only to a peer
granted both settings and sessions (§mesh.sync/categories), and the settings switch says so. Sync still replicates through other
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

For guided tours, reading an owning chat's checked edition manifest or listed pictures and reading or saving its reader position use the sessions grant, as does listing a hand-off conversation's attached tours. That list shows only what that grant can already read in the transcript. Share previews, link creation and hand-off binding previews, binding and detachment require admin, like the existing share-link and organization-sharing writes: sessions access alone never authorizes exposing a tour to another audience. The share capability used for peer gateway transport is not link-minting or binding authority. Recording requests and recording-runtime controls (Revoke Site and Remove Account included) remain behind full authority, as do unknown tour operations or routes; a broad tour prefix never silently gives sessions access to those stronger actions. The host's own authenticated browser remains the operator, not a peer (§app.access/gate).

Every route and socket on the peer listener belongs to exactly one capability, and a route the
listener doesn't classify needs `full`. A request the grant doesn't cover is refused with 403 and
`X-Sova-Mesh: denied` ("refused" keeps meaning "not a peer"). Lowering a grant ends that peer's open
sockets and kept-alive connections whose capability is gone, at once. On its own initiative the host
never sends a peer what it doesn't grant it: no sync exchange, pool call, link delivery or offer,
and no name or Browser access tell. While this host's grant to a peer is anything but `full`, a
browser request it relays to that peer carries no name of this host and none of the browser's
Origin, Referer, User-Agent, Accept-Language or forwarding headers.

Grants are edited only from this host's own browser: at `/api/mesh/access`, or by Apply on a Create chat's
card (§chat.create-mode/settings-cards). No peer and no browser
relayed through another host reaches it, so a peer can never raise its own grant. A browser holding
this host's own token is the user operating this host, not a peer, and grants don't apply to it
(§app.access/gate).

A peer that answers `denied` is `hidden`, not down. It stays listed, and the host doesn't retry it
any faster than its normal cadence. A peer that withholds its sessions keeps no rows in the session
list, which says "Hidden by {host}" when filtered to it; the host menu says "hidden" beside it, and
New Session's Host choice disables it. The Mesh page shows, for each peer, what this host can
see there, as learned from that peer's answers, never from anything the peer claims.

## §mesh.peers/remote-commands — Running a command on a peer

A script on this host runs a catalogue command on a peer with `sova run <id> --host
<peer>` (or `sova --host <peer> run <id>`). The run goes through this host's `/peer/<peer>/` proxy,
as a browser's request to that peer does, to the peer listener's `POST /api/commands/<id>`, whose
body is the command's params as one JSON object. The peer looks the id up in its own catalogue and
makes exactly the request that entry's own route takes, as that peer's caller, so every check the
route has applies as it would to that request sent directly.

What it takes is what the entry's own route takes, decided by the peer's grant to this host
(§mesh.peers/grants): a peer granted `sessions` can rename one of its sessions this way but not run
one of its project verbs, which needs admin. An id the peer doesn't know, an extension's own command
(`ext.*`) included, needs `full` and then answers that there is no such command. A request whose
params would take it off the entry's own route is refused. A refusal by the peer's grant is exit 2
(refused), as it is for the entry's route. Neither the main listener nor the share listener has the
route: it is reached only on the peer listener and a dial-out pairing's connection. Without
`--host`, `sova run` is unchanged.

In a remote run, `--session` is looked up on the peer, and a path param must be absolute (a path
on this host means nothing there); list, describe and watch take no `--host`.

## §mesh.peers/tailscale-on-mac — How a host reaches its own Tailscale

Every question the host asks Tailscale (`status` and `whois`, such as for Add Peer by name, Find
Hosts, the peer listener's addresses, the caller check and dials to a peer by name) goes to this
machine's own Tailscale LocalAPI, found with no setting:

- **`SOVA_TAILSCALE_SOCKET`**, when set, wins on every platform: the host uses that socket and
  looks nowhere else.
- **Linux**, and every platform but macOS, uses `/var/run/tailscale/tailscaled.sock`, as before.
  It reads no other file and starts no program to find it, and its messages are worded as before,
  byte for byte.
- **A Mac** uses the first kind of install it finds, in this order:
  1. Tailscale's app from tailscale.com: the port its `/Library/Tailscale/ipnport` link names, on
     `127.0.0.1`, with the key in `/Library/Tailscale/sameuserproof-<port>`.
  2. The App Store app: its port and key, found with `/usr/sbin/lsof` among this account's own
     `IPNExtension` processes. The host never opens the app's group container itself, which could
     make macOS ask whether Sova may read another app's data.
  3. Homebrew or open-source `tailscaled`: the socket `/var/run/tailscaled.socket`.

  The app's files outlast the app, so when the app's port refuses the connection, the host passes
  it over for the next kind.

**Trusted only as root leaves it.** The host uses the app's files only when the `ipnport` link and
the key file are both owned by root, the link names a port from 1 to 65535, and the key file is a
plain file that no one but root can write; otherwise it passes over that kind. So another account
on the Mac can neither point Sova at a port of its choosing nor plant a key. The Homebrew socket
sits in `/var/run`, where only root can create it, and the App Store lookup reads only this
account's own processes.

**The key.** A Mac's key is sent only to `127.0.0.1`, with the request. It is never written to
disk, logged, put in a message or sent to the browser.

**After Tailscale restarts.** A restart can change Tailscale's port and key. The host picks them up
at its next request, with no restart of Sova: it reads the app's files again for every request,
keeps anything else it found (the App Store app's port and key, or the Homebrew socket) only until
Tailscale can't be reached there or refuses the key, and when either app refuses the connection or
the key, it looks again once and, if that finds something new, retries once.

**When it can't.** On a Mac, each cause has its own message, given as the reason in Add Peer's
error, in Find Hosts' error and under this host's name on the Mesh page:

- Nothing found: "Sova can't find Tailscale on this Mac. Install the Tailscale app from tailscale.com
  and sign in."
- Found, but nothing answers: "Tailscale isn't running on this Mac. Open the Tailscale app and
  connect."
- The app's key can't be read by this account, and no other kind answered: "Only an administrator
  account on this Mac can ask Tailscale who's connected. Run Sova from an administrator account."
- Tailscale refused the key, even after one fresh look: "Tailscale on this Mac refused Sova's
  request. Quit and reopen the Tailscale app."
- No answer within 2 seconds: "Tailscale on this Mac didn't answer in time. Try again."

Any other failure, such as an error answer from Tailscale, keeps its technical wording, as on Linux.

**Failing closed.** Whatever the cause, a host that can't ask its Tailscale who is calling refuses
the caller before any route runs (§mesh.peers/listener), as on Linux; no cause lets a caller in.
Only how the host reaches Tailscale differs by platform, never whom it trusts: the caller is still
the node Tailscale names, matched against `peers.json`.

**What is left.** The same risk as for Tailscale's own command-line tool on a Mac: the app's port is
an ordinary one, so while the app isn't listening on it, another account on this Mac could take
that port, receive the key and answer as Tailscale, deciding who passes the caller check while it
does. Sova doesn't run as root, so it can't check who holds the port. The window is small: it takes
a second account on this Mac acting while the app is down, and with the app down its tunnel is
down too, so no tailnet caller reaches the peer listener. Sova assumes one local user, whose own
programs can already read Sova's token.

**Only when asked.** Nothing here runs on its own, at start or on a timer: the host looks for
Tailscale only as part of a question it asks Tailscale. So with the mesh off, and no Add Peer by
name or Find Hosts, it reads no Tailscale file and starts no lookup (§mesh.peers/off).

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
never runs while the page doesn't ask for it. When the host can't ask its Tailscale, Find Hosts
suggests nothing and says why (§mesh.peers/tailscale-on-mac).

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
host, kept or derived (the reason says what to set), or the recipe's own settings are missing, and once for the whole menu, above `Mesh details…`,
when this host's build can't be named (it booted with uncommitted changes, its protocol doesn't match
its commit, or it has no commit).

A Create chat's card can start a recipe already kept, by Apply (§chat.create-mode/settings-cards): it shows
the confirm sheet's own sentences, read again whenever the page reads the card, it pins this host's commit
when it is prepared, so a chat can't name the commit, and it is refused where the menu wouldn't offer the
action. The
button opens a confirm sheet that names both commits and how far apart they are, says that the
host restarts onto this host's build and, when its details say so, how many turns are running and
workers working there that the restart stops (a warning; it never refuses), and that the job runs
from this host, so restarting this host's server stops it. Confirming deploys exactly the commit
this host booted from, never the checkout's newer `HEAD`: the request names that commit and is
refused once it is no longer this host's boot commit, and refused unless it is JSON. One job runs
per host at a time (a second is refused while one runs). The sheet follows the job: the script
running, then waiting until the host's `hello` carries this host's fingerprint, then done or failed
with the reason and the last lines of the script's output, which are also kept in
`<agent dir>/sova/mesh-resync/<host id>.log`.

Explicit recipes live in `<agent dir>/sova/mesh-resync.json`, on this host only (sync never copies it; a
Create chat's card can set one, §chat.create-mode/settings-cards), keyed
by peer id: `{"hosts": {"<id>": {"kind": "vps"}}}` runs `scripts/mesh-vps/deploy.sh --rev <commit>`
(with its own `local.env`); `{"kind": "termux", "ssh"?: "<user@host>", "sshPort"?: <n>, "args"?:
[…]}` runs `scripts/mesh-termux/deploy.sh`, which streams `git archive` of the commit over ssh into
the phone's installer with those installer arguments. A recipe names a kind and arguments, never a
shell command. A peer the file doesn't name, or with no file at all, gets a recipe derived from the
deploy scripts' own `local.env`, read from the checkout the server runs from as plain `KEY=value`
lines (never sourced or run; a missing or unreadable one gives nothing): the peer whose id is
`VPS_ID` in `scripts/mesh-vps/local.env` gets `{"kind": "vps"}`, and the one whose id is `PHONE_ID`
in `scripts/mesh-termux/local.env` gets `{"kind": "termux"}` (its deploy script takes the ssh target
from that file). An entry in the file always wins, even one left out as malformed; a file that isn't
valid JSON, or isn't `{"hosts": …}`, gives no recipes at all, derived ones included, and says why.
With no recipe, the reason under the host and the start's refusal are one sentence naming what to
set: "No resync recipe for <host> on <this host>: set VPS_ID in scripts/mesh-vps/local.env (or
PHONE_ID in scripts/mesh-termux/local.env) to <id>, or add <id> to mesh-resync.json". The routes are `/api/mesh/resync` (read) and `/api/mesh/resync/<id>` (start), on the
main listener only; the peer listener never answers them.
