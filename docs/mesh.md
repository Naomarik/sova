# Mesh: several Sova hosts as one

Run Sova on more than one machine on your [Tailscale](https://tailscale.com) tailnet and use them
from any one page: every host's sessions in one list, new sessions on the host you pick, settings,
themes, extensions and logins kept in step, and an optional front door that moves to the next host
when one goes down.

With no peer configured, nothing changes: Sova opens no extra port, makes no Tailscale call and
sends no request to another machine.

## Requirement: every host is reachable by the same devices

Sova has no login of its own. The tailnet is the gate. Any device that can open one Sova host's
page can use every peer of that host through it, because the host forwards `/peer/<id>/…` for the
page it serves.

So **every Sova host in a mesh must be reachable by exactly the same devices.** If your tailnet
policy lets a device reach one host, it must be fine for that device to use all of them. Don't add a
host that other devices must not reach through it, such as a shared or tagged server, to the same
mesh.

## How hosts trust each other

Each host keeps `peers.json` in Sova's state directory. It lists the host itself and the peers it
trusts, by Tailscale node identity. Edit it from the Mesh page (home → **Mesh**) or by hand.
Discovery on the Mesh page only suggests nodes; nothing becomes a peer by being on the tailnet.

While at least one peer is listed, the host opens a second listener for other hosts on its
tailnet address only (port 4801 by default, `SOVA_PEER_PORT`; `SOVA_PEER_HOST` picks the address).
Every request on it is checked once: the host asks its own Tailscale `whois` who is calling and
serves only nodes in its `peers.json`. Sessions never move: each one is driven by the host whose
disk holds it.

## Front door

The Mesh page generates a [Caddy](https://caddyserver.com) configuration that sends the page to
the first healthy host in the order you set, and back when it recovers. Run it behind
`tailscale serve` (never Funnel). An open tab that lands on another host says so and keeps the
session it had open on its own host.
