// The share tunnel's wiring on real processes (§mesh.tunnel/lifetime, §mesh/tunnel): under Cloudflare Free,
// after Turn On, the first share starts the tunnel (the fake cloudflared, detached driver), binds the share
// listener on loopback and answers a full https:// link; the share host then fails closed by Host; a revoke
// that leaves nothing shared stops the tunnel and lets the listener go. Never the network.
import { dropScratchAgentDir } from "../../testing/scratch-agent-dir";
import assert from "node:assert/strict";
import { request } from "node:http";
import { join } from "node:path";
import { after, test } from "node:test";

const HOST = "able-baker-charlie-delta.trycloudflare.com";
process.env.SOVA_QUICK_TUNNEL = "on";
process.env.SOVA_CLOUDFLARED = join(import.meta.dirname, "..", "..", "testing", "fake-cloudflared.mjs");
process.env.SOVA_TUNNEL_DRIVER = "detached";
process.env.SOVA_TUNNEL_VERIFY = "off";
process.env.FAKE_CF_HOSTNAME = HOST;
for (const k of ["SOVA_SHARE_PUBLIC_URL", "SOVA_SHARE_HOST", "SOVA_SHARE_PORT"]) delete process.env[k];

const store = await import("../../public-links");
const listener = await import("../listener");
const { awaitShareLinks } = await import("../links-events");
const batonLinks = await import("../../baton-links");
const manager = await import("./manager");
const wiring = await import("./wiring");

after(async () => {
  wiring.stopTunnelWiring();
  await manager.stopTunnel({ kind: "share" }, "test over").catch(() => undefined);
  listener.stopShareListener();
  dropScratchAgentDir();
});

/** One GET to the bound share listener with this Host; its status. */
function get(port: number, path: string, host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path, method: "GET", headers: { host } }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on("error", reject);
    req.end();
  });
}

test("Free: before Turn On a share starts nothing; after it the first share answers a full link, and the share host fails closed", async () => {
  await listener.startShareListener(process.env);
  await wiring.startTunnelWiring({ env: process.env });
  assert.equal(listener.shareListenerState(), null, "nothing bound at idle");

  // Before Turn On: the link is made, not public, and no tunnel starts.
  const before = await awaitShareLinks(() => batonLinks.mintLink({ orgId: "o1", sessionId: "s1", n: 1, personId: "p1" }));
  assert.equal(listener.linkWarning(before.outcome).linkWarningCode, "quick-turn-on");
  assert.equal(manager.tunnelStatus({ kind: "share" }).state, "stopped");
  assert.equal(listener.shareListenerState(), null);

  store.recordTunnelConsent();
  const { result: token, outcome } = await awaitShareLinks(() => batonLinks.mintLink({ orgId: "o1", sessionId: "s1", n: 2, personId: "p1" }));
  const url = listener.linkUrl("h", token);
  assert.equal(url, `https://${HOST}/h/${token}`, "a full link at the tunnel's address");
  assert.equal(listener.linkWarning(outcome).linkWarningCode, "quick", "with Free's own note");
  const bound = listener.shareListenerState();
  assert.ok(bound && bound.host === "127.0.0.1", "bound on loopback only");
  assert.ok(![4800, 4801, 4810].includes(bound.port), "never Sova's own port");

  // The same request, only the Host differs: the tunnel's host reaches the share routes, any other doesn't.
  // The page shell: answered whatever the link holds (here 503: no share page is built), never 404.
  const path = `/h/${token}`;
  const own = await get(bound.port, path, HOST);
  assert.notEqual(own, 404, "the tunnel's own host reaches the share routes");
  assert.equal(await get(bound.port, path, "other-words-here-now.trycloudflare.com"), 404, "another tunnel's host is the plain 404");
  assert.equal(await get(bound.port, path, "share.example.com"), 404);

  // Nothing shared any more: the tunnel stops and the listener lets go.
  batonLinks.revokeLinks(() => true);
  const until = Date.now() + 20_000;
  while ((manager.tunnelStatus({ kind: "share" }).state !== "stopped" || listener.shareListenerState()) && Date.now() < until) await new Promise((r) => setTimeout(r, 50));
  assert.equal(manager.tunnelStatus({ kind: "share" }).state, "stopped", "stopped at the last revoke");
  assert.equal(listener.shareListenerState(), null, "listener released");
});
