# Getting started

[← Sova](../README.md)

## Install and launch

Have Git, Node.js ≥22.19, and pnpm installed, plus `curl` and Bash for this command (without
pnpm, the installer runs the version Sova pins through npx):

```sh
curl -fsSL https://raw.githubusercontent.com/Naomarik/sova/vNEXT/scripts/install.sh | bash
```

The installer builds the published `vNEXT` release in `~/.local/share/sova` and creates
`~/.local/bin/sova`. It does **not** start the server. Run:

```sh
sova
```

Then, in another terminal, run `sova open`: it opens <http://127.0.0.1:4800> already unlocked.
Sova asks every browser for its token once, at each address it uses; `sova token` prints it, to
paste on the unlock screen of another browser or device. A browser can also be let in with a
pairing code instead of the token — see below. Without the installer's launcher (Sova running from
a source checkout), the token is in `~/.pi/agent/sova/auth-token` (or `sova/auth-token` under the
server's `PI_CODING_AGENT_DIR`), and `pnpm run auth:token` in the checkout prints it.

To bring a phone in, open the app on a browser that is already unlocked and use **Access** on the
home page: it makes a **pairing code** that works once and expires in five minutes, and shows the
link the other device must open — as a QR to scan with its camera, and as text to copy. The QR and
the link use an address that device can actually reach (a tailnet name, never an IP address), so
open Sova at that address before making the code; if it cannot, the page says so rather than
offering a link the phone cannot open. The code can be typed or pasted on the other device's unlock
screen, or the link is opened there — either way that device is in, and the install's token never
had to leave the first browser.

If your shell says `sova` is not found, run `~/.local/bin/sova`
directly, or add `~/.local/bin` to your shell's `PATH`. Keep the process running while you use
the app; `Ctrl+C` stops it.

The installer uses no `sudo`, installs no toolchain, and changes no shell profiles or autostart
services. It does not read or write `~/.pi`, or install the optional pi configuration.
You can [inspect the published script](https://github.com/Naomarik/sova/blob/vNEXT/scripts/install.sh)
before running it. Its `--dir` and `--bin` flags select different install and launcher directories.

## First-time provider login

Existing pi sessions are readable as soon as Sova starts. To chat, configure a provider in pi.
If you already use pi, Sova shares its credentials in `~/.pi/agent/auth.json`.

No global pi installation is required. Open the bundled CLI:

```sh
~/.local/share/sova/node_modules/.bin/pi
```

Inside pi, enter `/login` and choose your provider. Then return to Sova and start a session.
For a custom installation, use `<install directory>/node_modules/.bin/pi` instead. A global
`pi` command also works when it uses the same agent directory.

## Terminal and phone access

### Watch your terminal sessions

Sova reads the same session files as pi—there is no import step. The optional
[sessions extension](../pi-config/extensions/sessions/README.md) announces which sessions a
terminal currently owns. Load it in your terminal pi setup for reliable live-presence detection;
see [optional extensions](customization.md#optional-extensions) before installing the full bundle.
Without it, sessions remain listed and readable, but terminal ownership is not reliably identified.

A session owned by a terminal is live and read-only in Sova. Use a web chat for sending,
steering, and rewinding; don't force a session open for chat while another process is writing it.

### Connect from another device

Your phone needs a protected route to the machine running Sova. The default loopback address is
reachable only on that machine—it is not a phone-access setup.

Use an authenticated tunnel or an HTTPS reverse proxy with authentication and WebSocket support.
Keep Sova on loopback when the tunnel or proxy runs on the same host. Protect **all** routes,
including `/api` and `/ws`, and firewall the backend port against direct access.

Setting `HOST=0.0.0.0` exposes the backend on all interfaces. Sova's only protection is its
per-install token (in `~/.pi/agent/sova/auth-token`; deleting it and restarting revokes every
browser), and anyone who has it can read files and run commands with the server user's
permissions. Sova is not a multi-user service.

To send people outside your devices a read-only link to a session, set up
[public links](public-links.md). They use a separate, locked-down port, never Sova's own.

For home-screen installation, use a browser that supports PWAs over HTTPS. The cached app shell
can open offline; transcripts and chat still require the running server. Model requests send
prompts and context to your configured provider, and tools and extensions may contact other services.

## Runtime settings and data

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `4800` | HTTP and WebSocket port |
| `HOST` | `127.0.0.1` | Bind address; keep private unless protected as above |
| `PI_CODING_AGENT_DIR` | `~/.pi/agent` | Shared pi credentials, sessions, and extensions |
| `SOVA_SHARE_PUBLIC_URL` | unset | The address every public link is built on, such as `https://share.example.com`; wins over Settings → Public links |
| `SOVA_SHARE_HOST` | unset (`127.0.0.1` for a gateway) | Address the share port binds; with both it and `SOVA_SHARE_PORT` set, Sova binds there even with Public links off |
| `SOVA_SHARE_PORT` | unset (`4802` for a gateway) | Port the share listener binds |

For example, `PORT=4801 sova` changes the port. The `SOVA_SHARE_*` variables are for
[public links](public-links.md#pin-it-with-environment-variables); leave them unset to use Settings → Public links.

Sova keeps its app state under `~/.pi/agent/sova/`, including groups, archive metadata, drafts,
attachments, and themes. The embedded pi runtime also reads and writes pi sessions; model policy
and remote-target configuration live in the shared agent directory. Back up that directory before
experimenting with configuration. Never commit credentials, transcripts, or personal targets.

## Reinstall or remove

Re-running the installer rebuilds the same pinned release, not the latest `master`. It stages the
build before replacing the installation and refuses tracked local changes. Don't store your own
files in the install directory: untracked files do not prevent replacement.

To remove the default installation and launcher:

```sh
rm -rf ~/.local/share/sova ~/.local/bin/sova
```

This leaves your pi sessions and credentials, and Sova's state under `~/.pi/agent/sova/`, intact.
If you opted into configuration symlinks from this installation, relocate or remove those links
before deleting it. For running a source checkout instead, see [Development](../CONTRIBUTING.md).
