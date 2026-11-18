// Run: pnpm test:int -- server/share/preview-tunnel.integration.test.ts
// Free preview tunnels end to end (§mesh.public/preview-tunnels) on a throwaway server with the stand-in
// cloudflared: nothing is made before Turn On; a mint starts its app's tunnel and answers its key link; the
// key link sets the cookie and the cookie reaches the app through the share listener (the cookie itself never
// does); a seventh tunnel is refused; Turn Off stops the app's tunnel. No network, no real cloudflared.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join, resolve } from "node:path";
import { after, before, test } from "node:test";
import { startHermeticServer, type HermeticServer } from "../testing/hermetic-server";

const FAKE = resolve(import.meta.dirname, "..", "testing", "fake-cloudflared.mjs");

let s: HermeticServer;
let app: Server;
let appPort = 0;
let projectId = "";
const seen: { url: string; cookie: string }[] = [];

before(async () => {
  app = createServer((req, res) => {
    seen.push({ url: req.url ?? "", cookie: String(req.headers.cookie ?? "") });
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("the app");
  });
  await new Promise<void>((ok) => app.listen(0, "127.0.0.1", ok));
  appPort = (app.address() as AddressInfo).port;
  s = await startHermeticServer({ env: { SOVA_QUICK_TUNNEL: "on", SOVA_CLOUDFLARED: FAKE, SOVA_TUNNEL_DRIVER: "detached", SOVA_TUNNEL_VERIFY: "off" } });
  // A project to preview for (a preview belongs to one).
  const org = (await (await fetch(`${s.base}/api/orgs`, { method: "POST", headers: headers(), body: JSON.stringify({ name: "Shop", dir: join(s.scratch, "ws") }) })).json()) as { org?: { id: string }; id?: string };
  const orgId = org.org?.id ?? org.id!;
  mkdirSync(join(s.scratch, "proj"), { recursive: true });
  const page = (await (await fetch(`${s.base}/api/orgs/${orgId}/projects`, { method: "POST", headers: headers(), body: JSON.stringify({ name: "Shop", root: join(s.scratch, "proj") }) })).json()) as { projectList?: { id: string }[] };
  projectId = page.projectList?.[0]?.id ?? "";
  assert.ok(projectId, JSON.stringify(page));
});
after(async () => {
  await s?.stop();
  app?.close();
});

const headers = () => ({ "content-type": "application/json", "x-sova-token": s.token });
async function mint(port: number): Promise<{ status: number; body: Record<string, any> }> {
  const r = await fetch(`${s.base}/api/previews`, { method: "POST", headers: headers(), body: JSON.stringify({ projectId, port }) });
  return { status: r.status, body: (await r.json()) as Record<string, any> };
}
async function previews(): Promise<Record<string, any>[]> {
  const r = await fetch(`${s.base}/api/previews`, { headers: headers() });
  return ((await r.json()) as { previews: Record<string, any>[] }).previews;
}
/** One request to the share listener as cloudflared would send it (the public Host). */
function viaTunnel(listenerPort: number, host: string, path: string, cookie?: string): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }> {
  return new Promise((ok, fail) => {
    const q = request({ host: "127.0.0.1", port: listenerPort, path, method: "GET", headers: { host, accept: "text/plain", ...(cookie ? { cookie } : {}) } }, (r) => {
      let body = "";
      r.on("data", (d) => (body += d));
      r.on("end", () => ok({ status: r.statusCode ?? 0, headers: r.headers, body }));
    });
    q.on("error", fail);
    q.end();
  });
}
async function waitFor<T>(what: string, read: () => T | null | undefined | false, ms = 20_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = read();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}\n${s.log().slice(-3000)}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}
const freePort = async (): Promise<number> => {
  const t = createServer();
  await new Promise<void>((ok) => t.listen(0, "127.0.0.1", ok));
  const p = (t.address() as AddressInfo).port;
  await new Promise<void>((ok) => t.close(() => ok()));
  return p;
};

