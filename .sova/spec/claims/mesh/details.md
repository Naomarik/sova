# §mesh/details — Mesh details
> Part of the Sova design spec · [overview](../design/overview.md)

What each host in the mesh is, how it is doing and what it is called, shown in one dialog while the
mesh is on.

## §mesh.details/view — The details dialog

`Mesh details…` in the host menu, and a `Mesh Details` button in the Hosts card of `#/mesh` (mesh on
only), open one dialog with a section per host, this host first. It refreshes every 5 seconds while
open (less often after failed refreshes, and not while the tab is hidden) and makes no request while
closed; a failed refresh keeps the last answer on screen under an error. A host that isn't answering
keeps what this host knows of it (connection, front door, joined) and says it isn't answering; a
host whose details came too late says it didn't answer in time; a host on an older build says
"Update this host to see its details." Each other host offers Open Directly (its own https address:
the one it serves on, else its MagicDNS name on the default serve port) or, for a phone or a host
with no address, Open Through This Host, which narrows the session list to that host. Pairing, sync,
logins and the front door stay on `#/mesh`, which the dialog links to. The dialog closes when the
mesh goes off.

## §mesh.details/fields — What each host says about itself

Each host answers for itself, over the peer listener and its gate: name, MagicDNS name and tailnet
addresses, OS and device type (phone, laptop, desktop, server; a Linux machine whose firmware names
no chassis type is a laptop if it has a battery) and model; Sova version and commit, pi and Node
versions, and whether its protocol matches this host's; Sova and machine uptime; CPU cores and load
(where the OS shows it), memory used and total, free disk where Sova keeps its data, battery and
charging (on a phone only with Termux:API; without it the dialog says how to get it); session count,
turns running and workers working; each sync category's state and last sync, and how many logins it
holds and how many are held back by a conflict (counts only). This host adds what only it knows:
round-trip time, how long the host has been up or not answering, last seen, its place in this
host's front door or that it is left out, and when it was paired ("Paired before dates were
recorded" for peers paired before this). Never a path, secret, login name or token. While the mesh
is off none of this is read and the routes answer as any unknown route does.

## §mesh.details/rename — A host's own name

A host's name is what it calls itself. Renaming this host (in the dialog or Settings → Mesh) changes
it here and tells every peer; renaming another host asks that host to rename itself, and it tells
its peers. The short id never changes. A new name carries the time it was given, by the renamed
host's clock and always later than the name before it, and a host takes it only over an older one (a
time more than a day ahead of its own clock counts as a day ahead, so a clock that ran ahead can't
lock a name); a host that missed a rename hears it once it and the renamed host reach each other
again, whichever side calls first, with no page open. A name typed for a peer on `#/mesh` keeps that
peer's time, so only a newer rename by that peer replaces it; for a peer whose clock is more than a
day ahead, its own name comes back the next time it comes up. A name a host was given before names
carried a time stays until that host is renamed. Only the peer itself can change its name on another
host (the gate's identity, never a request field). A host on an older build can't be renamed from
here, and the dialog says so.
