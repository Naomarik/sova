# Dial-out pairings: operator notes

A host that isn't on your tailnet (a laptop that roams) can still join the mesh as a **dial-out
host**: it connects out to a **relay** (any Sova host you choose) over mutually pinned TLS 1.3. The
relay never needs to reach the dial-out host. Pairing is done on each host's Mesh page, by pasting
the other side's fingerprint; what each side may see and do on the other is that side's grant
(Hosts → "What X can see here"), presence by default. Spec: `§mesh/lan`.

Two connections run per pairing, told apart by ALPN:

- `answer`: the relay asks, the dial-out host answers (its sessions on the relay's page, through
  `/peer/<id>/`).
- `ask`: the dial-out host asks, the relay answers through its peer gate and its grant for that host.

A relay listens only while at least one dial-out host is paired with it, on the one address set on
its Mesh page, never on every interface.

## A relay on a local network

1. On the relay's Mesh page, under Dial-out pairings: Make Fingerprint, then set "This host as a
   relay" to one address of this host on that network and a port.
2. Open that port for the dial-out host's address only. With ufw, on the relay (fill in the
   interface, the dial-out host's address, the relay address and port):

   ```sh
   sudo ufw allow in on <lan-interface> from <dial-out-host-ip> to <relay-ip> port <relay-port> proto tcp comment 'sova dial-out relay'
   ```

   Remove it with `sudo ufw delete allow in on <lan-interface> from <dial-out-host-ip> to <relay-ip> port <relay-port> proto tcp`.
3. Pair: on the relay, "A dial-out host that dials this one" with the dial-out host's fingerprint; on
   the dial-out host, "A relay this host dials" with the relay's fingerprint, address and port. Check
   the two fingerprints by eye on both screens.

A LAN relay's address must be a loopback, private (10/8, 172.16/12, 192.168/16, fc00::/7) or link-local
(169.254/16, fe80::/10) address of the relay. Sova refuses every public address for it, and every spelling
of "every interface", on the page, the API and in a hand-edited `peers.json`. A dial-out host
likewise never dials a relay at a public address unless that pairing is marked as on the internet
(a relay given by name is dialed only at a local-network address the name resolves to).

What Sova can't see: a private address that your network forwards from the internet (a router port
forward or DMZ, a cloud NIC with 1:1 NAT). Don't forward a LAN relay's port; that is the firewall's job.

## A relay on the internet (a VPS)

Sova itself never listens on a public address. An internet relay's port belongs to a separate
**accept process** that runs as its own system user (`sova-relay`), sandboxed by its systemd unit
(no access to Sova's files, no loopback, tailnet, private or link-local address, no privileges). It
checks the dial-out host's certificate against the pairings Sova gives it, then passes the
still-encrypted connection to Sova over a unix socket; Sova runs the usual pinned TLS 1.3 handshake
inside it, end to end with the dial-out host, and checks that the host it proves is the one the
accept process vouched for. A compromised accept process learns when and from where a pairing
connects and can cut it off; it can't read, change or inject anything, or pose as either side.

1. Deploy with `VPS_RELAY=on` (`scripts/mesh-vps/local.env`), then have an admin run
   [SUDO.md §5](../mesh-vps/SUDO.md) once: the user, the unit, the firewall.
2. On the VPS's Mesh page (its tailnet address): Make Fingerprint, pair the dial-out host ("A
   dial-out host that dials this one"), then set "This host as a relay" to "Reached from: The
   internet", the VPS's public address and port 4803. The page offers the internet only while the
   accept process runs.
3. On the dial-out host: pair "A relay this host dials" with the VPS's fingerprint, its public
   address (or a name) and port, and check "This relay is on the internet". Only that pairing may
   dial a public address; every other pairing keeps the local-network rule.
4. From your machine: `VPS_RELAY=on scripts/mesh-vps/exposure.sh probe` must PASS.

Away from home the dial-out host is reached from the VPS's own page (`/peer/<id>/` there), never
through another host: a relay doesn't forward a pairing.

What stays with you: whoever controls the VPS (its Sova, its user, root, the provider) can reach the
dial-out host wherever it roams, as far as the dial-out host's grant to the VPS allows (`sessions` is a
shell). A work laptop's policy may forbid a persistent connection to a personal server. Networks that
block the port, or inspect TLS, can't reach the relay (the pin never falls back), and the pairing then
reads "timed out" with a hint. A large flood can keep the dial-out host out for a while; admission
only limits each source.

## Testing against a real macOS host

`mac-e2e.mjs` runs from the relay machine against a Mac on the same network. It never touches either
machine's live Sova or `~/.pi`: the Mac gets a scratch checkout of this commit, and both servers are
throwaway hermetic ones.

```sh
cp scripts/mesh-dialout/local.env.example scripts/mesh-dialout/local.env   # then fill it in
# open RELAY_PORT on this host for the Mac's address (the ufw rule above)
node scripts/mesh-dialout/mac-e2e.mjs            # ~3-5 min; --keep leaves the Mac's scratch dir, --skip-tests skips the unit tests there
```

It runs the transport's unit tests on the Mac on Bun and Node, then pairs the Mac (dial-out host)
with a relay here and checks both channels, the default presence grant, each direction under its
grant, the hardened `/peer` answer, and that unpairing on the relay drops the Mac's connections
within seconds. Exit 0 only when every check passed.
