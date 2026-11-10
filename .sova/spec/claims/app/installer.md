# §app/installer — The one-shot installer

`scripts/install.sh` installs Sova on a Mac or a Linux machine in one run, safe to pipe from curl.
It needs bash, git, Node.js (>= 22.19), curl, and unzip or python3 already there, and a pnpm that
runs or, failing that, npx to run the pnpm the repository pins (§app.installer/version-managers). Apart from the Bun the server runs on, which it
downloads into the install directory (§app.installer/bun), it installs no toolchain and no system
package, and it never uses sudo. It
clones the requested ref (§app.installer/ref) into an install directory of its own (default `~/.local/share/sova`),
installs its dependencies and builds it in a staging directory beside it, whose path its output
names (`staging in <path>`), promotes the build only
after it succeeded (the previous install kept until then, and restored on failure; with
`SOVA_KEEP_PREVIOUS=<path>` the replaced install is moved to that path instead of deleted, which is
how an upgrade from Settings keeps it until the new version answers, §app.updates/upgrade), and writes a
`sova` launcher (default `~/.local/bin/sova`). The launcher runs the server on that Bun (`sova
--node` runs it on Node instead), on `PORT` when set, else the install's port (`--port`, default
`4800`, the port its closing message names), and tells the server its own path in
`SOVA_LAUNCHER` (§app.updates/running), except `sova token`,
which prints the install's access token, and `sova app` (or `sova open`), which opens the app
already unlocked in a window of its own, starting the server first when it is not running
(§app.access/callers); its closing message says both. Beside the launcher it writes an entry in
the desktop's app launcher that runs `sova app`, which opens Sova in a window of the person's own
browser, in their own profile (§app.installer/app-entry). An install directory
that is not a clean clone of Sova, or a launcher or app entry this script did not write, is
refused and left alone.

Beyond that it links Sova's pi extensions into the agent directory (§app.installer/pi-extensions),
says what Claude Code's models need (§app.installer/claude-code-provider), and offers a login
service (§app.installer/service). Re-running it with the same inputs changes nothing
(§app.installer/idempotent). It runs on the bash and the BSD tools a stock macOS ships
(§app.installer/portable).

## §app.installer/pi-extensions — Sova's pi extensions, installed by default

Every extension in the installed clone's `pi-config/extensions/` — each directory, and each
single-file `*.ts` extension — is linked into `<agent dir>/extensions/` under its own name, by
default. The agent dir is `$PI_CODING_AGENT_DIR` when set (a leading `~` expanded), else
`~/.pi/agent`. `--no-extensions` skips this step.

- **Links, not copies.** Each entry is a symlink to `<install dir>/pi-config/extensions/<name>`.
  An update replaces the install directory under the same path, so the links follow it with no
  relinking, and pi and Sova always load the extensions of the Sova that is installed.
- **Nothing that is not ours is replaced.** A target that is a symlink into this install
  directory's `pi-config/extensions/` is ours. Anything else at a target path — a regular file,
  a directory, or a symlink to anywhere else (for example a pi-config checkout the user linked
  by hand) — is kept as it is, and the installer names it and says that extension was skipped.
- **Ours, and gone upstream.** A symlink of ours whose target no longer exists (an extension the
  new version removed) is removed.
- **No personal configuration.** It writes no `settings.json`, `models.json`,
  `keybindings.json`, `vision-delegate.json`, `auth.json` or sandbox policy, and links no
  `pi-sessions` command. `pi-config/install.sh`, which does install a whole personal setup,
  stays a separate, deliberate step.

## §app.installer/claude-code-provider — Claude Code models on first start

Sova always offers the Claude Code CLI's models (`claude-code-cli/*`); there is no switch to turn
on (§app.claude-code-provider/always-on), so the installer writes no `<agent dir>/sova/settings.json`
for it, and an existing one is never changed. A fresh install lists Claude Code models once the
`claude` CLI is installed and logged in. When extensions are installed and no `claude` is on
`PATH`, the installer says the models need it.

## §app.installer/service — An optional login service

