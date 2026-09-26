# mesh-termux: a Sova mesh host on an Android phone (native Termux, milestone M6)

One pasted command in Termux (F-Droid/GitHub or the current Google Play build; no proot, no root):

    curl -fsSL https://raw.githubusercontent.com/Naomarik/sova/master/scripts/mesh-termux/install.sh | sh

Another ref or tag: `…/sova/<ref>/scripts/mesh-termux/install.sh | sh -s -- --ref <ref>`. To test before a push,
`--source-url <tar.gz>` takes any curl URL (a tarball served over the tailnet, `file://…`). Rerunning converges: same
source = no rebuild and no restart. Options are listed at the top of `install.sh`.

Remove everything it added (default), or keep sshd, its key and the wake lock for remote test loops:

    sh ~/sova-mesh/uninstall.sh [--keep-ssh]

## What install.sh does

- Packages: `nodejs-lts` (24.x, Sova needs >= 22.19), `ripgrep` and `fd` (pi's grep/find tools, Sova's file tools), `git`,
  `tmux`, `termux-services` (runit), plus their new dependencies; `--ssh-key` adds `openssh`. Every other command the
  scripts or Sova run comes with Termux's bootstrap; one that is missing from `$PREFIX/bin` anyway (removed, or only
  Android's `/system/bin` copy, e.g. `gzip`) gets its package installed too (install.sh's `TOOLS` table). The tools it
  needs before apt runs (dpkg, apt, coreutils, gawk, grep, sed, termux-tools; net-tools unless `--tailnet-ip`) are
  checked first, naming the package. Never `pkg upgrade`; debs are cached inside `~/sova-mesh`. What was installed
  before the first run is recorded, and only what the installer added is ever removed.
- pnpm: `corepack pnpm@11.27.1`, cached inside `~/sova-mesh`. Termux has no pnpm package, and the pinned pnpm 12 is a native
  binary whose store lock fails on Android (`lock_shared() not supported`). pnpm 11 installs the same lockfile
  unchanged (`--frozen-lockfile`).
- `~/sova-mesh` (0700): `app/` (the source tarball; `pnpm install`, `vite build` on the phone; `app.prev` = the previous
  build), `agent/` (PI_CODING_AGENT_DIR from `scripts/hermetic-agent-dir.mjs`; `auth.json` starts as `{}` and logins, subscriptions
  included, arrive by mesh sync; `sova/peers.json` is seeded once with the self id and no peers, so the mesh is off),
  `home/` (isolated HOME; `home/.claude` (0700) is Claude Code's store, synced by the mesh via `SOVA_SYNC_CLAUDE_DIR`), `tmp/` (TMPDIR; jiti's extension cache, warmed at every service start), `sova-mesh.env`,
  `bin/run-sova`, `uninstall.sh`, `.install/` (the manifest).
- Claude Code in a proot-distro container: when `$PREFIX/bin/claude` is a short wrapper script that runs
  `proot-distro login <distro> [--user <user>] … -- env HOME=<home> … claude`, that claude reads the container's
  `<rootfs><home>/.claude`, so the mesh syncs the login there instead (`SOVA_SYNC_CLAUDE_DIR`; `--claude-dir` overrides,
  as seen from Termux). The distro, user and HOME must be plain words (HOME from the container's passwd when the wrapper
  sets none); anything else keeps `home/.claude` and prints a note. The container's own `.credentials.json` is kept in the
  manifest. On a host that is already paired, switching stops Sova, copies the mesh's current login in first, byte for
  byte, and starts Sova again (also when the install fails after the stop), so the container's older login never reaches
  the mesh. Nothing else in the container is touched.
- Listeners: main `127.0.0.1:4800` only. Peer listener `<tailnet IP>:4801`, only while peers.json lists a peer. The
  tailnet IP is read from `tun*` (`--tailnet-ip` overrides), because Termux can't reach Tailscale's LocalAPI. Nothing
  binds 0.0.0.0 or the Wi-Fi address; the installer proves it by connecting.
- Caller identity without LocalAPI: `SOVA_MESH_IDENTITY=addresses`. The phone knows a caller by its tailnet source IP,
  and that IP must match exactly one peers.json entry. So every entry on the phone needs its StableID (`nodeId`) AND its tailnet
  IP as `name` or as the `url` host (e.g. `http://100.x.y.z:4801`); a MagicDNS name alone never matches. Other hosts
  authenticate the phone as usual (LocalAPI whois → the phone's StableID). `--node-id`/`--dns` give the phone's own
  hello its StableID and name.
- runit service `$PREFIX/var/service/sova-mesh` (restarts on exit; log `$PREFIX/var/log/sv/sova-mesh/current`),
  `~/.termux/boot/sova-mesh` (Termux:Boot: wake lock + start services after a reboot), `termux-wake-lock`.
- It never touches /sdcard and never prints a secret. It writes nothing outside `$HOME` and `$PREFIX`.

## Manual steps on the phone (the installer prints them)

1. Developer options → *Disable child process restrictions* (Android 14+). Without it Android kills Sova's workers.
2. Apps → Termux → Battery → Unrestricted; the same for Tailscale.
3. Tailscale → split tunneling: Termux must not be excluded.
4. Install Termux:Boot (same source as Termux) and open it once, for start after a reboot.

## What uninstall.sh leaves

The Claude Code login inside a proot-distro container goes back to what it was before the install (removed if there was
none); the login it held at uninstall (a newer one may have been made inside the container) is kept beside it as
`.credentials.json.sova-uninstall` (0600). The rest of the container is untouched.

apt's package lists and apt/dpkg logs, and any pre-existing package that was upgraded as a dependency (the manifest
lists them; none on the test phone). Without `--keep-ssh` it releases the Termux wake lock, which Termux shares with
anything else that took it.

## Testing from the laptop

`phone-test.sh` (ssh to the phone's Termux sshd on 8022; site values in the untracked `local.env`, see
`local.env.example`): `deps` = every command word of install.sh/uninstall.sh (plus Sova's runtime tools and
phone-test's own) that is an executable on the phone maps, by `dpkg -S`, to WANT's closure or Termux's bootstrap, non-essential
bootstrap ones are in `TOOLS`, and `apt-get install -s` resolves WANT. `loop` = uninstall first if installed, snapshot, install, check (health, SPA, listeners by
connect since the phone has no ss/netstat for apps, runit restart after `kill -9`, logger), gate (mesh on with a
placeholder peer: a non-peer tailnet node, the phone itself and a Wi-Fi source get 403 and `[mesh] refused` lines;
back to mesh off), uninstall, snapshot, diff (must be clean), install, check. `INSTALL=github` uses the real
one-liner (`GH_REF`, default master), otherwise a tarball of HEAD (or `REV=<sha>`) goes over ssh. `UNINSTALL=full`
runs the default uninstall and takes the wake lock again for the ssh loop; the default keeps ssh. `install-http` runs
`curl | sh` with both files served from the laptop's tailnet IP for the run only. `pair`/`unpair` need `PAIR_GO=1`.
`dry-packages` (no phone) runs install.sh's package section against a fake dpkg/apt: a rerun that needs apt must never
record a package the user installed since an earlier run (a full uninstall would purge it). `dry-claude` (no phone)
runs install.sh's Claude Code store block against fake `claude` wrappers and rootfs trees (native, proot, unclear ones,
the paired switch and its rerun) and uninstall.sh's restore.
