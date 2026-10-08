# mesh-vps: Sova on a VPS

Deploy Sova from your own machine (the laptop, below) to a Linux VPS on your Tailscale tailnet, as a mesh host
([docs/mesh.md](../../docs/mesh.md)), as the gateway for public share links
([docs/public-links.md](../../docs/public-links.md)), or both. For public links on a single machine with no tailnet,
you don't need this kit: install Sova with `scripts/install.sh --service` and follow the single-host walkthrough in
docs/public-links.md.

What the VPS needs: Linux on x86_64 or aarch64 (any other architecture is refused before anything is downloaded),
systemd user services, outbound HTTPS to nodejs.org, github.com and the npm registry, `unzip` or `python3` (to
unpack Bun), Tailscale, and an ordinary user you reach over the tailnet with ssh (`VPS_SSH`, `<user>` below). The VPS may be a shared host that also runs other
services: these scripts run as `<user>` with no sudo, write only under `~<user>/sova-mesh`, and never touch /etc,
system packages or any running service. The few root steps are in [SUDO.md](SUDO.md), for whoever administers the VPS.

## Set up

1. `cp local.env.example local.env` and fill it in: the VPS's ssh target, public IP and tailnet IP, and for a mesh the
   laptop's peer values. `local.env` is untracked; versions, checksums and ports are in `config.sh`.
2. `./deploy.sh` from the laptop.
3. The root steps in [SUDO.md](SUDO.md): section 1 always, 2 and 3 for a mesh host, 4 for a share gateway, 5 for an
   internet relay (`VPS_RELAY=on`: a dial-out host such as a laptop reaches this VPS from any network).
4. Optionally `./smoke.sh` and `./exposure.sh probe` to check nothing of Sova's is public.

## What is on the VPS

Layout (`~/sova-mesh`): `node/` (Node 22 LTS, sha256-pinned per architecture), `bin/caddy` (sha512-pinned per
architecture), `app/` (git archive of a commit; `app.prev` = the previous one; Sova runs on its `app/.bun/bin/bun`, the
Bun build the commit's mise.toml pins, sha256-checked against its `scripts/bun-release.txt`; `SOVA_RUNTIME=node` in
local.env runs it on Node instead), `agent/` (PI_CODING_AGENT_DIR;
`auth.json` starts EMPTY, keys arrive by sync; `sova/peers.json` is seeded once with self id `$VPS_ID` (default `vps`)
and no peers (logins of every kind sync, subscriptions included; Settings → Mesh can switch this host to API keys
only); the self id is never rewritten, since host filters and the front-door order reference it), `home/` (isolated
HOME), `tmp/` (TMPDIR for every build/run step, 0700: nothing of ours in /tmp; holds jiti's extension cache, re-warmed
by `run-warm.sh` / `warm-extensions.mjs` after each build and at each unit start, so the first session never stalls
Sova compiling its extensions), `sova-mesh.env` (SOVA_SYNC_CLAUDE_DIR = `home/.claude`, 0700: the Claude Code store
that login sync fills), `Caddyfile`.

Ports: Sova main 127.0.0.1:4800; peer listener <vps-tailnet-ip>:4801 (only while peers.json lists a peer); front door
Caddy 127.0.0.1:4890 (admin 127.0.0.1:2089; optional, SUDO.md section 3); share links 127.0.0.1:4802 when this host is
the share gateway. Nothing of Sova's binds the public interface. Your firewall (e.g. ufw) keeps it that way: allow
4801 on the tailnet interface only, and 80/443 only for a public share front.

The internet relay (optional, `VPS_RELAY=on`, SUDO.md section 5): the public port (4803) belongs to the accept process,
which runs as the system user `sova-relay` from `/etc/systemd/system/sova-relay-accept.service` on the bundled Node, never
as you and never inside Sova. Each deploy installs its bundle as `accept/relay-accept.mjs`, keeps Sova's handoff socket in
`relay/` (0750, your group), names it in `sova-mesh.env` (`SOVA_RELAY_HANDOFF`), and renders the unit it ships as
`sova-relay-accept.service` for the admin to install. With `off`, nothing of it is installed or named.

