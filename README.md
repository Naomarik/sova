<p>
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/brand/sova-mark-dark.svg">
    <img src="docs/brand/sova-mark-light.svg" alt="" width="72" height="72">
  </picture>
</p>

# sova

**Run pi sessions side by side. Stop juggling terminals.**

Send one prompt to several models, compare their approaches, and branch the conversation worth
pursuing. Sova gives your [pi](https://pi.dev) coding agent a browser interface—from a full desktop
workspace to your phone—using the sessions you already have.

It runs on your machine alongside pi. Read the tool calls, inspect the diffs, and follow the
work without digging through terminal scrollback. Your existing setup stays yours.

## Get started

Requires Git, Node.js ≥22.19, and pnpm (without pnpm, the installer runs it through npx).

```sh
curl -fsSL https://raw.githubusercontent.com/Naomarik/sova/vNEXT/scripts/install.sh | bash
```

Then run `sova`, and `sova open` to open **http://127.0.0.1:4800** already unlocked. Uses your
existing pi provider login.
[First-time login or command not found?](docs/getting-started.md)

## Run on Bun (or Node)

The server runs on [Bun](https://bun.sh) 1.4.2 (pinned in `mise.toml` beside Node). It runs on
Node only when you ask for it. What differs between the two, and how Sova handles it, is in
[docs/bun-quirks.md](docs/bun-quirks.md).

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

**As a systemd user service (Linux).** Save this as `~/.config/systemd/user/sova.service`, with
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

**As a launchd agent (macOS).** The same service as a LaunchAgent: save this as
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

## More work, less window switching

- **Hand the work to subagents.** In Delegate mode the agent orchestrates: it sends planning,
  investigation, routine changes, and complex changes each to the model you routed it to, with a
  fallback. A subagent profile keeps those routes under one name, set in Settings → Subagents. The
  shipped routes use Claude Code models, so install the `claude` CLI or pick your own. From the
  [mode](pi-config/extensions/mode/README.md) and [subagents](pi-config/extensions/subagents/README.md)
  extensions, which the installer links.
- **Follow every worker.** Workers and coordinated teams open in a side pane, each with its own
  transcript and how full its context is.
- **Agree on the plan before anything gets built.** With align on, the agent records each agreement
  as an alignment: findings, approach, rejected alternatives, and open questions with its
  recommendations. An experimental adversarial review (Settings → Experimental) has a fresh,
  read-only reviewer check the plan and the finished diff.
- **Work in worktrees. Read every change.** A session tracks the git worktrees it works in; ask it to
  create, merge, or drop one, and each merge lands as a card. The changes viewer shows what a session
  or worktree changed, read-only. [worktrees extension](pi-config/extensions/worktrees/README.md).
- **One session that watches the rest.** The Overseer tells you which sessions need you, and starts,
  prompts, or tidies them when you ask, confirming first when a request is risky.
- **Try several approaches at once.** Send one prompt to several models and compare answers side by
  side, forked from the same conversation or started fresh.
- **Change direction without starting over.** Fork, rewind, or steer a running web chat, and switch
  models mid-session.
- **Keep your terminal. Get another window.** Existing sessions are listed without importing them;
  terminal sessions stream live and read-only, in your browser or on your phone.
  [Terminal presence and phone access](docs/getting-started.md#terminal-and-phone-access) need setup.
- **Use several machines as one.** The [mesh](docs/mesh.md) lists and drives sessions on every Sova
  host on your tailnet from any one page, and links sessions across hosts so they can message each
  other. Every host in a mesh must be reachable by the same devices.
- **Share a session with anyone.** Send a read-only link to a whole session or just part of it, with
  [public links](docs/public-links.md) on an address you set up. Recipients need no account or tailnet.
- **And more.** A [sandbox](pi-config/extensions/sandbox/README.md) per session; playbooks and
  schedules; several [Claude logins](pi-config/extensions/claude-code/README.md) with failover on a
  usage limit; local voice input (set up in Settings → Voice); a resource monitor that charges load
  to the session that caused it; and session tools on your SSH, AWS SSM, Docker, or Incus targets
  with the [remote extension](pi-config/extensions/remote/README.md).

Single-user and loopback by default; every browser unlocks once, per address it uses, with the
install's token — read from the token file `~/.pi/agent/sova/auth-token` on the machine Sova runs
on, printed by `pnpm run auth:token` in a checkout, and by `sova token` and `sova open` where the
installer's launcher is installed. A second device — a phone — comes in with a one-use **pairing
code** from **Access** on the app's home page, with the link it must open shown as a QR to scan.
Protect access before exposing it beyond your machine. Model requests go to your configured provider; tools and extensions may also
use the network.

## Make it yours

[Setup and safe access](docs/getting-started.md) ·
[Themes, models, and optional extensions](docs/customization.md) ·
[Development](CONTRIBUTING.md)

## License

[Apache-2.0](LICENSE) · [NOTICE](NOTICE).
Bundled fonts include their own licenses in [public/fonts/](public/fonts/);
[pi-config](pi-config/LICENSE) is licensed separately.
