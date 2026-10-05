# Root steps on the VPS (run once as an admin)

Everything else runs as the VPS user, the one `VPS_SSH` logs in as (`<user>` below), with no sudo: `deploy.sh`,
`smoke.sh` and the user units. These steps need an account on the VPS that can use sudo (root over ssh, or another
admin account); `<user>` itself needs none. Run them after `scripts/mesh-vps/deploy.sh` succeeded once.

Which sections you need:

| You want | Sections |
|---|---|
| Public share links only (a share-only gateway, mesh off) | 1, then 4 |
| This VPS as a mesh host | 1, 2, and 3 if you want the tailnet front door |
| Both | 1 to 4 |
| This VPS as an internet relay for a dial-out host (a laptop reaching it from any network) | 1, 2, then 5 |

## 1. Let `<user>`'s services run without a login session (always)

```sh
sudo loginctl enable-linger <user>
```

Then, as `<user>` (no sudo):

```sh
mkdir -p ~/.config/systemd/user
cp ~/sova-mesh/app/scripts/mesh-vps/sova-mesh.service ~/.config/systemd/user/
systemctl --user daemon-reload && systemctl --user enable --now sova-mesh.service
```

Check: `loginctl show-user <user> -p Linger` says `Linger=yes`, and `systemctl --user is-active sova-mesh` says
`active`. Undo: `sudo loginctl disable-linger <user>`.

## 2. The peer port, tailnet only (mesh hosts)

The peer listener binds `<vps-tailnet-ip>:4801` only, and only while `peers.json` lists a peer. Your firewall must let
it in on the tailnet interface and nowhere else. With ufw:

```sh
sudo ufw allow in on tailscale0 to any port 4801 proto tcp
```

With firewalld, add `tailscale0` to a zone that allows 4801/tcp (for example
`sudo firewall-cmd --permanent --zone=trusted --add-interface=tailscale0 && sudo firewall-cmd --reload`, which trusts
the whole tailnet). With nftables, accept `iifname "tailscale0" tcp dport 4801` in your input chain. Undo with the
matching delete (`sudo ufw delete allow in on tailscale0 to any port 4801 proto tcp`).

## 3. Tailnet HTTPS (optional: the front door and this host's page)

A share-only gateway doesn't need this. It gives the mesh's front door and this host's own page a tailnet HTTPS
address. Use `tailscale serve`, never Funnel, for both:

```sh
# front door  https://<vps>.<tailnet>.ts.net:8443/  -> Caddy 127.0.0.1:4890
# this host   https://<vps>.<tailnet>.ts.net:10443/ -> Sova  127.0.0.1:4800
sudo tailscale serve --bg --https=8443 http://127.0.0.1:4890
sudo tailscale serve --bg --https=10443 http://127.0.0.1:4800
```

Serve needs HTTPS certificates turned on for the tailnet (admin console → DNS → HTTPS Certificates). Then, as `<user>`:

```sh
cp ~/sova-mesh/app/scripts/mesh-vps/sova-frontdoor.service ~/.config/systemd/user/
~/sova-mesh/app/scripts/mesh-vps/frontdoor-config.sh      # Caddyfile from Sova's GET /api/mesh/front-door
systemctl --user daemon-reload && systemctl --user enable --now sova-frontdoor.service
```

Check: `tailscale serve status` lists two https handlers and no Funnel. Undo:
`sudo tailscale serve --https=8443 off; sudo tailscale serve --https=10443 off`.

## 4. The public share front (only if this VPS is the share-link gateway)