test("Free previews: Turn On first, the key link and its cookie, the cap of 6, and Turn Off stopping the tunnel", { timeout: 240_000 }, async () => {
  // Before Turn On nothing is made.
  const early = await mint(appPort);
  assert.equal(early.status, 400, JSON.stringify(early.body));
  assert.equal(early.body.code, "quick-turn-on");
  assert.deepEqual(await previews(), []);
  const tunnelsFile = join(s.agentDir, "sova", "tunnels", "tunnels.json");
  const recorded = (): Record<string, { targetPort: number }> => (existsSync(tunnelsFile) ? (JSON.parse(readFileSync(tunnelsFile, "utf8")) as { tunnels: Record<string, { targetPort: number }> }).tunnels : {});
  assert.deepEqual(Object.keys(recorded()), [], "nothing started before Turn On");

  writeFileSync(join(s.agentDir, "sova", "public-links-consent.json"), JSON.stringify({ version: 1, consentAt: Date.now() }));

  const made = await mint(appPort);
  assert.equal(made.status, 200, JSON.stringify(made.body));
  const url = new URL(made.body.url as string);
  assert.match(url.hostname, /\.trycloudflare\.com$/);
  const key = /^\/_sova\/open\/([a-z2-7]{52})\/$/.exec(url.pathname)?.[1];
  assert.ok(key, made.body.url);
  const listed = await previews();
  assert.equal(listed.length, 1);
  assert.equal(listed[0]!.url, made.body.url, "the kept link is built at the tunnel's address");
  assert.equal(listed[0]!.tunnel?.state, "up");

  // The share listener: cloudflared forwards to the port the tunnel record names.
  const listenerPort = recorded()[`preview:${appPort}`]!.targetPort;
  assert.ok(listenerPort > 0);

  const bare = await viaTunnel(listenerPort, url.host, "/");
  assert.equal(bare.status, 404, "no cookie: the unknown-preview 404");
  const open = await viaTunnel(listenerPort, url.host, `${url.pathname}deep?x=1`);
  assert.equal(open.status, 302);
  assert.equal(open.headers.location, "/deep?x=1");
  const setCookie = String(open.headers["set-cookie"]);
  assert.match(setCookie, new RegExp(`^__Host-sova-pk=${key}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=\\d+`));
  assert.equal(seen.length, 0, "the open hop never reaches the app");
  const page = await viaTunnel(listenerPort, url.host, "/deep?x=1", `__Host-sova-pk=${key}; app=1`);
  assert.equal(page.status, 200);
  assert.equal(page.body, "the app");
  assert.deepEqual(seen, [{ url: "/deep?x=1", cookie: "app=1" }], "the key cookie never reaches the app");
  // Another Host (the share host, or any other) is never this preview.
  assert.notEqual((await viaTunnel(listenerPort, "other-words.trycloudflare.com", "/", `__Host-sova-pk=${key}`)).status, 200);

  // Four more apps: five tunnels. Two new apps at once race for the sixth place: exactly one gets it.
  const ports: number[] = [];
  for (let i = 0; i < 4; i++) {
    const p = await freePort();
    ports.push(p);
    const r = await mint(p);
    assert.equal(r.status, 200, JSON.stringify(r.body));
  }
  const [a, b] = await Promise.all([mint(await freePort()), mint(await freePort())]);
  assert.deepEqual([a.status, b.status].sort(), [200, 400], JSON.stringify([a.body, b.body]));
  assert.equal((a.status === 400 ? a : b).body.code, "too-many-tunnels");
  // A seventh is refused and nothing is made; another preview of a running one's port is fine.
  const seventh = await mint(await freePort());
  assert.equal(seventh.status, 400);
  assert.equal(seventh.body.code, "too-many-tunnels");
  assert.equal((await previews()).length, 6);
  assert.equal((await mint(appPort)).status, 200, "a preview of a port that has its tunnel needs no new one");

  // Turn Off of every preview of a port stops its tunnel (the record goes).
  for (const v of (await previews()).filter((x) => x.port === ports[0])) {
    const r = await fetch(`${s.base}/api/previews/${v.id}/off`, { method: "POST", headers: headers() });
    assert.equal(r.status, 200);
  }
  await waitFor("the turned-off app's tunnel to stop", () => {
    const t = recorded();
    return !(`preview:${ports[0]}` in t) && `preview:${appPort}` in t;
  });
  // And with it the seventh place is free again.
  assert.equal((await mint(await freePort())).status, 200);
  assert.ok(existsSync(join(s.agentDir, "sova", "tunnels")));
});