The installer offers to run Sova as a per-user service that starts at login and restarts when it
exits: a launchd agent on macOS (`~/Library/LaunchAgents/io.github.naomarik.sova.plist`), a
systemd user unit on Linux (`~/.config/systemd/user/sova.service`, or under
`$XDG_CONFIG_HOME`). Neither needs sudo.

- **Asking.** `--service` installs it and `--no-service` does not, without asking. With neither,
  it asks on the terminal (`/dev/tty`, so a curl pipe can still answer), defaulting to no. With
  no terminal it installs none and says how to add one. A service this script installed before
  is kept and updated without asking, unless `--no-service` is given, which leaves it untouched.
- **Restarts and stops.** Both restart it whenever it exits (systemd `Restart=always`,
  `RestartSec=2`; launchd `KeepAlive`, `ThrottleInterval` 2), and a stop you ask for stays
  stopped. A stop gives the server time to finish its own work, and leaves running chats and
  their workers alone (§app.chat-processes/survives-restart): `TimeoutStopSec=90` on systemd,
  `ExitTimeOut` 60 on launchd (its cap for an agent). The
  launchd agent also runs as `ProcessType` `Interactive`, with `LANG=en_US.UTF-8`. These match
  the hand-written definitions in docs/running-as-a-service.md, except that neither runs
  `pi-config/install.sh --links` before the start: the installer links the extensions itself on
  every update (§app.installer/pi-extensions).
- **Environment.** The service runs the launcher with `PORT` (`--port`, default `4800`) and a
  `PATH` of its own, because launchd and systemd start services without the login shell's: the
  directories the installer found `node`, `git`, `pnpm` and `claude` in, `~/.local/bin`, mise's
  shims when present, Homebrew's `/opt/homebrew/bin` and `/usr/local/bin`, and the system
  directories. `PI_CODING_AGENT_DIR` is passed on when it was set. On macOS its output goes to
  `~/Library/Logs/sova.log`; on Linux, to the journal.
- **Not ours.** A file at the service path that this script did not write is refused before
  anything is installed, and left alone.
- **One instance.** Before starting a service that is not running, the installer checks the
  port; when something already listens there (for example a `sova` started by hand), it installs
  the definition, does not start it, and says so.
- **No service manager.** Where there is neither launchd nor `systemctl` (a Linux without systemd,
  a container), it asks nothing and installs none, and its closing message says only how to run
  `sova`, without the hint to re-run with `--service`; `--service` there stops the install before
  anything is written: "--service: this machine has neither launchd nor systemctl; run the launcher
  yourself (pass --no-service)."
- **No user manager.** Where `systemctl` exists but no systemd user manager answers (`systemctl
  --user show-environment` fails: no login session, say), a service it was told to install, or that
  it installed before, is written but neither enabled nor started, and the closing message says so
  with the command to start it: "service: wrote <unit path>, but there is no systemd user manager to
  load it (no login session?); start it with: systemctl --user enable --now sova.service".

## §app.installer/app-entry — An app-launcher entry that opens Sova in its own window

