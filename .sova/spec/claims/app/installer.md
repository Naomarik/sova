# §app/installer — The one-shot installer

`scripts/install.sh` installs Sova on a Mac or a Linux machine in one run, safe to pipe from curl.
It needs git and Node.js (>= 22.19) already there, and pnpm or, failing that, npx to run the pnpm
the repository pins. It installs no toolchain and no system package and never uses sudo. It
clones the requested ref into an install directory of its own (default `~/.local/share/sova`),
installs its dependencies and builds it in a staging directory beside it, promotes the build only
after it succeeded (the previous install kept until then, and restored on failure), and writes a
`sova` launcher (default `~/.local/bin/sova`). An install directory that is not a clean clone of
Sova, or a launcher this script did not write, is refused and left alone.

Beyond that it links Sova's pi extensions into the agent directory (§app.installer/pi-extensions),
switches on the Claude Code provider (§app.installer/claude-code-provider), and offers a login
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

Sova offers the Claude Code CLI's models (`claude-code-cli/*`) only while its experimental
Claude Code provider switch is on (Settings, stored in `<agent dir>/sova/settings.json`). When
extensions are installed and that file does not exist, the installer writes it with the switch
on (`{"version": 1, "experimental": {"claudeCodeProvider": true}}`), so a fresh install lists
Claude Code models once the `claude` CLI is installed and logged in. An existing file is the
user's choice and is never changed. When no `claude` is on `PATH`, the installer says the models
need it.

## §app.installer/service — An optional login service

The installer offers to run Sova as a per-user service that starts at login and restarts when it
exits: a launchd agent on macOS (`~/Library/LaunchAgents/io.github.naomarik.sova.plist`), a
systemd user unit on Linux (`~/.config/systemd/user/sova.service`, or under
`$XDG_CONFIG_HOME`). Neither needs sudo.

- **Asking.** `--service` installs it and `--no-service` does not, without asking. With neither,
  it asks on the terminal (`/dev/tty`, so a curl pipe can still answer), defaulting to no. With
  no terminal it installs none and says how to add one. A service this script installed before
  is kept and updated without asking, unless `--no-service` is given, which leaves it untouched.
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
- Where neither launchd nor a systemd user manager is available, it says so and installs none.

## §app.installer/idempotent — Re-running changes nothing

Running the installer again with the same inputs leaves the machine as it was.

- **Same commit, no rebuild.** When the install directory already holds the commit the ref
  resolves to, with its build and dependencies in place, it is not cloned, installed or built
  again. `--reinstall` rebuilds anyway.
- **Files rewritten only when they differ.** The launcher, the extension links, the provider
  switch and the service definition are written only when their content would change.
- **The service reloads only on a change.** A service whose definition is unchanged and running
  is left running; a changed definition is updated in place and reloaded; a code update restarts
  it. A second instance is never started.

## §app.installer/portable — Stock macOS tools

The installer and the launcher it writes run on macOS's bash 3.2 and BSD userland as well as on
Linux: no GNU-only flags (`sed -i`, `readlink -f`, `stat -c`, `date -d`, `setsid`) and no bash 4
features. It is read whole before it runs, so a curl pipe cut short runs nothing.
