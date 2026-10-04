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

The relay address must be a loopback, private (10/8, 172.16/12, 192.168/16, fc00::/7) or link-local
(169.254/16, fe80::/10) address of the relay. Sova refuses every public address, and every spelling
of "every interface", on the page, the API and in a hand-edited `peers.json`. A dial-out host
likewise never dials a relay at a public address (a relay given by name is dialed only at a
local-network address the name resolves to).

What Sova can't see: a private address that your network forwards from the internet (a router port
forward or DMZ, a cloud NIC with 1:1 NAT). Don't forward the relay port; that is the firewall's job.

## A relay on the internet (a VPS): not available yet

An internet relay waits for **a separate, unprivileged accept process**, which isn't built. The
security review requires that a public relay run its TLS handshake (which parses a stranger's
ClientHello and client certificate before any pin is known) in its own process, which hands each
pinned connection to Sova over a 0600 unix socket, so a TLS-stack bug on the public port doesn't
land in the process that holds every session, credential and shell. Today the handshake would run
inside Sova itself, so Sova refuses it: `exposure: "internet"` and every public relay address are
rejected, and the Mesh page offers no internet option.

The pieces are ready for that process (the relay listener is self-contained, and the reverse channel
takes any stream, such as a decrypted one handed over a unix socket). Until it exists, keep the VPS's
relay port closed: `scripts/mesh-vps/exposure.sh probe` with `VPS_RELAY_PORT=<port>` and
`VPS_RELAY=off` checks that it times out from the public address.

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
