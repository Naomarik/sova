import { randomBytes } from "node:crypto";
import type { FrontGuide, ShareGatewaySetting, VerifyResult } from "../../shared/public-links";

/**
 * The gateway's front (§mesh.public/front): the steps for the chosen front, generated from the
 * setting and never run by Sova, and Verify.
 *
 * Every front forwards the public hostname to 127.0.0.1:<sharePort>. The nginx, Caddy and Funnel
 * snippets overwrite X-Forwarded-For with the one client address they saw (the share listener
 * trusts the last value from its local proxy, §mesh.public/forwarded-for); a tunnel's config.yml
 * can't set a header, so the Cloudflare Tunnel guide says it relies on the tunnel's own. The share
 * edge itself refuses every path but the share ones, so no snippet needs a path filter.
 */

export function frontGuide(setting: ShareGatewaySetting): FrontGuide {
  const host = hostOf(setting.publicUrl);
  const upstream = `127.0.0.1:${setting.sharePort}`;
  switch (setting.front) {
    case "vhost":
      return {
        front: "vhost",
        steps: [
          {
            label: "Add this server block to nginx, then reload it",
            root: true,
            text: [
              "server {",
              "    listen 443 ssl;",
              "    listen [::]:443 ssl;",
              `    server_name ${host};`,
              `    ssl_certificate /etc/letsencrypt/live/${host}/fullchain.pem;`,
              `    ssl_certificate_key /etc/letsencrypt/live/${host}/privkey.pem;`,
              "    location / {",
              `        proxy_pass http://${upstream};`,
              "        proxy_http_version 1.1;",
              "        proxy_set_header Host $host;",
              "        proxy_set_header X-Forwarded-For $remote_addr;",
              "        proxy_set_header X-Forwarded-Proto https;",
              "        proxy_set_header Upgrade $http_upgrade;",
              '        proxy_set_header Connection "upgrade";',
              "        proxy_read_timeout 1h;",
              "    }",
              "}",
            ].join("\n"),
          },
        ],
        notes: [
          `Get the certificate for ${host} before adding the block (nginx won't load a server block whose certificate is missing): sudo certbot certonly --nginx -d ${host}. With a certificate from elsewhere, put its paths in the two ssl_ lines instead.`,
          `Another web server works the same way: terminate TLS for ${host}, forward everything to http://${upstream}, pass WebSocket upgrades, and set X-Forwarded-For to the client address (replace it, never append).`,
          `Behind a CDN that terminates TLS for ${host} (such as Cloudflare's proxy): listen on the port the CDN connects to instead of 443, and restore the visitor's address first, or X-Forwarded-For carries the CDN's. In the server block, add set_real_ip_from for each of the CDN's published ranges, and real_ip_header with its client header (real_ip_header CF-Connecting-IP for Cloudflare). Trust that header only this way, and never forward it as it is: anyone who reaches this server directly can set it.`,
        ],
      };
    case "caddy":
      return {
        front: "caddy",
        steps: [
          {
            label: "Let Caddy bind ports 80 and 443 (once)",
            root: true,
            text: 'sudo setcap cap_net_bind_service=+ep "$(command -v caddy)"',
          },
          {
            label: "Caddyfile",
            root: false,
            text: [`${host} {`, `    reverse_proxy ${upstream} {`, "        header_up X-Forwarded-For {remote_host}", "    }", "}"].join("\n"),
          },
          { label: "Run Caddy", root: false, text: "caddy run --config Caddyfile" },
        ],
        notes: [
          `Caddy gets the certificate for ${host} itself: its DNS must point at this host, and ports 80 and 443 must be open.`,
          "Re-run the setcap step after upgrading the caddy binary.",
          `Behind a CDN that terminates TLS for ${host} (such as Cloudflare's proxy), {remote_host} is the CDN's address. In the Caddyfile's global options, add a servers block with trusted_proxies static and the CDN's published ranges, and client_ip_headers with its client header (client_ip_headers CF-Connecting-IP for Cloudflare); then forward {client_ip} in place of {remote_host}. Trust that header only this way: anyone who reaches this host directly can set it.`,
        ],
      };
    case "funnel":
      return {
        front: "funnel",
        steps: [
          { label: "Let your user run Tailscale Funnel (once)", root: true, text: 'sudo tailscale set --operator="$USER"' },
          { label: "Start the funnel", root: false, text: `tailscale funnel --bg --https=443 http://${upstream}` },
        ],
        notes: [
          "The public address is this machine's ts.net name, and Funnel must be allowed for it in the tailnet policy.",
          "Funnel only ever the share port: never the main, peer or front door ports.",
          "Preview: it isn't confirmed yet that Funnel passes on each visitor's address or keeps live updates open. Use Verify after setting it up.",
        ],
      };
    case "cloudflared":
      return {
        front: "cloudflared",
        steps: [
          { label: "Create the tunnel and its DNS name", root: false, text: `cloudflared tunnel create sova-share\ncloudflared tunnel route dns sova-share ${host}` },
          {
            label: "~/.cloudflared/config.yml",
            root: false,
            text: [
              "tunnel: sova-share",
              "credentials-file: <the .json path printed by tunnel create>",
              "ingress:",
              `  - hostname: ${host}`,
              `    service: http://${upstream}`,
              "  - service: http_status:404",
            ].join("\n"),
          },
          { label: "Run the tunnel", root: false, text: "cloudflared tunnel run sova-share" },
        ],
        notes: [
          "Preview: config.yml can't set X-Forwarded-For, so this relies on the tunnel's own ending with each visitor's address, which isn't confirmed yet. Until it is, every visitor may share one rate limit.",
        ],
      };
  }
}

