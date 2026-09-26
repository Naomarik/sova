# §mesh/phone — A phone host
> Part of the Sova design spec · [overview](../design/overview.md)

A mesh host on an Android phone runs in native Termux (no proot as Sova's own host). It is installed
by one pasted command, `scripts/mesh-termux/install.sh`, which is safe to rerun, keeps everything under
`~/sova-mesh` with an isolated home, and records what it added so `scripts/mesh-termux/uninstall.sh`
removes exactly that.

## §mesh.phone/claude-store — Claude Code's login where the phone's `claude` reads it

The mesh syncs the Claude Code login into the `.claude` directory that the phone's `claude` actually
reads. A native `claude` reads the one in Sova's isolated home. When `claude` in Termux is a short
wrapper script that runs Claude Code inside a proot-distro container (`proot-distro login <distro>`,
optionally `--user <user>`, with `HOME=<home>`), the installer syncs the login into that container's
`<home>/.claude` instead, as seen from Termux; without `HOME=` in the wrapper the user's home comes from
the container's own user list. `--claude-dir` names the directory explicitly. When the wrapper can't
be read with certainty (the distro, user or home is not a plain word, the container is missing, it sets
`CLAUDE_CONFIG_DIR`, or it logs in more than once), the installer keeps the isolated home's directory
and prints a note naming `--claude-dir`.

The container's own `.credentials.json` is kept in the installer's manifest the first time. When an
already paired phone switches to the container's directory, the mesh's current login is copied in
first, byte for byte at mode 0600, before Sova starts using it, so the container's older login is never
taken for a new one or sent to other hosts. On a phone that is not paired yet, the container's login
stays and takes part in sync once the phone is paired. A later run with a different directory stops
with a message instead of switching again. Uninstalling puts the container's original
`.credentials.json` back (or removes the synced one if there was none) and leaves the rest of the
container untouched.
