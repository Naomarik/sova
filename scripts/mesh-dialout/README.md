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
   relay" to one address of this host on that network and a port, reached from "A local network".
2. Open that port for the dial-out host's address only. With ufw, on the relay (fill in the
   interface, the dial-out host's address, the relay address and port):

   ```sh
   sudo ufw allow in on <lan-interface> from <dial-out-host-ip> to <relay-ip> port <relay-port> proto tcp comment 'sova dial-out relay'
   ```

   Remove it with `sudo ufw delete allow in on <lan-interface> from <dial-out-host-ip> to <relay-ip> port <relay-port> proto tcp`.
3. Pair: on the relay, "A dial-out host that dials this one" with the dial-out host's fingerprint; on
   the dial-out host, "A relay this host dials" with the relay's fingerprint, address and port. Check
   the two fingerprints by eye on both screens.

## A relay on the internet (a VPS): opt-in

Off by default, and nothing in Sova opens it for you. Know what it means first: whoever controls
that VPS's Sova reaches the dial-out host wherever it roams, as far as the dial-out host's grant to
the VPS allows (presence by default: hello and details only). Keep that grant low.

1. On the VPS's Mesh page: Make Fingerprint, set "This host as a relay" to the VPS's **public**
   address and a port, reached from "The internet" (a misbehaving address is then banned for 15
   minutes instead of 5).
2. Open the port on the public interface. The dial-out host roams, so this is usually open to any
   source; the pinned handshake is what refuses strangers, and the relay's admission control limits
   them (4 handshakes in progress and 10 connections a second per address, 5 failures in a minute =
   ban; 64 connections overall). With ufw on the VPS:

   ```sh
   sudo ufw allow in on <public-interface> to <vps-public-ip> port <relay-port> proto tcp comment 'sova dial-out relay'
   ```

   Record it in `scripts/mesh-vps/SUDO.md` next to the other rules.
3. Prove the exposure from the laptop: in `scripts/mesh-vps/local.env` set `VPS_RELAY_PORT=<relay-port>`
   and `VPS_RELAY=on`, then `scripts/mesh-vps/exposure.sh probe`. Every other Sova port must still
   time out; the relay port must connect, and a TLS probe without a client certificate must get no
   HTTP answer. With the relay off again, set `VPS_RELAY=off`: the port must time out.
4. Pair as on a LAN.

To turn it off: remove the VPS's dial-out pairings (the listener closes at once), press Stop
Relaying, and delete the ufw rule.

**Not built yet: a separate accept process.** The security review asks that a public relay run its
TLS handshake in a separate, unprivileged process that hands each pinned connection to Sova over a
0600 unix socket, so a TLS-stack bug on the public port doesn't land in the process that holds every
session. Today the handshake runs inside Sova itself. The pieces are ready for it (the relay
listener is self-contained, and the reverse channel takes any stream, such as a decrypted one handed
over a unix socket), but until that process exists, treat an internet relay as the higher-risk
option it is.

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
