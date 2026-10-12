# §mesh/front-door — Front door
> Part of the Sova design spec · [overview](../design/overview.md)

An optional stable address, served by a reverse proxy in front of the hosts, in an order the user
sets. It is a new address, not a host's own.

## §mesh.front-door/failover — Failover in order

The front door sends the page to the first healthy host in the user's order, moves to the next when
that host stops answering its health check, and returns when it recovers. A single slow or lost
connection never benches a healthy host: at most that one request is retried on the next host. The
cost of reusing connections: when the serving host vanishes from the network without closing them
(a kill or a partition, not a clean stop), the few requests already sent on its idle pooled
connections wait up to 35 seconds and fail; every other request reaches the next host within a few
seconds.

## §mesh.front-door/stale-tab — An open tab after failover

A tab that reconnects to a different host or a different Sova version notices it on reconnect and
offers to reload, rather than running old code against a new server. A host change is announced only
once it is confirmed, never on one request answered by another host during a network stall.

## §mesh.front-door/config — The order and the configuration

The Mesh page shows the front door's host order, which the user can change, and the reverse-proxy
configuration generated from it. The user can leave a host out of the front door (a host that can't
serve it, such as a phone); a left-out host stays listed as off, every host is in until the user
says otherwise, and the last host can't be left out. A host with no browser address
(§mesh.details/browser-access) is never in the front door: it is left out of the order and the
configuration automatically, whatever the order or the switches say, and the page lists it as "No
browser address" with no switch to put it in. Leaving out every host that has a browser address is
refused, as leaving out every host is; if a hand edit does it, the hosts with one are kept and the
configuration warns, so it never points only at hosts with none (if no host has one, all are kept
and the configuration warns). Each host in the order shows the address the front door reaches it at as a link that opens
it in a new tab, with a copy button beside it. That configuration sends to the first healthy host in order,
checks each host's health, gives up quickly on a host that stops answering new connections, reuses
idle connections to a host for a short while, and waits at most 35 seconds for a host's response
headers. When a host is addressed by a tailnet name, the configuration resolves it through the
tailnet's own resolver, so the front door's machine needs no tailnet DNS of its own. Sova only
generates the configuration; it never runs or changes the front door itself.

The configuration listens where the front door's own environment says (`SOVA_FRONT_DOOR_BIND`,
`SOVA_FRONT_DOOR_PORT`), by default port 80 on every address, so it can sit on loopback beside
another web server that owns the usual ports.
