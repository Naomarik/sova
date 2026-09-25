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

## §mesh.remote-sessions/host-filter — Filter the list by host

While the mesh is on and more than one host is known, the session pane shows a host filter
directly below the filter input: one row of chips, `All` and then each host by name, each host
with a dot for whether it is up or down. Exactly one chip is chosen. `All` is the default and shows
every host's sessions; a host shows only that host's sessions. It narrows together with the text
filter, and the choice is remembered across reloads; a remembered host that is no longer known
reads as `All`. With the mesh off, or only one host known, the filter is not shown.
