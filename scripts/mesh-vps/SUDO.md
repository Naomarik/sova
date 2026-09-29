# Root steps on the VPS: the PARENT runs these (members never use sudo there)

Everything else runs as `deploy` without sudo (`deploy.sh`, `smoke.sh`, the user units). Run in this order, on
the VPS (ssh $VPS_SSH over the tailnet, then sudo), after `scripts/mesh-vps/deploy.sh --rev <M5 sha>` succeeded.

```sh
# 1. let deploy's user units run without a login session (sova-mesh.service, sova-frontdoor.service)
sudo loginctl enable-linger deploy

# 2. the peer listener (<vps-tailnet-ip>:4801) reachable over the tailnet only; the public interface stays default-deny
sudo ufw allow in on tailscale0 to any port 4801 proto tcp

# 3. tailnet HTTPS (tailscale serve, NEVER funnel):
#    front door  https://<vps>.<tailnet>.ts.net:8443/  -> Caddy 127.0.0.1:4890
#    this host   https://<vps>.<tailnet>.ts.net:10443/ -> Sova  127.0.0.1:4800
sudo tailscale serve --bg --https=8443 http://127.0.0.1:4890
sudo tailscale serve --bg --https=10443 http://127.0.0.1:4800
```

Check afterwards (no sudo needed): `tailscale serve status` (two https handlers, no Funnel),
`loginctl show-user deploy -p Linger` (yes), and from the laptop `scripts/mesh-vps/exposure.sh probe` (PASS).

Notes for the parent:
- Serve needs HTTPS certificates enabled for the tailnet (admin console → DNS → HTTPS Certificates).
- Undo: `sudo tailscale serve --https=8443 off; sudo tailscale serve --https=10443 off`,
  `sudo ufw delete allow in on tailscale0 to any port 4801 proto tcp`, `sudo loginctl disable-linger deploy`.

Then, as deploy (no sudo):
```sh
mkdir -p ~/.config/systemd/user
cp ~/sova-mesh/app/scripts/mesh-vps/sova-mesh.service ~/sova-mesh/app/scripts/mesh-vps/sova-frontdoor.service ~/.config/systemd/user/
systemctl --user daemon-reload && systemctl --user enable --now sova-mesh.service
~/sova-mesh/app/scripts/mesh-vps/frontdoor-config.sh      # Caddyfile from Sova's GET /api/mesh/front-door
systemctl --user enable --now sova-frontdoor.service
```

## Optional: the public share front (only if this VPS is the share-link gateway)

Sova shows the exact step for the chosen front (Settings → Public links); these are the root parts, run once.
The front is the only public way in: it serves https://share.example.com on 443 and forwards to Sova's share port
127.0.0.1:4802. Nothing else becomes public; 8443 and 10443 stay `tailscale serve`, NEVER funnel.

```sh
# Caddy on this host (the pinned ~/sova-mesh/bin/caddy, run as deploy): allow it to bind 80 and 443, and open them
sudo setcap cap_net_bind_service=+ep ~deploy/sova-mesh/bin/caddy   # again after each Caddy upgrade
sudo ufw allow 80/tcp && sudo ufw allow 443/tcp

# or Tailscale Funnel: let deploy run it, then as deploy (no sudo) funnel ONLY the share port on 443
sudo tailscale set --operator=deploy
#   tailscale funnel --bg --https=443 http://127.0.0.1:4802

# or the host's existing web server: add the server block Sova shows, then reload it (e.g. sudo systemctl reload nginx)
# or cloudflared: no root step (it dials out; nothing opens)
```

Check afterwards: set SHARE_FRONT in local.env, then from the laptop `scripts/mesh-vps/exposure.sh probe` (PASS: 443
open, every Sova port including 4802 times out), and Verify in Sova. `tailscale funnel status` lists 443 only.
Undo: `sudo setcap -r ~deploy/sova-mesh/bin/caddy`, `sudo ufw delete allow 80/tcp; sudo ufw delete allow 443/tcp`,
`tailscale funnel --https=443 off`.
