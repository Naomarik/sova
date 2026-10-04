# §mesh/phone — A phone host
> Part of the Sova design spec · [overview](../design/overview.md)

A mesh host on an Android phone runs in native Termux (no proot as Sova's own host). It is installed
by one pasted command, `scripts/mesh-termux/install.sh`, which is safe to rerun, keeps everything under
`~/sova-mesh` with an isolated home, and records what it added so `scripts/mesh-termux/uninstall.sh`
removes exactly that. It also records the `--node-id`, `--dns`, `--tailnet-ip`, `--port`,
`--peer-port` and `--node`/`--bun` (§mesh.phone/runtime) it was given, and a rerun without one of them uses the recorded value, so a rerun (or
`scripts/mesh-termux/deploy.sh`, which pushes a commit of the laptop's checkout over ssh) keeps the
phone's identity and ports.

## §mesh.phone/claude-store — Claude Code's login where the phone's `claude` reads it

The installer finds the `.claude` directory that the phone's `claude` actually reads and gives it to
Sova (`SOVA_SYNC_CLAUDE_DIR`). The mesh no longer syncs Claude Code's own login
(§mesh.sync/logins), so that directory holds the phone's own last-resort login and nothing is synced
into it; logins from the pool (§app.claude-logins/pool) arrive in Sova's agent dir instead and reach
`claude` as `CLAUDE_CONFIG_DIR`. Known gap: nobody has checked that such a directory (a Termux path)
reaches `claude` when it runs inside a proot-distro container. A native `claude` reads the one in Sova's isolated home. When `claude` in Termux is a short
wrapper script that runs Claude Code inside a proot-distro container (`proot-distro login <distro>`,
optionally `--user <user>`, with `HOME=<home>`), the installer picks that container's
`<home>/.claude` instead, as seen from Termux; without `HOME=` in the wrapper the user's home comes from
the container's own user list. `--claude-dir` names the directory explicitly. When the wrapper can't
be read with certainty (the distro, user or home is not a plain word, the container is missing, it sets
`CLAUDE_CONFIG_DIR`, or it logs in more than once), the installer keeps the isolated home's directory
and prints a note naming `--claude-dir`.

The container's own `.credentials.json` is kept in the installer's manifest the first time. When an
already paired phone switches to the container's directory, Sova is stopped, the mesh's current login
is copied in first, byte for byte at mode 0600, and Sova starts again using it (also when the install
fails after the stop), so the container's older login is never taken for a new one or sent to other
hosts and no refresh lands in between. On a phone that is not paired yet, the container's login
stays and takes part in sync once the phone is paired. A later run with a different directory stops
with a message instead of switching again. Uninstalling puts the container's original
`.credentials.json` back (or removes the synced one if there was none), first keeping the login the
container holds at that moment, which may be a newer one made inside it, as
`.credentials.json.sova-uninstall` at mode 0600; the rest of the container is untouched.

## §mesh.phone/share-page — The phone builds the share page

The installer builds the share page (`vite build --mode share`, into `dist-share/`) as well as the
app. Without it, a link minted on the phone and sent through a gateway would open to a 503 "The
share page is not built on this host." A rerun keeps the existing builds only when both are
present for the same source. If either build is missing, it builds both again.

## §mesh.phone/runtime — The phone runs on Bun's Android build

By default the installer downloads Bun's own Android build of the version the source's `mise.toml`
pins (`bun-linux-aarch64-android`, or `bun-linux-x64-android` on an x86_64 device) into the app's
`.bun/bin/bun` (`scripts/fetch-bun.sh`, sha256-checked against the source's
`scripts/bun-release.txt`; the previous app's copy is reused when it is that version; `unzip` is
added to its packages), names it in the service's environment (`SOVA_BUN`), and the service starts
Sova through `scripts/start-server.sh`, so it runs on Bun. Termux has no Bun package. A Bun that
cannot be installed or does not run (for example on a 32-bit phone, or on Android older than 9)
stops the installer with "could not install Bun for Android (Android 9 or later); rerun with --node
to run Sova on Node". `--node` runs Sova on Termux's `nodejs-lts` instead (`SOVA_RUNTIME=node` in
the service's environment, no Bun downloaded), and `--bun` switches back. Node stays installed
either way: pnpm, the builds and the installer's helpers run on it.

## §mesh.phone/awake — The phone keeps Sova awake

Every start of Sova on the phone, by the installer, after a crash or kill, or at boot, takes Termux's
wake lock first, so Android does not suspend Termux while Sova runs. The installer warns when the
phone's phantom-process limit is still on, since Android then kills Sova's worker processes.

## §mesh.phone/ssh — Optional key-only ssh access

With `--ssh-key`, the installer also keeps an ssh server for remote access: the key is added to the
authorized keys, password and keyboard-interactive logins are turned off (through a drop-in file when
the ssh configuration includes one, otherwise in the configuration itself with the original kept),
the configuration is checked before it is used, and the ssh server runs as a service that restarts on
its own and after reopening Termux or a reboot. An ssh server that was started by hand is replaced by
the service. A configuration the ssh server rejects is put back as it was, and the phone is never left
without an ssh server. Uninstalling undoes all of it: the key the installer added goes, password
logins are back as before, the service is disabled and an ssh server that was started by hand before
is started again. `uninstall.sh --keep-ssh` keeps the ssh server, its key, key-only logins and the
wake lock, and remembers them so the next install takes them back into its record and a later full
uninstall still removes them.
