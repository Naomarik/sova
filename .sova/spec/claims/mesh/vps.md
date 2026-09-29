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
