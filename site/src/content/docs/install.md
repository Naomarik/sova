---
title: Install
description: Install Sova on a Mac or Linux machine in one command, then start it and open it.
group: Setup
order: 30
---

The install script is safe to pipe from `curl`, needs no `sudo`, and installs no system packages.

## What you need

- Git
- Node.js 22.19 or later
- pnpm, or npx to run the pnpm Sova pins
- curl
- unzip or python3

The server runs on Bun. The installer downloads the Bun version Sova pins into Sova's own folder and checks it against a recorded checksum. It doesn't install a version manager or edit your shell profile.

## Install

```sh
curl -fsSL https://raw.githubusercontent.com/Naomarik/sova/v0.2.0/scripts/install.sh | bash
```

The script is read whole before it runs, so a download cut short runs nothing. It builds Sova in a staging folder and only replaces your install once the build has succeeded; if anything fails, the previous install stays.

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

`sova open` and `sova token` don't start the server. Before the server has run once there's no token yet, and both tell you to start it first.

## The access token

Sova makes one access token per install the first time it starts, in `~/.pi/agent/sova/auth-token`. Every browser needs it once: `sova open` passes it along for you, and other devices pair with a one-use code instead. See [Check in from your phone](/docs/phone/#let-your-phone-in).

There's no account, password, or expiry: anyone with the token has the same access you do, so keep it private. To sign every browser out, delete the file and restart Sova.

## Options

Pass options to the script after `bash -s --`:

```sh
curl -fsSL https://raw.githubusercontent.com/Naomarik/sova/v0.2.0/scripts/install.sh | bash -s -- --service
```

| Option | Does |
|---|---|
| `--service` | Installs the login service without asking. |
| `--no-service` | Doesn't install it, and doesn't ask. |
| `--port <n>` | The port the login service runs Sova on. 4800 by default. |
| `--no-extensions` | Links no pi extensions. |
| `--reinstall` | Rebuilds even when the install is already up to date. |

## A login service

With your yes, or `--service`, the installer adds a per-user service that starts Sova when you log in and restarts it if it exits: a launchd agent on macOS, a systemd user unit on Linux. Neither needs `sudo`. On macOS its output goes to `~/Library/Logs/sova.log`; on Linux, to the journal.

With neither option it asks, defaulting to no. With no terminal to ask on, it installs none and says how to add one. If something already listens on the port, such as a `sova` you started by hand, it installs the service without starting it, and says so.

## Run it again

Running the installer again with the same inputs changes nothing. An install already at the requested version isn't rebuilt, files are rewritten only when they'd change, and a service is reloaded only when its definition changed and restarted only when the code did. A second copy is never started.

## Claude Code models

Sova always offers the models of the Claude Code CLI. They work once the `claude` CLI is installed and logged in. If it isn't on your `PATH`, the installer says so.