On Linux and macOS, every run writes, along with the `sova` launcher, an entry in the desktop's
app launcher named **Sova**, with Sova's icon, that runs `<bin dir>/sova app`: Sova opens in a
bare app window of a Chromium-family browser — no tabs, no address bar, no toolbar — already
unlocked. `--no-app-entry`
(or `SOVA_NO_APP_ENTRY=1` in the installer's environment) writes none and leaves an existing one
as it is.

- **Linux.** `${XDG_DATA_HOME:-~/.local/share}/applications/sova.desktop` (`Exec=<bin dir>/sova
  app`, `Icon=sova`, `Terminal=false`), and the install's 512px icon (`public/icons/pwa-512.png`)
  at `.../icons/hicolor/512x512/apps/sova.png`. `update-desktop-database` and
  `gtk-update-icon-cache` run after a change only when they are installed.
- **macOS.** `~/Applications/Sova.app`, a bundle (`io.github.naomarik.sova.app`) whose executable
  runs `<bin dir>/sova app`, with an icon built from the same PNG by `sips` and `iconutil` (no icon
  when either is missing). It shows no Dock icon of its own: the window it opens is the
  browser's. Its executable is a script, which macOS would start under Rosetta, and the browser
  with it; the bundle puts Apple silicon (`arm64`) first (`LSArchitecturePriority`), so both run natively. Sova
  supports Apple silicon Macs only: Intel Macs are not supported. Nothing refuses one, though: the
  installer runs there and fetches Bun's x64 build (§app.installer/bun), untested.
- **Ours, or refused.** The `.desktop` file and the bundle's `Info.plist` carry a marker. A file
  at either path that this script did not write, or any file at the icon's path while no
  `.desktop` of ours is there, is refused before anything is installed, named, and left alone, with a
  pointer to `--no-app-entry`. Ours is rewritten only when its content would change
  (§app.installer/idempotent).
- **The browser.** `sova app` picks, on Linux, the default browser (`xdg-settings get
  default-web-browser`) when it is Chrome, Chromium, Brave, Edge, Vivaldi or Helium, run as its
  `.desktop` file's `Exec` names it; else the first of `google-chrome-stable`, `google-chrome`,
  `chromium`, `chromium-browser`, `brave`, `brave-browser`, `microsoft-edge` and `vivaldi` on
  `PATH`. On macOS it picks the default https handler when it is one of Google Chrome, Chromium,
  Brave Browser, Microsoft Edge, Vivaldi or Helium, else the first of those found in
  `/Applications` or `~/Applications`. It opens `--app=http://127.0.0.1:<port>/#t=<token>` and
  passes nothing else: no profile folder, no first-run or default-browser switches, no debugging
  port. It returns while the window stays open.
- **The person's own browser profile.** The window opens in the browser's own profile, the one the
  person browses with (with several, the one the browser opens by itself), so a link clicked in
  Sova opens there, with their sign-ins and extensions. Sova's cookie lives in that profile too, so an extension there that may read local pages can
  reach Sova. A browser that is already running takes the window over; one that isn't starts as
  it usually does. Sova writes nothing into that profile and installs nothing in it: the person
  may install Sova there from the browser's own Install button, which is the browser's business,
  and `sova app` still opens the plain window. `sova app --install`, which older versions had,
  opens Sova as `sova app` does.
- **Started through macOS's launcher.** On macOS the window's browser is started by `open -n -a
  <the browser's bundle> --args --app=<that URL>`, never as a child of the launcher; without `-n`
  macOS drops the arguments when the browser already runs. macOS holds
  whatever process starts a program responsible for its microphone use, and a browser started by
  Sova's Bun is refused the mic without a prompt, so `getUserMedia` never answers. Started through
  macOS's launcher, the permission is the browser's own. When `open` fails, or the browser isn't
  inside a `.app` bundle, the executable is started directly, as on Linux. `open` says the launch
  was accepted, not that the window appeared.
- **The old Sova-only profile.** The profile older versions kept for Sova alone, and on macOS
  the browser's launcher for the app they installed in it, go to the Trash
  (§app.installer/retire-profile).
- **No such browser.** With none of them installed, `sova app` opens the same unlocked URL as a
  tab in the default browser (`open` on macOS, `xdg-open`), and the installer's closing message
  says an app window needs Chrome, Chromium, Brave, Edge or Vivaldi — only when none is found.
  Browsers installed only as a Flatpak are not found.
- **Starting the server.** When nothing answers `GET /api/health` on the port, `sova app` starts
  the server before opening the window: through the login service when the installer's is
  installed and the port is the install's (`systemctl --user start sova.service`; `launchctl
  kickstart` of the agent, or `launchctl bootstrap` when it is not loaded), else — or when that
  command fails — the launcher itself in the background, with its output in
  `<agent dir>/sova/app-server.log` and the directories the installer found its tools in added to
  its `PATH`. It waits up to 20 seconds for the health check to answer, then reads the token
  (which a first start mints) and opens the window. A server it started keeps running after the window closes. When it does
  not answer in time, or the background server exits first, it says so with where its output is —
  a desktop notification (`notify-send` on Linux, `osascript` on macOS) as well as on stderr — and
  exits nonzero, opening nothing.
- **Removing it.** Deleting the entry (`sova.desktop` and the icon, or `Sova.app`) removes
  everything it added; the uninstall steps in the docs list them.

## §app.installer/retire-profile — The old Sova-only profile, to the Trash

Older versions kept a browser profile for Sova alone (`${XDG_CONFIG_HOME:-~/.config}/sova-browser`
on Linux, `~/Library/Application Support/sova-browser` on macOS) and, on macOS, installed Sova in
it as an app, whose launcher the browser kept in `~/Applications/<browser> Apps.localized/`. Every
run of the installer (after it writes the launcher, `--no-app-entry` or not) and every `sova app`
(before it opens the window) moves them to the Trash.

- **macOS.** First each `~/Applications/*Apps.localized/*.app` whose `Info.plist` names a
  `CrAppModeUserDataDir` inside that profile, and no other launcher there (an app the person
  installed in their own profile stays), then the profile itself, only once each of those has
  moved. Each goes through macOS's own `/usr/bin/trash -s` (macOS 15 and later) when it is there
  and succeeds, else is moved into `~/.Trash`. A launcher whose profile is already gone stays.
- **Linux.** Through `gio trash` when `gio` is there and succeeds, else into
  `${XDG_DATA_HOME:-~/.local/share}/Trash/files` with its `info/<name>.trashinfo` (its original
  path and when it was moved), as the freedesktop.org trash specification lays out.
- **Names.** Where it moves them itself, a name the Trash already holds gets a dated one.
- **Not while it is in use.** While a browser runs on that profile (`pgrep -f` finds its
  `--user-data-dir`; an upgrade from Settings runs inside that old window), nothing moves, and a
  later `sova app` finishes it. With no `pgrep` to ask, nothing ever moves.
- **Quiet, and once.** It never makes the install or `sova app` fail, and says nothing. With
  nothing to move it does nothing (§app.installer/idempotent).
- **Only a run of the installer replaces the launcher.** That is a run by hand, or an upgrade
  from Settings of an installed copy (§app.updates/upgrade). An upgrade of a developer copy and a
  `git pull` run no installer, so a launcher an older version wrote keeps opening Sova in its
  Sova-only profile until the installer runs again.

## §app.installer/idempotent — Re-running changes nothing

Running the installer again with the same inputs leaves the machine as it was.

- **Same commit, no rebuild.** When the install directory already holds the commit the ref
  resolves to, with its build and dependencies in place, it is not cloned, installed or built
  again. `--reinstall` rebuilds anyway.
- **Files rewritten only when they differ.** The launcher, the app entry and its icon, the
  extension links and the service definition are written only when their content would change.
- **The service reloads only on a change.** A service whose definition is unchanged and running
  is left running; a changed definition is updated in place and reloaded; a code update restarts
  it. A second instance is never started.
- **The old Sova-only profile, once.** Once it is in the Trash, nothing is left to move, and the
  step that moved it does nothing (§app.installer/retire-profile).

## §app.installer/ref — The ref it installs

The installer installs `SOVA_REF` when set: a tag, a branch or a commit of the repository. Unset,
it installs the `stable` tag, so the published command
`curl -fsSL https://raw.githubusercontent.com/Naomarik/sova/stable/scripts/install.sh | bash`
installs the newest stable release. `stable` is the one tag that moves: each release points it at
its own numbered tag (`vX.Y.Z`), and numbered tags never move. A re-run installs the commit
`stable` points at then: the newer release once it moves forward, and the older one again when it
is moved back, each rebuilt from a fresh clone. The default is the same in every commit, so the
installer fetched from a numbered tag, or from any branch, also installs whatever `stable` points
at; installing or staying on one release takes `SOVA_REF=vX.Y.Z`, and a re-run with a branch
named updates to that branch's latest commit.

- **Checked before anything is written.** A name that is neither a tag nor a branch of the
  repository, and is not a commit (seven or more hex digits), stops the install before anything
  is written, with a message that names the ref and says to pass `SOVA_REF` (a tag, a branch
  or a commit). A hex name that turns out not to be a commit of the clone stops it before
  anything is promoted, with "nothing was changed", and leaves nothing behind: the staging
  directory goes, and so does every directory the run created for it (such as `~/.local/share`
  on a fresh machine). The launcher's directory is created only once the build succeeded. Any
  other failure before promotion cleans up the same way (pnpm's own store and cache aside, once
  pnpm ran). The default branch is never installed in a
  ref's place.
- **A repository it cannot reach** stops the install the same way, saying so.
- **The closing message names what it installed:** "installed <ref> (<short commit>) in <install
  dir>", or "<install dir> is already at <ref> (<short commit>); nothing to rebuild".

## §app.installer/version-managers — Tools behind a version manager

Node or pnpm on `PATH` may be a version manager's shim, and the repository's `mise.toml` pins tools
for developers. An installed copy runs on the user's own tools, whatever that pin says:

- **mise leaves Sova's folders alone.** Before it runs anything in the clone, the installer adds the
  staging directory and the install directory to `MISE_IGNORED_CONFIG_PATHS` for the programs it
  runs, as physical paths, after any value already set. The launcher adds the install directory the
  same way when it starts the server. So mise doesn't refuse a shim because it never approved
  Sova's `mise.toml`, and doesn't download what that file pins: a shim runs the version the user's
  own mise configuration names. Neither ever asks mise to trust a folder, so mise's trust list stays
  as it was.
- **A pnpm that runs.** pnpm counts only when `pnpm --version` succeeds in the clone. One that is on
  `PATH` but doesn't run there, such as a shim with no version set, is passed over for npx running
  the pnpm the repository pins, the same way as no pnpm at all, and the output says which of the
  two it was. With no npx either, the install stops with a message naming both, and nothing has
  changed.
- **Developer copies keep the pin.** This belongs to the installer and the launcher it writes, not
  to `scripts/start-server.sh`, so a checkout started any other way still follows `mise.toml`.

## §app.installer/portable — Stock macOS tools

The installer and the launcher it writes run on macOS's bash 3.2 and BSD userland as well as on
Linux: no GNU-only flags (`sed -i`, `readlink -f`, `stat -c`, `date -d`, `setsid`) and no bash 4
features. Its whole body is one function, called on its last line, so bash has read the whole
script before any of it runs: a curl pipe cut short runs nothing, and an early failure leaves no
unread input behind for curl to complain about.

## §app.installer/bun — The server's Bun, inside the install directory

The installer downloads the Bun release the cloned ref's `mise.toml` pins (`bun = "x.y.z"`) from
Bun's GitHub releases into `<install dir>/.bun/bin/bun`, through the clone's `scripts/fetch-bun.sh`,
and checks it against the sha256 the clone's `scripts/bun-release.txt` records for that build.
The build is chosen like Bun's own installer chooses it: macOS arm64 (also from an x64 shell under
Rosetta) or x64 (an Intel Mac, which installs but is not supported, §app.installer/app-entry), Linux x64 or aarch64, the musl build on a musl libc, the Android build in Termux,
and the `-baseline` build on an x64 CPU without AVX2. A checksum that does not match, a ref that
records no checksum for its pinned build, a machine with no such build, or a download that does
not run there stops the install before anything is promoted, with "could not install Bun; nothing
was changed". A rebuild keeps the previous install's Bun when it is still the pinned version
instead of downloading it again, and an install whose Bun is missing or not the pinned version is
rebuilt even at the same commit.

- **The launcher.** `sova` sets `SOVA_BUN` to that Bun unless the caller set one, has mise ignore
  the install directory's `mise.toml` (§app.installer/version-managers), and runs the
  clone's `scripts/start-server.sh` with its arguments, so the server runs on Bun
  (§app.server-runtime/choice). `sova --node`, or `SOVA_RUNTIME=node` in its environment, runs it
  on Node instead, with no chats or workers.
- **Why a download.** Bun lives and goes with the install directory, at the version Sova is
  tested on, with no version manager installed and no shell rc file edited.
- Its closing message names the runtime: "runtime: Bun x.y.z in <install dir>/.bun (sova --node
  runs it on Node instead)".
