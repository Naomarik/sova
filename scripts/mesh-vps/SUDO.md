# Root steps on the VPS: the PARENT runs these (members never use sudo there)

Everything else runs as `deploy` without sudo (`deploy.sh`, `smoke.sh`, the user units). Run in this order, on
the VPS (ssh $VPS_SSH over the tailnet, then sudo), after `scripts/mesh-vps/deploy.sh --rev <M5 sha>` succeeded.

```sh
# 1. let deploy's user units run without a login session (sova-mesh.service, sova-frontdoor.service)
sudo loginctl enable-linger deploy

# 2. the peer listener (100.64.0.2:4801) reachable over the tailnet only; eth0 stays default-deny
sudo ufw allow in on tailscale0 to any port 4801 proto tcp

# 3. tailnet HTTPS (tailscale serve, NEVER funnel):
#    front door  https://vps.<tailnet>.ts.net/      -> Caddy 127.0.0.1:4890
#    this host   https://vps.<tailnet>.ts.net:8443/ -> Sova  127.0.0.1:4800
sudo tailscale serve --bg --https=443 http://127.0.0.1:4890
sudo tailscale serve --bg --https=8443 http://127.0.0.1:4800
```

Check afterwards (no sudo needed): `tailscale serve status` (two https handlers, no Funnel),
`loginctl show-user deploy -p Linger` (yes), and from the laptop `scripts/mesh-vps/exposure.sh probe` (PASS).

Notes for the parent:
- The front door must not take a serve port another service on the host already uses; pick free ones and tell the coordinator.
- Serve needs HTTPS certificates enabled for the tailnet (admin console → DNS → HTTPS Certificates).
- Undo: `sudo tailscale serve --https=443 off; sudo tailscale serve --https=8443 off`,
  `sudo ufw delete allow in on tailscale0 to any port 4801 proto tcp`, `sudo loginctl disable-linger deploy`.

Then, as deploy (no sudo):
```sh
mkdir -p ~/.config/systemd/user
cp ~/sova-mesh/app/scripts/mesh-vps/sova-mesh.service ~/sova-mesh/app/scripts/mesh-vps/sova-frontdoor.service ~/.config/systemd/user/
systemctl --user daemon-reload && systemctl --user enable --now sova-mesh.service
~/sova-mesh/app/scripts/mesh-vps/frontdoor-config.sh      # Caddyfile from Sova's GET /api/mesh/front-door
systemctl --user enable --now sova-frontdoor.service
```
