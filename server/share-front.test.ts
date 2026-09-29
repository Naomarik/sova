// Run: pnpm exec tsx --test server/share-front.test.ts. The gateway front's guides (snapshots) and
// Verify against loopback stub servers; https is rewritten to the stub's http by an injected fetch.
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
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
const { createShareServer } = await import("./share/edge");

const setting = (front: ShareFront) => ({ publicUrl: "https://share.example.com", front, sharePort: 4802, acceptFrom: "all" as const });

test("guides: every front forwards to the share port, root steps marked", () => {
  const vhost = frontGuide(setting("vhost"));
  assert.deepEqual(vhost.steps.map((s) => s.root), [true]);
  assert.match(vhost.steps[0]!.text, /server_name share\.example\.com;/);
  assert.match(vhost.steps[0]!.text, /proxy_pass http:\/\/127\.0\.0\.1:4802;/);
  assert.match(vhost.steps[0]!.text, /X-Forwarded-For \$remote_addr;/);

  const caddy = frontGuide({ ...setting("caddy"), sharePort: 4999 });
  assert.deepEqual(
    caddy.steps.map((s) => [s.root, s.text]),
    [
      [true, 'sudo setcap cap_net_bind_service=+ep "$(command -v caddy)"'],
      [false, "share.example.com {\n    reverse_proxy 127.0.0.1:4999 {\n        header_up X-Forwarded-For {remote_host}\n    }\n}"],
      [false, "caddy run --config Caddyfile"],
    ],
  );

  const funnel = frontGuide(setting("funnel"));
  assert.deepEqual(
    funnel.steps.map((s) => [s.root, s.text]),
    [
      [true, 'sudo tailscale set --operator="$USER"'],
      [false, "tailscale funnel --bg --https=443 http://127.0.0.1:4802"],
    ],
  );

  const cf = frontGuide(setting("cloudflared"));
  assert.ok(cf.steps.every((s) => !s.root));
  assert.match(cf.steps[1]!.text, /hostname: share\.example\.com\n {4}service: http:\/\/127\.0\.0\.1:4802\n {2}- service: http_status:404/);
});

const servers: Server[] = [];
after(() => servers.forEach((s) => s.close()));
async function stub(handler: Parameters<typeof createServer>[1]): Promise<typeof fetch> {
  const s = createServer(handler);
  servers.push(s);
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  const port = (s.address() as AddressInfo).port;
  return (input, init) => fetch(String(input).replace("https://share.example.com", `http://127.0.0.1:${port}`), init);
}
const sovaNotFound = (_req: unknown, res: import("node:http").ServerResponse) => {
  res.writeHead(404, { "content-type": "application/json", "x-content-type-options": "nosniff" });
  res.end(JSON.stringify({ error: "Unknown link.", code: "not-found" }));
};

test("verify: passes only on the gateway's 404 signature, at /api/h/<random>", async () => {
  let path = "";
  const f = await stub((req, res) => {
    path = req.url ?? "";
    sovaNotFound(req, res);
  });
  assert.deepEqual(await verifyPublicUrl("https://share.example.com", { fetch: f }), { ok: true, status: 404 });
  assert.match(path, /^\/api\/h\/[A-Za-z0-9_-]{43}$/);
  assert.deepEqual(await verifyPublicUrl("https://share.example.com/", { fetch: f }), { ok: true, status: 404 });
});

test("verify: another server's 404, a 200 and a redirect fail", async () => {
  const other = await stub((_q, res) => res.writeHead(404).end("nope"));
  assert.equal((await verifyPublicUrl("https://share.example.com", { fetch: other })).ok, false);
  const ok200 = await stub((_q, res) => res.writeHead(200).end("hi"));
  assert.deepEqual(await verifyPublicUrl("https://share.example.com", { fetch: ok200 }), { ok: false, status: 200, error: "Got 200, not Sova's answer" });
  let followed = false;
  const redirect = await stub((req, res) => {
    if (req.url === "/elsewhere") followed = true;
    res.writeHead(302, { location: "/elsewhere" }).end();
  });
  const r = await verifyPublicUrl("https://share.example.com", { fetch: redirect });
  assert.equal(r.ok, false);
  assert.equal(r.status, 302);
  assert.equal(followed, false);
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
  const f = await stub(() => {}); // never answers
  assert.deepEqual(await verifyPublicUrl("https://share.example.com", { fetch: f, timeoutMs: 200 }), { ok: false, error: "Timed out" });
});

test("verify: the real share edge answers the signature", async () => {
  const s = createShareServer();
  servers.push(s);
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  const port = (s.address() as AddressInfo).port;
  const f: typeof fetch = (input, init) => fetch(String(input).replace("https://share.example.com", `http://127.0.0.1:${port}`), init);
  assert.deepEqual(await verifyPublicUrl("https://share.example.com", { fetch: f }), { ok: true, status: 404 });
});
