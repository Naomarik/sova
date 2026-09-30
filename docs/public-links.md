# Public links

[← Sova](../README.md)

Public links let people who can't reach your machine open what you share with them: a read-only
session share (`/s/`), and an organization's hand-off (`/h/`) and owner page (`/i/`) links. They open
on an address you set up, such as `https://share.example.com`. Recipients need no account, no app
and no tailnet.

Sova's own page never goes public. Public links use a separate **share port** (4802 by default) that
binds `127.0.0.1` only and serves nothing but share pages, their data and their images. In front of
it sits a **front** you run: a web server or tunnel that holds the certificate for your public address and
forwards it to the share port. Sova shows you the front's steps and checks the result, but it never
runs or writes the front's configuration.

```
recipient's browser ──https──▶ your front (Caddy, nginx, a CDN, Funnel or Cloudflare Tunnel)
                                    │ http to 127.0.0.1:4802
                                    ▼
                               Sova's share port on the gateway host
```

The host that serves public links is the **gateway**. On a single machine that is simply your
machine; with several Sova hosts, one gateway can serve the links of all of them
([Route other hosts through a gateway](#route-other-hosts-through-a-gateway)).

## Before you start

- A Sova with public links: installed from `vNEXT` or later, or a source checkout of `master`.
  `pnpm run build` (which the installer runs) also builds the share page; without it, a link
  answers "The share page is not built on this host."
- A domain name you control, such as `share.example.com`.
- A machine people can reach on ports 80 and 443. With no public IP, use a tunnel instead
  ([Cloudflare Tunnel](#cloudflare-tunnel) or [Tailscale Funnel](#tailscale-funnel)).
- Sova kept running. Links open only while the host that made them is on, so an always-on
  machine is best: `scripts/install.sh --service` installs a login service that keeps it up.

## Set up a single host with Caddy

This is the shortest path, and needs nothing but Sova, [Caddy](https://caddyserver.com) and a DNS
record: no Tailscale, no mesh, no CDN. Caddy gets and renews the certificate on its own.

1. **Point the name at the machine.** At your DNS provider, add an `A` record for
   `share.example.com` with the machine's public IP (and an `AAAA` record if it has IPv6). Check it
   with `dig +short share.example.com`.
2. **Open 80 and 443, and nothing of Sova's.** Caddy needs 80 and 443 for the certificate and the
   links. Sova's ports (4800, and 4802 for the share port) bind `127.0.0.1` and stay closed in your
   firewall. With ufw: `sudo ufw allow 80/tcp && sudo ufw allow 443/tcp`.
3. **Turn on the gateway.** In Sova, open Settings → **Public links**. Under **Where links open**,
   choose **This host is the gateway**. Enter `https://share.example.com` as the **Public address**
   (just the origin: no path and no trailing slash), pick **Caddy on this host** as the **Front**,
   keep **Local port** at 4802, and press **Save Changes**. The mesh can stay off.

   The state chip now reads `Not verified`. If it reads `Not listening` instead, the share port
   couldn't open, and the banner under the address says why; see
   [When something doesn't work](#when-something-doesnt-work).
4. **Set up the front once.** Under "Set up the front once", Sova shows the steps for your address.
   Install Caddy from your distribution or caddyserver.com, then run them in order: the `setcap`
   step (marked `Needs root`) so Caddy can bind 80 and 443, the Caddyfile, and `caddy run`. The
   Caddyfile is short:

   ```
   share.example.com {
       reverse_proxy 127.0.0.1:4802 {
           header_up X-Forwarded-For {remote_host}
       }
   }
   ```

   If your distribution's Caddy package already runs as a service, add this site block to its
   Caddyfile (usually `/etc/caddy/Caddyfile`) and reload it (`sudo systemctl reload caddy`) instead;
   the service can already bind 80 and 443, so skip `setcap`.
5. **Verify.** Press **Verify Address**. Sova fetches a made-up link from `https://share.example.com`
   and passes only when its own share port answers. A pass reads "Verified {time}.
   https://share.example.com reaches this gateway." and the chip turns `Verified`. A failure says
   "Couldn't reach https://share.example.com." with the reason; links still open on your own
   devices meanwhile.
6. **Share something.** [Share a session](#share-a-session) and open the link on a phone with
   Wi-Fi off. Every link Sova makes from now on starts with your public address.

## When something doesn't work

**`Not listening`: "The share port isn't open."** Sova couldn't bind the share port. The reason
says which case it is:

| Reason | What to do |
|---|---|
| Another program is already using 127.0.0.1:4802. | Stop that program, or save a different **Local port** and use it in your front too. |
| This host doesn't let Sova use port {port}. | Ports below 1024 need privileges. Keep the share port above 1024; only the front binds 443. |
| {host} isn't an address of this host. | `SOVA_SHARE_HOST` names an address this machine doesn't have. Fix or unset it. |
| SOVA_SHARE_PORT isn't a port number. | Set it to a number from 1 to 65535, or unset it. |
| Couldn't open {host}:{port} ({code}). | Something else went wrong; the code names it, and the server log has the same line. |

Fix the cause, then save a different port or restart Sova.

**Verify fails.** The reason is Sova's own:

| Reason | Usually means |
|---|---|
| Couldn't connect | DNS doesn't point at the front yet, the firewall blocks 443, or the front isn't running. |
| Timed out | Something drops the connection: a firewall, or a front that never answers. Verify gives up after 8 seconds. |
| It redirects; the front must forward, not redirect | The front answers with a redirect, for example from a leftover `return 301` or an "Always use HTTPS" rule on the https address itself. Forward everything to the share port. |
| Got {status}, not Sova's answer | The front answered but didn't reach the share port. A 502 usually means nothing listens on the port it forwards to. |
| Something else answered, not Sova | The front forwards somewhere else, such as another site or Sova's main port 4800. Forward to the share port. |
| The public address must start with https:// | Verify only checks https addresses. An `http://` address pinned by `SOVA_SHARE_PUBLIC_URL` works for testing but never reads `Verified`. |

**A link says "The share page is not built on this host."** Run `pnpm run build` in Sova's
directory (re-running the installer does it too), then open the link again.

**Every visitor seems to share one rate limit.** The front isn't passing the visitor's address. The
share port trusts `X-Forwarded-For` only from its own machine and reads its last value, so the
front must replace that header with the address it saw. Behind a CDN, restore the visitor's
address first ([Behind a CDN](#behind-a-cdn)).

## Other fronts

Pick the front under **Front** and save; Sova shows the matching steps with your address filled in.
Anything else works as long as it terminates TLS for your address, forwards every path and WebSocket
upgrade to `127.0.0.1:4802`, and sets `X-Forwarded-For` to the visitor's address (replacing it, never
appending).

### Your existing web server

For a machine that already runs nginx (or Apache, or another server) on 80 and 443. Choose
**Your web server**; Sova shows an nginx server block. As root:

1. Add the DNS record, as in step 1 above.
2. Get a certificate first, so the block's `listen 443 ssl` has one:
   `sudo certbot certonly --nginx -d share.example.com`. Add its two lines to the block:
   `ssl_certificate /etc/letsencrypt/live/share.example.com/fullchain.pem;` and
   `ssl_certificate_key /etc/letsencrypt/live/share.example.com/privkey.pem;`.
3. Put the block in a file of its own, such as `/etc/nginx/conf.d/zz-sova-share.conf`. Name it so
   it sorts after your existing default site, or mark that site `default_server`: nginx answers an
   unknown hostname with the first server block for the port, and that should never be Sova's.
4. `sudo nginx -t && sudo systemctl reload nginx`, then **Verify Address**.

To undo, remove the file and run the same test and reload.

### Behind a CDN

With a CDN or proxy that terminates TLS for your address, such as Cloudflare's proxied DNS, your
web server listens where the CDN connects (often port 80) and never sees visitors directly.
Choose **Your web server**, and make the DNS record a proxied one at the CDN.

Without more, `X-Forwarded-For` would carry the CDN's address, and every visitor would share one
rate limit. So restore the visitor's address from the CDN's client header first, trusting that
header only from the CDN's published ranges. Anyone who reaches your server directly can set it.
For Cloudflare, write the ranges to a file of their own:

```sh
{ for r in $(curl -fsS https://www.cloudflare.com/ips-v4) $(curl -fsS https://www.cloudflare.com/ips-v6); do
    echo "set_real_ip_from $r;"
  done
  echo "real_ip_header CF-Connecting-IP;"
} | sudo tee /etc/nginx/cloudflare-realip.conf >/dev/null
```

Then use this block, in `/etc/nginx/conf.d/zz-sova-share.conf` for the naming reason above:

```nginx
server {
    listen 80;
    listen [::]:80;
    server_name share.example.com;
    include /etc/nginx/cloudflare-realip.conf;

    # a visitor who came in over plain http goes to https at the CDN
    if ($http_x_forwarded_proto = "http") { return 301 https://$host$request_uri; }

    access_log /var/log/nginx/sova-share.access.log;
    error_log  /var/log/nginx/sova-share.error.log;

    location / {
        proxy_pass http://127.0.0.1:4802;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $remote_addr;
        proxy_set_header X-Forwarded-Proto https;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_read_timeout 1h;
    }
}
```

`$remote_addr` is the visitor's address once the realip lines have run. Test and reload as above.
The CDN's ranges change now and then: re-run the range script and reload nginx from time to time,
for example monthly from root's crontab
(`sudo nginx -t && sudo systemctl reload nginx` after it). Keep the CDN's own "Always use HTTPS"
off, or leave it on and drop the redirect line above; either way Verify must get Sova's answer, not a
redirect.

With **Caddy** behind a CDN, `{remote_host}` is the CDN's address in the same way. Add the ranges
to Caddy's global options and forward `{client_ip}` instead:

```
{
    servers {
        trusted_proxies static <every range the CDN publishes, space-separated>
        client_ip_headers CF-Connecting-IP
    }
}
share.example.com {
    reverse_proxy 127.0.0.1:4802 {
        header_up X-Forwarded-For {client_ip}
    }
}
```

### Tailscale Funnel

Funnel publishes one port of a tailnet machine at its `ts.net` name, with no DNS record, open port
or certificate to manage. Choose **Tailscale Funnel**. The public address is the machine's
`https://<machine>.<tailnet>.ts.net`. Your tailnet policy must allow Funnel for the machine: a
`nodeAttrs` entry whose `attr` includes `"funnel"` and whose `target` covers it. Then run the steps:
`sudo tailscale set --operator="$USER"` once, and
`tailscale funnel --bg --https=443 http://127.0.0.1:4802`. Funnel only the share port, never Sova's
main, peer or front door ports.

Funnel is a preview front: it isn't confirmed yet that it passes each visitor's address or keeps
live updates open. Verify after setting it up.

### Cloudflare Tunnel

The tunnel dials out, so it works with no public IP and no open port. Choose **Cloudflare Tunnel**
and run the steps: `cloudflared tunnel create sova-share` and
`cloudflared tunnel route dns sova-share share.example.com` (which makes the DNS record), the
`config.yml` Sova shows, and `cloudflared tunnel run sova-share`. Keep it running as a service
(`cloudflared service install`, per Cloudflare's docs).

This front is a preview too: `config.yml` can't set `X-Forwarded-For`, so it relies on the
tunnel's own ending with the visitor's address. Until that's confirmed, every visitor may share one
rate limit.

## Pin it with environment variables

Three variables win over the setting. The panel shows a pinned field as "Set by environment" and
won't edit it; change the variable, then restart Sova.

| Variable | What it does |
|---|---|
| `SOVA_SHARE_PUBLIC_URL` | The address every link is built on. Just an `http://` or `https://` origin; anything else is ignored with one warning in the log, and the setting decides. It doesn't make the host a gateway by itself. |
| `SOVA_SHARE_HOST` | The address the share port binds (the gateway default is `127.0.0.1`). |
| `SOVA_SHARE_PORT` | The share port (the gateway default is 4802). |

With both `SOVA_SHARE_HOST` and `SOVA_SHARE_PORT` set, Sova binds the share port there even with
Public links off, which suits a single host set up only by its service's environment:

```sh
SOVA_SHARE_HOST=127.0.0.1 SOVA_SHARE_PORT=4802 SOVA_SHARE_PUBLIC_URL=https://share.example.com sova
```

For a quick test with no certificate, `SOVA_SHARE_PUBLIC_URL=http://…` is accepted; links work, but
Verify only checks https, so the state stays `Not verified`.

## Route other hosts through a gateway

With several Sova hosts in a [mesh](mesh.md), only one needs a public address. Each other host sends
its links through that gateway: it tells the gateway a hash of each live link (never the link or
its content), and the gateway forwards requests for those links to it over the tailnet. The host that
made a link still serves it, so its links open only while it's on.

This needs [Tailscale](https://tailscale.com) or Headscale on every host, because hosts prove who
they are with Tailscale's identity. A plain WireGuard or Nebula network can't route links.

1. **Pair the hosts** on the Mesh page, as in [docs/mesh.md](mesh.md), and set up the gateway as above.
2. **On the gateway**, under **Accept links from**, keep **All hosts** or tick the hosts you want.
3. **On each other host**, Settings → Public links → **Through {gateway}**, and **Save Changes**.
   It binds an **Ingress port** (4802 by default) on its tailnet address that admits only the
   gateway. Your firewall must let the gateway reach it over the tailnet.
4. The gateway's **Hosts sending links here** lists each routed host with its link count and when
   it last pushed.

If a routed host's link carries a warning, Settings says why: the gateway doesn't accept this host
yet (add it under the gateway's **Accept links from**), or it can't be reached.

## Set up a gateway with no page

A headless gateway, such as a VPS whose page you only reach over ssh, can be set through its own
API on its main port (4800 by default, bound to `127.0.0.1`). The API refuses requests that come
through the mesh or a proxy. Over ssh on the gateway:

```sh
curl -fsS -X PUT http://127.0.0.1:4800/api/public-links -H 'content-type: application/json' \
  -d '{"route": "self", "gateway": {"publicUrl": "https://share.example.com", "front": "caddy"}}'
```

The answer is the whole state as JSON, with the front's steps under `front.steps` (each with a
`label`, whether it needs `root`, and its `text`). To read them later, and to verify:

```sh
curl -fsS http://127.0.0.1:4800/api/public-links
curl -fsS -X POST http://127.0.0.1:4800/api/public-links/verify   # {"ok": true} when it passes
```

`front` is one of `vhost`, `caddy`, `funnel` or `cloudflared`; add `"sharePort"` or `"acceptFrom"`
(`"all"` or a list of Tailscale StableIDs) to the gateway to change their defaults. A routed host is
set the same way, with the gateway's StableID:
`{"route": {"via": {"nodeId": "<gateway StableID>"}}}`. `{"route": "off"}` turns public links off
and keeps the gateway's settings for next time. A bad body answers 400 with the problem, and
nothing is written.

The VPS kit in `scripts/mesh-vps/` deploys Sova to a VPS on your tailnet, with the root steps for
each front in its [SUDO.md](../scripts/mesh-vps/SUDO.md).

## Share a session

A session share is a read-only page of a conversation: the messages you and the model wrote, with
their images and drawings, and nothing else. Thinking, tool calls and their output, file paths,
costs and model names never leave your machine, and known secrets are taken out of the text. Text
the model wrote about a file is still text, though, so read the preview before you send anything.

1. Open the session, then **Session details → Sharing**, and press **Share Session**.
2. To share part of it, tap the first message you want, then the last. Leave them unset to share
   the whole session. **Preview** shows exactly what recipients will see.
3. Press **Next**. Set the public title (the session's title may say more than you mean), add one
   line per person, or turn on **Anyone with the link**, and pick when the links expire (1 to 90 days).
4. Choose **Follow live** to keep the page updated as the session goes on; without it, recipients
   see a snapshot of what you previewed. A slice with a last message is always a snapshot; one with
   only a first message can follow live from there on.
5. **Create Links** shows each person's link once. Copy it and send it however you like.

Each person gets a link of their own, so you can see who opened it and turn off one without the
others. Manage a share from its **Manage** button in the Sharing tab, or from **Shares** at the
bottom of the sidebar, which lists every public link this host and its peers serve. From there you
can add people, extend, update a snapshot to now, change the slice, or **Stop Sharing**.

If a new link comes with a warning, such as "This link may not open from outside yet", it will work
on your own devices, and **Open Settings** takes you to what's missing.