Set the gateway first (Settings → Public links → "This host is the gateway", or over ssh without a page, see
[Set up a gateway with no page](../../docs/public-links.md#set-up-a-gateway-with-no-page)). Sova then shows the exact
steps for the front you chose; these are their root parts. The front is the only public way in: it serves
`https://share.example.com` and forwards to Sova's share port `127.0.0.1:4802`. Nothing else becomes public; 8443
and 10443 stay `tailscale serve`, never Funnel.

First, a DNS record: `share.example.com` → this VPS's public IP (`A`, and `AAAA` if it has IPv6). Behind a CDN, make
it a proxied record at the CDN instead. Cloudflare Tunnel and Funnel make their own names and need none.

Your firewall must allow in exactly what the front needs and nothing of Sova's:

| Port | Public? |
|---|---|
| 80, 443 (Caddy, or your web server) | open |
| 4800 (Sova), 4802 (share port), 4890 and 2089 (front door and its admin) | closed: they bind 127.0.0.1 anyway |
| 4801 (peer port) | tailnet interface only (section 2) |

**Caddy on this host.** The kit's pinned Caddy runs as `<user>`; let it bind 80 and 443, and open them:

```sh
sudo setcap cap_net_bind_service=+ep ~<user>/sova-mesh/bin/caddy   # again after each Caddy upgrade
sudo ufw allow 80/tcp && sudo ufw allow 443/tcp                     # or your firewall's equivalent
```

**Tailscale Funnel.** Let `<user>` run it; then as `<user>` (no sudo) funnel only the share port on 443:

```sh
sudo tailscale set --operator=<user>
#   tailscale funnel --bg --https=443 http://127.0.0.1:4802
```

The tailnet policy must allow Funnel for this node: a `nodeAttrs` entry with `"attr": ["funnel"]` whose `target`
covers it.

**Your existing web server (for example nginx).** Get a certificate first (unless a CDN terminates TLS for you), then
add the server block Sova shows in a file of its own, test, and reload. The block already points at certbot's files;
change its two `ssl_` lines only for a certificate from elsewhere:

```sh
sudo certbot certonly --nginx -d share.example.com   # writes /etc/letsencrypt/live/share.example.com/{fullchain,privkey}.pem
sudoedit /etc/nginx/conf.d/zz-sova-share.conf       # the block from Settings → Public links
sudo nginx -t && sudo systemctl reload nginx
```

Name the file so it sorts after your existing default site (the `zz-` prefix), or mark that site `default_server`:
nginx answers an unknown hostname with the first server block for the port, and that should never be Sova's. Behind a
CDN such as Cloudflare's proxy, use the block in
[Behind a CDN](../../docs/public-links.md#behind-a-cdn) instead: it listens on 80, restores the visitor's address
from the CDN's published ranges, and needs a refresh when those ranges change. Undo: remove the file, then
`sudo nginx -t && sudo systemctl reload nginx`.

**Cloudflare Tunnel.** No root step: it dials out, and nothing opens.

Check afterwards: set `SHARE_FRONT` in `local.env`, then from your own machine run
`scripts/mesh-vps/exposure.sh probe` (PASS: 443 open for Caddy, a web server or Funnel, and every Sova port including
4802 times out), and press Verify Address in Sova. `tailscale funnel status` lists 443 only.
Undo: `sudo setcap -r ~<user>/sova-mesh/bin/caddy`, `sudo ufw delete allow 80/tcp; sudo ufw delete allow 443/tcp`,
`tailscale funnel --https=443 off`.

## 5. An internet relay (a dial-out host reaches this VPS from any network)

The relay's public port belongs to a separate **accept process** that runs as its own system user, `sova-relay`, never as
`<user>` and never inside Sova. It checks the dial-out host's certificate, then hands the still-encrypted connection to
Sova over a unix socket in `~<user>/sova-mesh/relay/`; Sova runs its own pinned TLS inside it, end to end with the
dial-out host, so the accept process never sees what the two say. It listens only while Sova tells it to (an internet
relay is set on the Mesh page and at least one dial-out host is paired), and refuses everyone whenever Sova is gone.

First, as yourself: set `VPS_RELAY=on` (and `VPS_RELAY_PORT`, 4803 unless you choose 443) in `local.env` and run
`scripts/mesh-vps/deploy.sh`. It bundles the accept process into `~<user>/sova-mesh/accept/`, makes the handoff
directory, points Sova at it, and writes the unit for you to install, `~<user>/sova-mesh/sova-relay-accept.service`.
`<user>`'s own group (`id -gn <user>`, below `<group>`) must have no other members: the deploy warns if it has.

Then, as an admin, once:

```sh
# 1. The accept process's own user: no home, no shell, no login.
sudo useradd --system --user-group --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin sova-relay

# 2. Its unit. Read it first: it is the sandbox (the user, the paths it sees, the address ranges it may not reach).
less ~<user>/sova-mesh/sova-relay-accept.service
sudo install -m 0644 -o root -g root ~<user>/sova-mesh/sova-relay-accept.service /etc/systemd/system/sova-relay-accept.service

# 3. Start it now and at every boot.
sudo systemctl daemon-reload && sudo systemctl enable --now sova-relay-accept.service

# 4. Open the port on the public interface only (and in the provider's cloud firewall, if it has one).
#    <public-if>: the interface with the public address (`ip -br addr`).
sudo ufw allow in on <public-if> to any port 4803 proto tcp comment 'sova internet relay'

# 5. Recommended: drop every new outbound connection the accept process starts, beyond what the unit already denies.
#    In /etc/ufw/before.rules, just above the `COMMIT` line that ends the *filter section, add:
#      -A ufw-before-output -m owner --uid-owner sova-relay -m conntrack --ctstate NEW -j DROP
#    and in /etc/ufw/before6.rules, just above its `COMMIT`:
#      -A ufw6-before-output -m owner --uid-owner sova-relay -m conntrack --ctstate NEW -j DROP
sudoedit /etc/ufw/before.rules
sudoedit /etc/ufw/before6.rules
sudo ufw reload

# 6. Check.
systemctl is-active sova-relay-accept                        # active
sudo systemd-analyze security sova-relay-accept.service      # a low exposure score (the unit's sandbox)
sudo journalctl -u sova-relay-accept -n 20 --no-pager        # "control connected" once Sova's mesh is on
```

For **port 443** instead: set `VPS_RELAY_PORT=443` before the deploy (the rendered unit then carries
`CAP_NET_BIND_SERVICE`, the only capability it ever gets) and open 443 in step 4. 443 passes more networks' filters,
but it can't be used while this VPS's public share front (section 4: Caddy, a web server or Funnel) holds 443; the deploy
warns if it does.

Then, on this VPS's Mesh page (its tailnet address): pair the dial-out host first, if it isn't paired yet (the mesh must
be on for Sova to open its handoff socket), then under "This host as a relay" choose "Reached from: The internet", this
VPS's public address and port 4803, and Save Relay. The dial-out host pairs this VPS with "This relay is on the internet"
checked. From your own machine, `VPS_RELAY=on scripts/mesh-vps/exposure.sh probe` must PASS.

Later deploys need no sudo: Sova tells an accept process of an older build to exit, and its unit starts the new bundle.
Only when a deploy prints "the installed sova-relay-accept.service differs from this build's" run step 2 (and 3's
`daemon-reload` plus `sudo systemctl restart sova-relay-accept`) again.

Undo (then deploy with `VPS_RELAY=off`, which stops pointing Sova at the handoff socket):

```sh
sudo systemctl disable --now sova-relay-accept.service
sudo rm /etc/systemd/system/sova-relay-accept.service && sudo systemctl daemon-reload
sudo ufw delete allow in on <public-if> to any port 4803 proto tcp
sudoedit /etc/ufw/before.rules /etc/ufw/before6.rules && sudo ufw reload   # remove the two lines from step 5
sudo userdel sova-relay && sudo rm -rf /var/lib/sova-relay                  # its outer key goes with it
```
