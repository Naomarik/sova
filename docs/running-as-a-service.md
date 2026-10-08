# Running Sova as a service, on Bun or Node

[← Sova](../README.md)

This page is for running a **checkout** of Sova: choosing its runtime, and keeping it up with a
systemd user unit or a launchd agent you write yourself. If you installed with
`scripts/install.sh`, you don't need it: the installer's `--service` flag (or yes at its prompt)
installs its own login service, `~/.config/systemd/user/sova.service` on Linux or
`~/Library/LaunchAgents/io.github.naomarik.sova.plist` on macOS. It restarts and stops like the
definitions below (`Restart=always`, `TimeoutStopSec=90`; on macOS `KeepAlive` and
`ExitTimeOut` 60), runs the installed `sova` launcher, and has no `--links` step: the installer
links the extensions itself on every update. It needs launchd or a systemd user manager: with no
`systemctl` (a container, WSL1, a minimal distro), `--service` stops with an error; with no user
manager running (a container, an SSH login without lingering), it writes the unit and prints the
command to start it. On Linux the unit below has the same name, so use one or the other, not both.

## Bun or Node

The server runs on [Bun](https://bun.sh) 1.4.2 (pinned in `mise.toml` beside Node). It runs on
Node only when you ask for it. What differs between the two, and how Sova handles it, is in
[docs/bun-quirks.md](bun-quirks.md).

From a checkout:

```sh
scripts/start-server.sh                # Bun (what `pnpm start` runs)
scripts/start-server.sh --node         # Node, on request
SOVA_RUNTIME=node pnpm run dev:server  # the dev watcher (and dev:hermetic) on Node
bun server/index.ts                    # Bun, directly
node --import tsx server/index.ts      # Node, directly
```

**Asking for Node.** Only `SOVA_RUNTIME=node` in the environment, or `--node` as the launcher's
first argument, starts Node; anything else starts Bun. No setting file is read (a
`~/.pi/agent/sova/runtime.json` from an earlier version is ignored). The launcher finds Bun as
`$SOVA_BUN`, else `bun` on `PATH`, else `mise which bun`. If there is no Bun, it prints why and
exits with an error: it never starts Node instead. A Bun server that fails to start fails like
any other. The launcher replaces itself with the server (`exec`), so a service manager watches the
server process itself. The unit tests follow the same switch: `pnpm test` runs on Bun, and
`pnpm run test:node` (or `SOVA_RUNTIME=node pnpm test`) on Node.

**Check what runs:** `curl -s http://127.0.0.1:4800/api/health` answers
`"runtime": {"name": "bun", "version": "1.4.2", "chosen": "bun"}`.

## A systemd user service (Linux)

Save this as `~/.config/systemd/user/sova.service`, with
`%h/path/to/sova` replaced by your checkout's path under your home directory:

```ini
# sova: the Sova web server — backend on 127.0.0.1:4800, plus the pi runtimes it hosts.
#
# Restarting it is `systemctl --user restart sova.service` and nothing else. A stop you asked for
# stays stopped (Restart=always does not resurrect an intentional stop).

[Unit]
Description=Sova (pi coding agent webapp) — backend on 127.0.0.1:4800

[Service]
Type=simple
WorkingDirectory=%h/path/to/sova
# Link any newly merged pi extension into ~/.pi/agent/extensions before the runtimes load them
# (links only: no settings, config or policy). An unlinked sibling breaks the extension that
# imports it. The leading `-` means a linking failure never blocks the start.
ExecStartPre=-%h/path/to/sova/pi-config/install.sh --links
# Bun (the launcher execs the server, so it is this unit's main process). For Node, add --node
# (or Environment=SOVA_RUNTIME=node).
ExecStart=%h/path/to/sova/scripts/start-server.sh
# The server spawns `sh`, `git` and `ssh` by name and resolves the Claude CLI, and the launcher
# runs `node` (and `bun`) by name, so PATH is set explicitly: at login the user manager has no
# graphical-session environment to inherit it from. Put your node and bun directories first if
# they aren't mise's.
Environment=PATH=%h/.local/share/mise/shims:/usr/local/bin:/usr/bin:/bin
Restart=always
RestartSec=2
# A stop drains hosted chat runtimes and their subagent workers before it exits, which can take a
# while; SIGKILLing it early would kill workers mid-task.
TimeoutStopSec=90

[Install]
WantedBy=default.target
```

Then `systemctl --user daemon-reload && systemctl --user enable --now sova.service`.

**Switch to Node** by adding `--node` to `ExecStart` (or `Environment=SOVA_RUNTIME=node`), then
`systemctl --user daemon-reload && systemctl --user restart sova.service`, then check
`/api/health` as above. Remove it the same way to go back to Bun. If the server doesn't start (no
Bun found, or Bun failing at boot), the reason is on the unit's journal
(`journalctl --user -u sova.service`).

## A launchd agent (macOS)

The same service as a LaunchAgent: save this as
`~/Library/LaunchAgents/sova.plist`. launchd expands neither `~` nor `$HOME`, so replace
`/path/to/sova` with your checkout's absolute path and `/path/to/your-home` with your home directory's.
The label is the systemd unit's name without `.service`: a project whose slot 0 adopts `sova.service`
reads, and restarts through its gate, the agent `sova` on macOS.
Sova's own `.sova/project.json` adopts `sova-runtime.service`, so for Sova hosting itself name both
the label and the file `sova-runtime`.

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>sova</string>
  <!-- ExecStartPre's twin (link newly merged pi extensions; a failure never blocks the start), then
       the launcher, which execs the server: launchd's pid is the server's. -->
  <key>ProgramArguments</key>
  <array>
    <string>/bin/sh</string>
    <string>-c</string>
    <string>"$0"/pi-config/install.sh --links || true; exec "$0"/scripts/start-server.sh</string>
    <string>/path/to/sova</string>
  </array>
  <key>WorkingDirectory</key><string>/path/to/sova</string>
  <!-- The launcher runs `node` (and `bun`) by name; launchd's default PATH has neither. -->
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>/path/to/your-home/.local/share/mise/shims:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
    <key>LANG</key><string>en_US.UTF-8</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <!-- Restart=always: `launchctl bootout` is the stop you ask for. -->
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>2</integer>
  <!-- TimeoutStopSec: a stop drains hosted runtimes and workers (launchd's default is 20 s, and it
       caps an agent's at 60 s). -->
  <key>ExitTimeOut</key><integer>60</integer>
  <!-- No App Nap timer throttling for a server. -->
  <key>ProcessType</key><string>Interactive</string>
  <key>StandardOutPath</key><string>/path/to/your-home/Library/Logs/sova.log</string>
  <key>StandardErrorPath</key><string>/path/to/your-home/Library/Logs/sova.log</string>
</dict>
</plist>
```

Then `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/sova.plist`. Restart it with
`launchctl kickstart -k gui/$(id -u)/sova` and stop it with `launchctl bootout gui/$(id -u)/sova`;
`launchctl print gui/$(id -u)/sova` shows its state and pid. Its output goes to the log file, which
launchd never rotates. **Switch to Node** by adding `SOVA_RUNTIME=node` to `EnvironmentVariables`,
then `bootout` and `bootstrap` again.
