# §mesh/vps — A VPS host
> Part of the Sova design spec · [overview](../design/overview.md)

A mesh host on a VPS is deployed from the laptop by `scripts/mesh-vps/deploy.sh` (by hand, or by a
resync from the host menu, §mesh.peers/resync), as an unprivileged user with no root step of its own,
and runs as that user's `sova-mesh` service with an isolated home and a fixed, minimal `PATH`. The new
build is installed and built beside the running one and swapped in only once it built, so a failed
build leaves the running app as it was.

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
other value but empty or `bun` stops the deploy before it starts.
