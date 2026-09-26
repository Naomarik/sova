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
the one it serves on, else its MagicDNS name on the default serve port) or, for a host with no
browser address, Open Through This Host, which narrows the session list to that host. Each host's
section shows its browser address as a link that opens it in a new tab, with a copy button beside
it that confirms "Address copied", or says "No browser address"; and a Browser access switch
(§mesh.details/browser-access), offered for this host always and for another host while it answers
on a build that has it (otherwise the dialog says why, as for a rename). Pairing, sync,
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
holds and how many are held back by a conflict (counts only); whether it has a browser address
(§mesh.details/browser-access); and whether Claude Code is found: whether the `claude` executable
the Claude Code backend would start resolves on Sova's own PATH (a Claude Code line: "Found", or
"Not found on Sova's PATH"). That is a lookup of the file only, never a run and never a model; it
is cached for a minute and never makes an answer wait (before the first lookup lands the line is
absent). This host adds what only it knows:
round-trip time, how long the host has been up or not answering, last seen, its place in this
host's front door or that it is left out, and when it was paired ("Paired before dates were
recorded" for peers paired before this). Never a path, secret, login name or token. While the mesh
is off none of this is read and the routes answer as any unknown route does.

## §mesh.details/browser-access — Whether a host has a browser address

A host's Browser access says whether a browser can open it at an address of its own. Off, the host
declares it has none: that only labels it (no port opens or closes, no listener changes, and no
address is probed). It is on unless the host's environment says `SOVA_BROWSER_ACCESS=off` (the phone
installer writes that) or the host's own setting says otherwise; the setting, once made, wins over
the environment. The setting is the host's own: changing it for this host (in the dialog) stores it
here and tells every peer; changing it for another host asks that host to change its own, and it
tells its peers. Each host records what a peer said about itself, which only that peer can change
(the gate's identity, never a request field). A host that missed the change learns it when the two
reach each other again, whichever side calls first, and from the peer's details whenever it reads
them. A setting carries the time it was made, by that host's clock and always later than the one
before, and a host takes a peer's answer only over an older one (a time more than a day ahead of
its own clock counts as a day ahead), so answers that arrive out of order, or details read before a
change, never undo it; an answer with no time (never set there, or an older build) is taken only
while no time is recorded. A peer on an older build that doesn't say is taken to have no browser address if it is a
phone. A host with none shows "No browser address" wherever its address would show, and every front
door leaves it out (§mesh.front-door/config).

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
