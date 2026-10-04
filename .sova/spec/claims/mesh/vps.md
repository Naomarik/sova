# §mesh/vps — A VPS host
> Part of the Sova design spec · [overview](../design/overview.md)

A mesh host on a VPS is deployed from the laptop by `scripts/mesh-vps/deploy.sh` (by hand, or by a
resync from the host menu, §mesh.peers/resync), as an unprivileged user with no root step of its own,
and runs as that user's `sova-mesh` service with an isolated home and a fixed, minimal `PATH`. The new
build is installed and built beside the running one and swapped in only once it built, so a failed
build leaves the running app as it was. What needs root is done once, by an admin, from
`scripts/mesh-vps/SUDO.md` (letting the user's services run without a login, the firewall, the
tailnet's HTTPS, the public share front, and an internet relay's accept process); a deploy never
runs sudo.

## §mesh.vps/claude-code — Claude Code on the service PATH, or a warning

The deploy does not install Claude Code. It uses the deploy user's own `claude`: the one named by
`--claude-bin` or `CLAUDE_BIN` in the site settings, otherwise the one the deploy user's login shell
finds, otherwise one in a common install location such as `~/.local/bin`. That executable's directory
is added to the end of the service's `PATH`, after the bundled Node, so Sova's Claude Code models can
start `claude` on the VPS. Each deploy looks again, so a moved or newly installed `claude` is picked up
by the next deploy. When no `claude` is found, the deploy prints "Claude Code not found: claude-code
models will fail" and finishes anyway; everything else on the host works as before.

## §mesh.vps/arch — x86-64 and arm64 hosts

The VPS setup reads the host's architecture (`uname -m`) before it downloads anything. On `x86_64`
it installs the `linux-x64` Node and the `linux_amd64` Caddy builds; on `aarch64` or `arm64` the
`linux-arm64` Node and the `linux_arm64` Caddy builds. Each download is checked against its own
pinned checksum in `config.sh`. Bun's `linux-x64` or `linux-aarch64` build is fetched the same way
(§mesh.vps/runtime), checked against the deployed commit's `scripts/bun-release.txt`. On any other architecture the deploy stops before downloading,
with "unsupported architecture {name}: the VPS kit supports x86_64 and aarch64", and the running
app is left as it was.

## §mesh.vps/runtime — The VPS host runs on Bun

Each deploy installs the Bun the deployed commit's `mise.toml` pins into the new build's
`app.new/.bun/bin/bun` (`scripts/fetch-bun.sh`, sha256-checked against that commit's
`scripts/bun-release.txt`; the running build's copy is reused when it is that version), before
the dependencies are installed, so Bun swaps in and out with the app. A failed Bun install stops
the deploy with "bun: install failed: the running app is unchanged". The service's environment
names that Bun (`SOVA_BUN`), and `run-sova.sh` starts the server through `scripts/start-server.sh`,
so it runs on Bun. `SOVA_RUNTIME=node` in the site settings writes `SOVA_RUNTIME=node` into the
service's environment at the next deploy, and the host then runs on the bundled Node instead; any
other value but empty or `bun` stops the deploy before it starts. An internet relay's accept process
(§mesh.vps/internet-relay) always runs on the bundled Node, whatever `SOVA_RUNTIME` says; Bun only
bundles it at deploy.

## §mesh.vps/internet-relay — The internet relay on a VPS

- `VPS_RELAY` in the site settings is `off` (the default) or `on`, and `VPS_RELAY_PORT` is the
  relay's public port (4803 when unset; 443 works too, and the deploy warns when the public share
  front already holds 443). Any other `VPS_RELAY` stops the deploy before it starts.
- With `on`, each deploy bundles the accept process (§mesh.lan/accept-process) in the new build,
  stamped with the deployed commit, before the swap: a failed bundle stops the deploy with "relay
  accept: bundle failed: the running app is unchanged". After the swap it installs that bundle
  atomically as `~/sova-mesh/accept/relay-accept.mjs`, makes `~/sova-mesh/relay` (mode 0750, the
  user's own group) for the handoff socket, and writes `SOVA_RELAY_HANDOFF` into the service's
  environment. It warns, and still finishes, when the user's group has other members, and when the
  installed system unit is missing or differs from the one this build ships ("run SUDO.md §5 step 2
  again"). With `off`, `SOVA_RELAY_HANDOFF` is not written, so Sova has no internet relay, and an
  accept process still installed never listens.
- The accept process runs as the system user `sova-relay`, from the system unit
  `sova-relay-accept.service` that an admin installs once (SUDO.md §5, with the exact commands, their
  checks and their undo). The unit sees only the bundled Node and the bundle (read-only), the handoff
  directory, and its own state directory; it can't see the deploy user's home, the agent directory or
  any other user's files; it can't gain privileges, load kernel modules, write executable memory or
  make namespaces; it may use only IPv4, IPv6 and unix sockets, and it can't exchange a packet with
  loopback, link-local (the cloud metadata service), multicast, private, carrier-grade NAT or tailnet
  addresses; its memory is capped, and it restarts on exit. Node's permission model limits its file
  access too. A firewall rule (SUDO.md §5) also drops every new outbound connection the `sova-relay`
  user starts. Only port 443 needs a capability, and only then.
- After a deploy the accept process needs no root step: Sova tells an accept process of another build
  to exit, and its unit starts the newly installed bundle. Only a changed unit file asks for SUDO.md §5
  step 2 again.
- `scripts/mesh-vps/exposure.sh probe` with `VPS_RELAY=on` passes only if the relay port connects
  from the public address, a TLS client with no certificate gets no HTTP answer, a client with a fresh
  certificate no pairing knows gets no byte, TLS 1.2 is refused, the unit is active, and no process of
  the deploy user listens on that port. With `VPS_RELAY=off` the port must time out, as every Sova
  port does.
- Away from home, a dial-out host paired with this relay is reached from this VPS's own page (its
  `/peer/<id>/`), and from nowhere else: a relay never forwards a pairing to another host
  (§mesh.lan/as-a-peer).
