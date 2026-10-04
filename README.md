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

## More work, less window switching

- **Try several approaches at once.** Start parallel sessions with different models, send a shared
  prompt, and compare answers side by side. Fork from the same conversation or start fresh.
- **Change direction without starting over.** Fork a conversation, rewind to an earlier message,
  or steer a running web chat. Switch models, attach files, and keep going with the context you built.
- **Keep your terminal. Get another window.** Browse existing sessions without importing them;
  watch terminal sessions live and read-only in your browser or on your phone.
  [Terminal presence and phone access](docs/getting-started.md#terminal-and-phone-access) need setup.
- **See what your agents are doing.** Follow workers and coordinated teams down to their individual
  transcripts with the optional [subagents extension](pi-config/extensions/subagents/README.md).
- **Work beyond your laptop.** The optional [remote extension](pi-config/extensions/remote/README.md)
  runs session tools on your configured SSH, AWS SSM, Docker, or Incus targets.
- **Use several machines as one.** The [mesh](docs/mesh.md) lists and drives sessions on every Sova
  host on your tailnet from any one page. Every host in a mesh must be reachable by the same devices.
- **Share a session with anyone.** Send a read-only link to a whole session or just part of it, with
  [public links](docs/public-links.md) on an address you set up. Recipients need no account or tailnet.

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
