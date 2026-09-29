# mesh-vps: Sova on a VPS (the real mesh, milestone M5)

The VPS may be a shared host that also runs other services. These scripts run as `deploy`
with NO sudo, write only under `~deploy/sova-mesh`, and never touch /etc, system packages or any
running service. Root steps are listed in SUDO.md for the parent.

Layout on the VPS (`~/sova-mesh`): `node/` (Node 22 LTS, sha256-pinned), `bin/caddy` (sha512-pinned), `app/`
(git archive of a commit; `app.prev` = the previous one), `agent/` (PI_CODING_AGENT_DIR; `auth.json` starts EMPTY,
keys arrive by sync; `sova/peers.json` is seeded once with self id `$VPS_ID` (default `vps`), no peers (logins of every kind sync, subscriptions included; Settings → Mesh can switch this host to API keys only); the
self id is never rewritten, since host filters and the front-door order reference it), `home/` (isolated HOME), `tmp/` (TMPDIR for every build/run step, 0700: nothing of ours in /tmp; holds jiti's
extension cache, re-warmed by `run-warm.sh` / `warm-extensions.mjs` after each build and at each unit start, so the first
session never stalls Sova compiling 16 extensions), `sova-mesh.env` (SOVA_SYNC_CLAUDE_DIR = `home/.claude`, 0700: the Claude Code store that login sync fills), `Caddyfile`.
Ports: Sova main 127.0.0.1:4800; peer listener <vps-tailnet-ip>:4801 (only while peers.json lists a peer);
front door Caddy 127.0.0.1:4890 (admin 127.0.0.1:2089); share links 127.0.0.1:4802 when this host is the share gateway.
Nothing of Sova's binds the public interface.

Public share links (optional): in Sova, Settings → Public links → "This host is the gateway", with a public address
(https://share.example.com) and a front. Sova shows the front's one-time step and a Verify button; it never runs the
step and never writes the front's config. The public front is separate from the private front door (4890 / 8443),
which stays tailnet only. Set SHARE_FRONT in local.env to the front you chose so `exposure.sh probe` expects 443 open;
every Sova port, 4802 included, must still time out. The front's root step, if any, is in SUDO.md.

From the laptop:
- `deploy.sh [--rev <sha>] [--claude-bin <path>]`: stream `git archive <sha>` over ssh into `app.new`, install Node/Caddy,
  pnpm install --frozen-lockfile and both vite builds in `app.new`, and only then swap it in (a failed install or build
  stops there and the running app is untouched), agent dir, env. Restarts the sova-mesh user unit if it is running. Claude Code is not
  installed by us: the directory of deploy's own `claude` (`--claude-bin` / CLAUDE_BIN, else `command -v claude` in
  deploy's login shell, else ~/.local/bin and other common locations) is appended to the unit's PATH in `sova-mesh.env`;
  if none is found the deploy warns "Claude Code not found: claude-code models will fail" and carries on.
- `smoke.sh [--keep-peers]`: start Sova by hand, check health, mesh off = no peer port, PUT peers.json (the
  laptop's team server; self.id must be $VPS_ID, loginKinds not pinned) → the peer listener binds the tailnet IP only, exposure probe, stop, and compare the
  production state (listening sockets + `systemctl is-active` of PROD_UNITS, if set) before and after.
- `exposure.sh probe`: public 4800/4801/4802/4890/2089/8443/10443 must time out (VPS_CONTROL_PORTS, if set, are controls that must connect;
  with SHARE_FRONT = vhost, caddy or funnel, 443 is one too). ssh goes over the tailnet
  ($VPS_SSH).

Tailnet URLs (tailscale serve, set by the parent; tailnet only): front door
https://<vps>.<tailnet>.ts.net:8443/ (Caddy 127.0.0.1:4890), this host https://<vps>.<tailnet>.ts.net:10443/ (Sova 127.0.0.1:4800).
- `laptop-forwarder.sh start|stop|status`: on the laptop, a user-level socat <laptop-tailnet-ip>:4872 -> 127.0.0.1:4870 (the team
  server), the front door's upstream for the laptop (LAPTOP_SERVE_URL). Killable; the laptop's own `tailscale serve` is untouched.

On the VPS: `run-sova.sh`, `run-frontdoor.sh` (the units' ExecStart), `frontdoor-config.sh` (Caddyfile from
Sova's own GET /api/mesh/front-door, rebound to 127.0.0.1).
Settings (versions, checksums, ports) are in `config.sh`; the site-specific values (VPS addresses, the laptop peer,
VPS_CONTROL_PORTS, PROD_UNITS) in the untracked `local.env`: `cp local.env.example local.env` and fill it in.

## Resync from the host menu

A laptop whose host menu shows the VPS as "other version" and behind can run this deploy for you
(`§mesh.peers/resync`): it deploys exactly the commit the laptop's Sova booted from (`deploy.sh --rev <that commit>`), never
the checkout's newer HEAD, and only when the VPS is behind (never a downgrade). It needs a recipe in the laptop's
`~/.pi/agent/sova/mesh-resync.json` (never synced to other hosts), keyed by the VPS's peer id, plus this directory's
`local.env`:

    {"hosts": {"vps": {"kind": "vps"}}}

`"args": ["--claude-bin", "/path/to/claude"]` passes deploy.sh options (`--rev` is refused: the commit is the laptop's).
The job runs as a child of the laptop's Sova, with its output in `~/.pi/agent/sova/mesh-resync/<id>.log`; restarting the
laptop's Sova stops it. A laptop that booted with uncommitted changes, or whose protocol doesn't match its commit, can't
name its build and offers no resync until it restarts on a clean checkout. If the VPS is the share gateway with
`SHARE_FRONT=caddy`, a commit that bumps `CADDY_VERSION` needs the `setcap` root step in SUDO.md again, and the restart
takes public links offline for its duration.
