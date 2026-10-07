// Run: node scripts/run-tests.mjs server/share-front.test.ts. The gateway front's guides (snapshots)
// and Verify's judging in process, with a fetch stand-in that answers as a front would. Verify against
// loopback stub servers and the real share edge is share-front.integration.test.ts.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import type { ShareFront } from "../shared/public-links";

const root = realpathSync(mkdtempSync(join(tmpdir(), "sova-share-front-")));
process.env.PI_CODING_AGENT_DIR = join(root, "agent");
mkdirSync(join(root, "agent", "sessions"), { recursive: true });
after(() => rmSync(root, { recursive: true, force: true }));

const { frontGuide, verifyPublicUrl } = await import("./share/front");

const setting = (front: ShareFront) => ({ publicUrl: "https://share.example.com", front, sharePort: 4802, acceptFrom: "all" as const });

test("guides: every front forwards to the share port, root steps marked", () => {
  const vhost = frontGuide(setting("vhost"));
  assert.deepEqual(vhost.steps.map((s) => s.root), [true]);
  assert.match(vhost.steps[0]!.text, /server_name share\.example\.com;/);
  assert.match(vhost.steps[0]!.text, /proxy_pass http:\/\/127\.0\.0\.1:4802;/);
  assert.match(vhost.steps[0]!.text, /X-Forwarded-For \$remote_addr;/);
  // Behind a CDN that terminates TLS (Cloudflare's proxy), $remote_addr is the CDN's edge: the
  // guide says how to restore the visitor's address, trusting only the CDN's ranges.
  const cdn = (vhost.notes ?? []).filter((n) => n.includes("set_real_ip_from"));
  assert.equal(cdn.length, 1, "one vhost note covers a CDN in front");
  for (const part of ["share.example.com", "the port the CDN connects to", "real_ip_header CF-Connecting-IP", "published ranges", "never forward"])
    assert.ok(cdn[0]!.includes(part), `the CDN note says ${JSON.stringify(part)}: ${cdn[0]}`);
  assert.ok(
    vhost.notes?.some((n) => n.includes("before adding the block") && n.includes("sudo certbot certonly --nginx -d share.example.com")),
    "the vhost guide says to get the certificate first",
  );
  assert.match(vhost.steps[0]!.text, /ssl_certificate \/etc\/letsencrypt\/live\/share\.example\.com\/fullchain\.pem;\n {4}ssl_certificate_key \/etc\/letsencrypt\/live\/share\.example\.com\/privkey\.pem;/);

  const caddy = frontGuide({ ...setting("caddy"), sharePort: 4999 });
  assert.deepEqual(
    caddy.steps.map((s) => [s.root, s.text]),
    [
      [true, 'sudo setcap cap_net_bind_service=+ep "$(command -v caddy)"'],
      [false, "share.example.com {\n    reverse_proxy 127.0.0.1:4999 {\n        header_up X-Forwarded-For {remote_host}\n    }\n}"],
      [false, "caddy run --config Caddyfile"],
    ],
  );
  // Behind a CDN, {remote_host} is the CDN's edge: trust only its ranges and read its client header.
  const caddyCdn = (caddy.notes ?? []).filter((n) => n.includes("trusted_proxies"));
  assert.equal(caddyCdn.length, 1, "one caddy note covers a CDN in front");
  for (const part of ["share.example.com", "trusted_proxies static", "client_ip_headers CF-Connecting-IP", "published ranges", "{client_ip} in place of {remote_host}"])
    assert.ok(caddyCdn[0]!.includes(part), `the caddy CDN note says ${JSON.stringify(part)}: ${caddyCdn[0]}`);

  const funnel = frontGuide(setting("funnel"));
  assert.deepEqual(
    funnel.steps.map((s) => [s.root, s.text]),
    [
      [true, 'sudo tailscale set --operator="$USER"'],
      [false, "tailscale funnel --bg --https=443 http://127.0.0.1:4802"],
    ],
  );

  assert.ok(funnel.notes?.some((n) => n.startsWith("Preview: it isn't confirmed yet")), "funnel carries its preview warning");

  const cf = frontGuide(setting("cloudflared"));
  assert.ok(cf.steps.every((s) => !s.root));
  assert.match(cf.steps[1]!.text, /hostname: share\.example\.com\n {4}service: http:\/\/127\.0\.0\.1:4802\n {2}- service: http_status:404/);
  // config.yml can't set X-Forwarded-For: the guide says what it relies on, as a preview.
  assert.ok(cf.notes?.some((n) => n.startsWith("Preview:") && n.includes("X-Forwarded-For") && n.includes("isn't confirmed yet")), "cloudflared carries its preview warning");
});


/** A fetch stand-in: every request is answered by `answer`, with nothing on the wire. */
const answering = (answer: (url: string) => Response): typeof fetch => (async (input: unknown) => answer(String(input))) as typeof fetch;
/** The share edge's own 404 for an unknown link: the signature Verify looks for. */
const sovaNotFound = () =>
  new Response(JSON.stringify({ error: "Unknown link.", code: "not-found" }), { status: 404, headers: { "content-type": "application/json", "x-content-type-options": "nosniff" } });

test("verify: passes only on the gateway's 404 signature, at /api/h/<random>", async () => {
  let path = "";
  const f = answering((url) => {
    path = new URL(url).pathname;
    return sovaNotFound();
  });
  assert.deepEqual(await verifyPublicUrl("https://share.example.com", { fetch: f }), { ok: true, status: 404 });
  assert.match(path, /^\/api\/h\/[A-Za-z0-9_-]{43}$/);
  assert.deepEqual(await verifyPublicUrl("https://share.example.com/", { fetch: f }), { ok: true, status: 404 });
});


test("verify: http, a path and garbage are refused without a request", async () => {
  let called = false;
  const f: typeof fetch = async () => {
    called = true;
    throw new Error("no");
  };
  for (const u of ["http://share.example.com", "https://share.example.com/x", "https://share.example.com?q=1", "nope"])
    assert.equal((await verifyPublicUrl(u, { fetch: f })).ok, false, u);
  assert.equal(called, false);
});

test("verify: a stalled front times out", async () => {
  // Never answers: only the timeout's abort ends the request.
  const f = ((_input: unknown, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal!.reason)))) as typeof fetch;
  assert.deepEqual(await verifyPublicUrl("https://share.example.com", { fetch: f, timeoutMs: 200 }), { ok: false, error: "Timed out" });
});