function hostOf(publicUrl: string): string {
  try {
    return new URL(publicUrl).host;
  } catch {
    return publicUrl;
  }
}

export const VERIFY_TIMEOUT_MS = 8000;

export interface VerifyOptions {
  timeoutMs?: number;
  /** Tests only: the fetch to use. */
  fetch?: typeof fetch;
}

/**
 * Fetch `<publicUrl>/api/h/<random token>` and pass only on the share app's own answer for an
 * unknown link: 404, JSON `{code: "not-found"}` and its `X-Content-Type-Options: nosniff`. The
 * page shell (`/h/<token>`) answers 200 for any token by design (no validity oracle), so it
 * can't tell the gateway apart from any other server. https only; a redirect is a failure.
 */
export async function verifyPublicUrl(url: string, opts: VerifyOptions = {}): Promise<VerifyResult> {
  let base: URL;
  try {
    base = new URL(url);
  } catch {
    return { ok: false, error: "Not a URL" };
  }
  if (base.protocol !== "https:") return { ok: false, error: "The public address must start with https://" };
  if ((base.pathname !== "/" && base.pathname !== "") || base.search || base.hash || base.username || base.password)
    return { ok: false, error: "The public address must have no path, query or login" };
  const token = randomBytes(32).toString("base64url");
  const target = `${base.origin}/api/h/${token}`;
  let res: Response;
  try {
    res = await (opts.fetch ?? fetch)(target, {
      redirect: "manual",
      signal: AbortSignal.timeout(opts.timeoutMs ?? VERIFY_TIMEOUT_MS),
      headers: { accept: "application/json" },
    });
  } catch (err) {
    const name = (err as { name?: string }).name;
    return { ok: false, error: name === "TimeoutError" || name === "AbortError" ? "Timed out" : "Couldn't connect" };
  }
  const status = res.status;
  if (status >= 300 && status < 400) return { ok: false, status, error: "It redirects; the front must forward, not redirect" };
  if (status !== 404) return { ok: false, status, error: `Got ${status}, not Sova's answer` };
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  const sova = (body as { code?: unknown } | null)?.code === "not-found" && res.headers.get("x-content-type-options") === "nosniff";
  return sova ? { ok: true, status } : { ok: false, status, error: "Something else answered, not Sova" };
}
