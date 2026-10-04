# §mesh/remote-sessions — Sessions on other hosts
> Part of the Sova design spec · [overview](../design/overview.md)

A session is driven only by the host whose disk holds its file. The page you are on reaches another
host's sessions through the host that served it.

## §mesh.remote-sessions/proxy — Through the serving host

`/peer/<id>/api/…` and `/peer/<id>/ws/…` on the serving host forward to peer `<id>`'s listener with
the same path and query, so every session route works for a peer's session unchanged. WebSocket
close codes arrive exactly as the peer sent them. A peer that can't be reached is reported as
unreachable (an HTTP error before upgrade, or a close that the client retries), never as a code the
client treats as final. A peer that takes the connection but sends no answer within 30 seconds is
reported as timed out; an answer that has started is never cut off.

## §mesh.remote-sessions/list — One list across hosts

While the mesh is on, the session list shows every host's sessions together. Which host a row
belongs to is stamped by the serving host from where it fetched it, never taken from the peer's
answer. A host that is down keeps its last known rows, marked host offline, and they can't be
opened until it returns. The existing session list route is unchanged.

## §mesh.remote-sessions/host-picker — New session: Host

While the mesh is on, New Session has a **Host** choice above This Computer | Remote: where the
agent runs and the conversation is stored. It defaults to the host serving the page, labelled by
name. Down or skewed hosts are disabled with the reason. Choosing a host re-scopes folders, recent
folders, targets and models to that host. Remote keeps meaning where the tools run.

## §mesh.remote-sessions/routing — Addresses

A peer session's address carries its host (`#/s/<path>?host=<id>`; a local session's address is unchanged), so a reload or a shared link opens
it on the right host. Paths stay each host's own.

## §mesh.remote-sessions/host-scope — A peer session's pane uses its host

Everything a peer session's pane reads or changes comes from and goes to that session's host: its
models (the ones that host can run, with its own keys, favorites and model policy), its modes and
mode default, its folder index for file mentions, its attachments and image previews, and, for a
hand-off session, its baton strip: Get Link, Delete Link, Take Back, Close Session, Hand On, an
offer and its withdrawal, Extend, Retry Wrap-Up, an invitee's link, and approving or declining a
person it proposed all go to that host (the session's id names it there). Settings →
Models still edits only the host serving the page. With a Host chosen in New Session, the folder
picker lists that host's folders.

## §mesh.remote-sessions/host-filter — Filter the list by host

While the mesh is on and more than one host is known, the session pane's foot starts with a host
row, directly above the usage row: it names the current choice (`All hosts`, or a host with its
state dot), with `N/M connected` at its right end at every width (hosts answering now, this host
included, out of all hosts; a host on another version answers and counts, one that refused this
host doesn't). On a phone the foot's rows live in the sheet its bar opens
(§app.insights/sidebar-foot-phone), this one first, drawn exactly as here. The whole row is one target: a click anywhere on it opens the host
menu (upward when there is no room below; a bottom sheet on a narrow screen), and the click itself
changes no filter. The collapsed pane has no host item. The menu lists `All hosts` and then each
host by name with its dot, whose tone and word follow the host's state: up is a green dot and no
word; on another version (`skewed`) an amber dot and "other version"; not answering a red dot and
"down"; refusing this host a red dot and "refused". A host on another version also says, under its
name, where its build sits against this host's, and one that is behind has `Resync` beside it
(§mesh.peers/resync). Exactly one is chosen.
`All hosts` is the default and shows every host's sessions; a host shows only that host's sessions.
It narrows together with the text filter, and the choice is remembered across reloads; a remembered
host that is no longer known reads as `All hosts`. The menu ends with `Mesh details…`. With the
mesh off, or only one host known, nothing is shown.

## §mesh.remote-sessions/org-pages — An organization on a peer

An organization attached on a peer has pages on every host's page, as its sessions do. The sidebar's
Organizations region heads such an org with a link that carries the org's host
(`#/orgs/<id>?host=<peer>`, the host of its sessions' rows), and so do the org page's own links: its
tabs, its projects, the project overseer, its people and their pages
(`#/projects/<pid>?host=<peer>`, `#/orgs/<id>/people/<pid>?host=<peer>`), so a reload
or a shared link opens it on the right host. A standalone project on a peer is the same: its
sidebar heading and its page carry `?host=<peer>`, and its reads and acts (`/api/projects/…`) go
to that host. Every read and change such a page makes — the org, its
people, projects, decisions, conflicts, the project overseer and its settings, ideas, to-dos and
worktrees, the models its session pickers offer, starting a hand-off session, a person's links and
preview, Commit Now and the remote — goes to that host through `/peer/<id>/api/…`, which answers
exactly as it answers its own page. Where such a page names a host, it names that one: a project
paused by an attach reads "Paused at L0 on <peer>" and "This organization was attached on <peer>
…", the daily limits "Resets at midnight on <peer>.", and a decision whose session isn't there says
it isn't on <peer>. A local org's addresses and
words are unchanged. `#/orgs` still lists this host's orgs only.

## §mesh.remote-sessions/never-cached — A peer's answers are never cached

The page's service worker leaves everything under `/peer/` to the network, as it does `/api/` and
`/ws`: a peer's API reads, its sockets and anything else there are neither answered from the
worker's cache nor stored in it, so every read shows what the peer says now (a second New Link
shows the new link, a strip re-read after an action shows its result). A browser whose worker
stored peer answers under an earlier version drops that whole cache when the new worker activates.
The share pages (`/h/`, `/i/`) are served only by the share listener, on its own origin, which this
worker never controls.

## §mesh.remote-sessions/head-host — A peer session's head names its host

A peer session's head starts its meta line with the host, `on <peer> · <folder> · …`, titled "This
session lives on <peer>". When the line is too narrow (a 390px phone), the folder gives way first:
the host keeps its whole name unless that name alone is longer than half the line.
