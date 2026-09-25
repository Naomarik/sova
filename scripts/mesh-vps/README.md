# mesh-vps: Sova on a VPS (the real mesh, milestone M5)

The VPS may be a shared host that also runs other services. These scripts run as `deploy`
with NO sudo, write only under `~deploy/sova-mesh`, and never touch /etc, system packages or any
running service. Root steps are listed in SUDO.md for the parent.

Layout on the VPS (`~/sova-mesh`): `node/` (Node 22 LTS, sha256-pinned), `bin/caddy` (sha512-pinned), `app/`
(git archive of a commit; `app.prev` = the previous one), `agent/` (PI_CODING_AGENT_DIR; `auth.json` starts EMPTY,
keys arrive by sync; `sova/peers.json` is seeded once with self id `vps`, no peers, `loginKinds: api-keys`; the
self id is never rewritten, since host filters and the front-door order reference it), `home/` (isolated HOME), `tmp/` (TMPDIR for every build/run step, 0700: nothing of ours in /tmp; holds jiti's
extension cache, re-warmed by `run-warm.sh` / `warm-extensions.mjs` after each build and at each unit start, so the first
session never stalls Sova compiling 16 extensions), `sova-mesh.env` (also pins SOVA_SYNC_LOGIN_KINDS=api-keys: no subscription logins on this host), `Caddyfile`.
Ports: Sova main 127.0.0.1:4800; peer listener 100.64.0.2:4801 (only while peers.json lists a peer);
front door Caddy 127.0.0.1:4890 (admin 127.0.0.1:2089). Nothing binds the public interface.

From the laptop:
- `deploy.sh [--rev <sha>]`: stream `git archive <sha>` over ssh, install Node/Caddy, pnpm install
  --frozen-lockfile, vite build, agent dir, env. Restarts the sova-mesh user unit if it is running.
- `smoke.sh [--keep-peers]`: start Sova by hand, check health, mesh off = no peer port, PUT peers.json (the
  laptop's team server; self.id must be vps, loginKinds api-keys) → the peer listener binds the tailnet IP only, exposure probe, stop, and compare the
  production state (listening sockets + `systemctl is-active` of the prod units) before and after.
- `exposure.sh probe`: public 4800/4801/4890/2089/8443/10443 must time out (80/443 are controls that must connect). ssh goes over the tailnet
  ($VPS_SSH).

Tailnet URLs (tailscale serve, set by the parent; tailnet only): front door
https://vps.<tailnet>.ts.net:8443/ (Caddy 127.0.0.1:4890), this host https://vps.<tailnet>.ts.net:10443/ (Sova 127.0.0.1:4800).
- `laptop-forwarder.sh start|stop|status`: on the laptop, a user-level socat 100.64.0.4:4872 -> 127.0.0.1:4870 (the team
  server), the front door's upstream for the laptop (LAPTOP_SERVE_URL). Killable; the laptop's own `tailscale serve` is untouched.

On the VPS: `run-sova.sh`, `run-frontdoor.sh` (the units' ExecStart), `frontdoor-config.sh` (Caddyfile from
Sova's own GET /api/mesh/front-door, rebound to 127.0.0.1).
Settings (versions, checksums, ports, the laptop peer) are in `config.sh`.