Public share links (optional): in Sova, Settings → Public links → "This host is the gateway", with a public address
(https://share.example.com) and a front, or the same over ssh when this host's page isn't reachable
([docs/public-links.md](../../docs/public-links.md#set-up-a-gateway-with-no-page)). Sova shows the front's one-time
steps and a Verify button; it never runs the steps and never writes the front's config. The public front is separate
from the private front door (4890 / 8443), which stays tailnet only. Set SHARE_FRONT in local.env to the front you
chose so `exposure.sh probe` expects 443 open; every Sova port, 4802 included, must still time out. The front's root
steps, if any, are in SUDO.md section 4.

## The scripts

From the laptop:
- `deploy.sh [--rev <sha>] [--claude-bin <path>]`: stream `git archive <sha>` over ssh into `app.new`, install
  Node/Caddy for the VPS's architecture, the pinned Bun into `app.new/.bun`, pnpm install --frozen-lockfile and both vite builds in `app.new`, and only then
  swap it in (a failed install or build stops there and the running app is untouched), agent dir, env. Restarts the
  sova-mesh user unit if it is running. Claude Code is not installed by us: the directory of the VPS user's own
  `claude` (`--claude-bin` / CLAUDE_BIN, else `command -v claude` in that user's login shell, else ~/.local/bin and
  other common locations) is appended to the unit's PATH in `sova-mesh.env`; if none is found the deploy warns
  "Claude Code not found: claude-code models will fail" and carries on.
- `smoke.sh [--keep-peers]`: start Sova by hand, check health, mesh off = no peer port, PUT peers.json (the laptop's
  Sova; self.id must be $VPS_ID, loginKinds not pinned) → the peer listener binds the tailnet IP only, exposure probe,
  stop, and compare the production state (listening sockets + `systemctl is-active` of PROD_UNITS, if set) before
  and after.
- `exposure.sh probe`: public 4800/4801/4802/4890/2089/8443/10443 must time out (VPS_CONTROL_PORTS, if set, are
  controls that must connect; with SHARE_FRONT = vhost, caddy or funnel, 443 is one too). ssh goes over the tailnet
  ($VPS_SSH). The relay port: times out with VPS_RELAY=off; with on, it connects, answers no HTTP without a
  certificate and no byte to an unpaired one, refuses TLS 1.2, its unit is active and its listener isn't yours.
- `laptop-forwarder.sh start|stop|status`: on the laptop, a user-level socat <laptop-tailnet-ip>:4872 -> the laptop's
  Sova (LAPTOP_TARGET, default 127.0.0.1:4870), the front door's upstream for the laptop (LAPTOP_SERVE_URL). Killable;
  the laptop's own `tailscale serve` is untouched. Only for the front door.

Tailnet URLs (optional, `tailscale serve` from SUDO.md section 3; tailnet only): front door
https://<vps>.<tailnet>.ts.net:8443/ (Caddy 127.0.0.1:4890), this host https://<vps>.<tailnet>.ts.net:10443/ (Sova
127.0.0.1:4800).

On the VPS: `run-sova.sh`, `run-frontdoor.sh` (the units' ExecStart), `frontdoor-config.sh` (Caddyfile from Sova's own
GET /api/mesh/front-door, rebound to 127.0.0.1).

## Resync from the host menu

A laptop whose host menu shows the VPS as "other version" and behind can run this deploy for you
(`§mesh.peers/resync`): it deploys exactly the commit the laptop's Sova booted from (`deploy.sh --rev <that commit>`), never
the checkout's newer HEAD, and only when the VPS is behind (never a downgrade). It needs this directory's `local.env`:
its `VPS_ID` alone makes that peer resyncable (the file is read as plain `KEY=value` lines, never sourced by Sova). An
entry in the laptop's `~/.pi/agent/sova/mesh-resync.json` (never synced to other hosts), keyed by the peer id, wins
over that, e.g. to pass options:

    {"hosts": {"vps": {"kind": "vps"}}}

`"args": ["--claude-bin", "/path/to/claude"]` passes deploy.sh options (`--rev` is refused: the commit is the laptop's).
The job runs as a child of the laptop's Sova, with its output in `~/.pi/agent/sova/mesh-resync/<id>.log`; restarting the
laptop's Sova stops it. A laptop that booted with uncommitted changes, or whose protocol doesn't match its commit, can't
name its build and offers no resync until it restarts on a clean checkout. If the VPS is the share gateway with
`SHARE_FRONT=caddy`, a commit that bumps `CADDY_VERSION` needs the `setcap` root step in SUDO.md again, and the restart
takes public links offline for its duration.
