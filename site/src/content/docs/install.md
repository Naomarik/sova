---
title: Install
description: Install Sova on a Mac or Linux machine in one command, then start it and open it.
group: Setup
order: 30
---

The install script is safe to pipe from `curl`, needs no `sudo`, and installs no system packages.

## What you need

- macOS, or Linux on x64 or arm64 (glibc or musl). Tested on Debian, Fedora and Alpine.
- bash (Alpine has none until you `apk add bash`)
- Git
- Node.js 22.19 or later
- pnpm, or npx to run the pnpm Sova pins
- curl
- unzip or python3

The server runs on Bun. The installer downloads the Bun version Sova pins into Sova's own folder and checks it against a recorded checksum. It doesn't install a version manager or edit your shell profile.

## Install

```sh
curl -fsSL https://raw.githubusercontent.com/Naomarik/sova/master/scripts/install.sh | bash
```

Until the first release is tagged, this installs Sova's `master` branch, which changes from day to day; running it again updates to master's latest commit.

The whole script is one function that runs only after bash has read its last line, so a download cut short runs nothing. To install another tag, branch or commit, end the command with `| SOVA_REF=<ref> bash` instead; one that doesn't exist stops it before it changes anything. It builds Sova in a staging folder and only replaces your install once the build has succeeded; if anything fails, the previous install stays.

What it puts on your machine:

- **Sova itself** in `~/.local/share/sova`, with its Bun inside it.
- **A launcher**, `~/.local/bin/sova`.
- **Sova's pi extensions**, linked one by one into `~/.pi/agent/extensions/` (or your `$PI_CODING_AGENT_DIR`). They're links, not copies, so an update brings them along. Anything already there that isn't Sova's own link is left alone, and the installer tells you which extension it skipped.
- **A login service**, only if you say yes.

It writes none of pi's configuration: no `settings.json`, `models.json`, `auth.json`, or sandbox policy.

## Start it and open it

```sh
sova
```

Keep it running while you use the app; `Ctrl+C` stops it. Then, in another terminal:

```sh
sova open
```

That opens your browser at Sova, already signed in. Sessions you already have in `~/.pi/agent` show up right away.

| Command | Does |
|---|---|
| `sova` | Runs the server, on Bun. |
| `sova --node` | Runs the server on Node instead. |
| `sova open` | Opens the app in your browser, signed in. |
| `sova token` | Prints this install's access token. |

`sova open` and `sova token` don't start the server. Before the server has run once there's no token yet, and both tell you to start it first. On a machine with no browser opener, such as a server you reach over SSH, `sova open` says so; open the page yourself and paste the token from `sova token`.

## The access token

Sova makes one access token per install the first time it starts, in `~/.pi/agent/sova/auth-token`. Every browser needs it once: `sova open` passes it along for you, and other devices pair with a one-use code instead. See [Check in from your phone](/docs/phone/#let-your-phone-in).

There's no account, password, or expiry: anyone with the token has the same access you do, so keep it private. To sign every browser out, delete the file and restart Sova.

## Options

Pass options to the script after `bash -s --`:

```sh
curl -fsSL https://raw.githubusercontent.com/Naomarik/sova/master/scripts/install.sh | bash -s -- --service
```

| Option | Does |
|---|---|
| `--service` | Installs the login service without asking. |
| `--no-service` | Doesn't install it, and doesn't ask. |
| `--port <n>` | The port `sova` and the login service run Sova on. 4800 by default. |
| `--no-extensions` | Links no pi extensions (links already there stay). |
| `--dir <path>` | Installs Sova there instead of `~/.local/share/sova`. |
| `--bin <path>` | Puts the launcher there instead of `~/.local/bin`. |
| `--reinstall` | Rebuilds even when the install is already up to date. |

## A login service

With your yes, or `--service`, the installer adds a per-user service that starts Sova when you log in and restarts it if it exits: a launchd agent on macOS, a systemd user unit on Linux. Neither needs `sudo`. On macOS its output goes to `~/Library/Logs/sova.log`; on Linux, to the journal.

With neither option it asks, defaulting to no. With no terminal to ask on, it installs none and says how to add one. If something already listens on the port, such as a `sova` you started by hand, it installs the service without starting it, and says so.

The service restarts Sova whenever it exits, but a stop you ask for stays stopped, and a stop gives Sova up to 90 seconds (60 on macOS) to let running agents finish. On Linux it stops at logout unless lingering is on (`loginctl enable-linger`).

It needs launchd or a systemd user manager. In a container or on another machine without `systemctl`, `--service` stops with an error; run `sova` yourself instead. Where `systemctl` exists but no user manager runs (a container, an SSH login without lingering), it writes the unit and prints the command to start it later.

## Run it again

Running the install command again updates to master's latest commit (or the latest of the `SOVA_REF` you set); pass the same options as before, since a run without `--port` goes back to 4800. Running it with the same inputs changes nothing. An install already at the requested version isn't rebuilt (`--reinstall` rebuilds it anyway), files are rewritten only when they'd change, and a service is reloaded only when its definition changed and restarted only when the code did. A second copy is never started.

## Remove it

Stop and remove the login service first, if you installed one. On Linux:

```sh
systemctl --user disable --now sova.service
rm ~/.config/systemd/user/sova.service && systemctl --user daemon-reload
```

If Linux has no systemd user manager running (a container, say), the `systemctl --user` lines fail with "Failed to connect to bus"; the `rm` still removes the unit, which is all there is to remove.

On macOS:

```sh
launchctl bootout gui/$(id -u)/io.github.naomarik.sova
rm ~/Library/LaunchAgents/io.github.naomarik.sova.plist
```

Then remove the extension links (use your `$PI_CODING_AGENT_DIR` in place of `~/.pi/agent` if you set one), Sova and the launcher:

```sh
find ~/.pi/agent/extensions -maxdepth 1 -lname "$HOME/.local/share/sova/*" -delete
rm -rf ~/.local/share/sova ~/.local/bin/sova
```

Your pi sessions and credentials, and Sova's own state in `~/.pi/agent/sova/`, stay. So do pnpm's package store and cache, which other projects may share. If nothing else on the machine uses pnpm, you can remove them too (on Linux):

```sh
rm -rf ~/.local/share/pnpm ~/.cache/pnpm ~/.local/state/pnpm
```

## Claude Code models

Sova always offers the models of the Claude Code CLI. They work once the `claude` CLI is installed and logged in. If it isn't on your `PATH`, the installer says so.
