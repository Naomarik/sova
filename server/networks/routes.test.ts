// The Access page's network routes (server/networks/routes.ts, §app.access/networks), the store behind them
// (server/networks/store.ts) and where each trusted range listens (resolveEntries), in process: a fixture
// interface table stands in for the system and a table for the route probe, so no socket opens and no program
// runs. The listeners themselves, over real sockets, are server/trusted-networks.integration.test.ts.
import { dropScratchAgentDir } from "../testing/scratch-agent-dir";
import assert from "node:assert/strict";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { after, afterEach, beforeEach, describe, test } from "node:test";
import { Hono } from "hono";
import type { IfaceAddress } from "./detect";

delete process.env.SOVA_AUTH;
delete process.env.HOST;
const { registerNetworkRoutes, checkRange } = await import("./routes");
const { setProbeForTest } = await import("./probe");
const { readTrusted, trustedFile } = await import("./store");
const { resolveEntries } = await import("./listeners");
const { classifyNetworks } = await import("./detect");
const { AUTH_COOKIE, sovaToken } = await import("../auth");

const ZERO = "00:00:00:00:00:00";
const v4 = (address: string, prefix: number, mac = "3c:22:fb:11:22:33"): IfaceAddress => ({ address, netmask: "", family: "IPv4", mac, internal: false, cidr: `${address}/${prefix}` });
const SYSTEM = {
  platform: "linux" as const,
  interfaces: { wg0: [v4("10.8.0.2", 24, ZERO)], wlan0: [v4("192.168.1.23", 24)], tun0: [v4("10.211.0.6", 32, ZERO)] },
  facts: { wg0: { devtype: "wireguard", virtual: true, up: true }, wlan0: { devtype: "wlan", wireless: true, physical: true, up: true }, tun0: { tun: true, virtual: true, up: true } },
  routes: {},
};
/** Where the system would route each address from: the company VPN's pool goes through tun0. */
const ROUTES: Record<string, string> = { "10.224.0.1": "10.211.0.6", "10.250.0.1": "192.168.1.23" };

const app = new Hono();
registerNetworkRoutes(app);
const SOCKET = { incoming: {} };
const page = () => ({ host: "127.0.0.1:4800", cookie: `${AUTH_COOKIE}=${sovaToken()}`, "content-type": "application/json" });
const ask = (method: string, path: string, body?: unknown, headers: Record<string, string> = page(), env: object = SOCKET) =>
  app.fetch(new Request(`http://127.0.0.1:4800${path}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), env);

beforeEach(() => setProbeForTest({ system: () => SYSTEM, route: (a) => ROUTES[a] ?? null }));
afterEach(() => {
  setProbeForTest(null);
  delete process.env.HOST;
  writeFileSync(trustedFile(), "{}");
});
after(() => dropScratchAgentDir());

describe("a range's check, before the confirmation", () => {
  test("a public or unparsable range is refused with the rule's own words", async () => {
    for (const range of ["8.8.8.0/24", "0.0.0.0/0", "nonsense"]) {
      const check = await checkRange(range);
      assert.equal(check.ok, false, range);
      assert.match(check.error!, range === "nonsense" ? /isn't a range/ : /Only private ranges/);
    }
  });

  test("a listed VPN's range: its address, interface and size, no warning", async () => {
    assert.deepEqual(await checkRange("10.8.0.0/24"), { ok: true, range: "10.8.0.0/24", count: 256, countLabel: "256", needsRetype: false, address: "10.8.0.2", iface: "wg0", kind: "wireguard", vpn: true, networkCount: 256 });
  });

  test("a range wider than the network it sits on says so; above 65,536 addresses the range must be typed again", async () => {
    const wide = await checkRange("10.8.0.0/16");
    assert.equal(wide.iface, "wg0");
    assert.match(wide.warning!, /larger than WireGuard · wg0 \(256 addresses\)/);
    assert.equal(wide.needsRetype, false);
    const huge = await checkRange("10.0.0.0/8");
    assert.equal(huge.needsRetype, true);
    assert.equal(huge.countLabel, "16,777,216");
  });

  test("a typed company range reached through a tunnel is that tunnel's; one reached only over Wi-Fi is marked not a VPN", async () => {
    const pool = await checkRange("10.224.0.0/22");
    assert.deepEqual([pool.address, pool.iface, pool.vpn, pool.warning], ["10.211.0.6", "tun0", true, undefined]);
    const wifi = await checkRange("192.168.1.0/24");
    assert.deepEqual([wifi.iface, wifi.vpn, wifi.warning], ["wlan0", false, undefined], "the page says the Wi-Fi warning itself");
    const routedOverWifi = await checkRange("10.250.0.0/24");
    assert.deepEqual([routedOverWifi.iface, routedOverWifi.vpn], ["wlan0", false]);
    assert.match((await checkRange("192.168.0.0/16")).warning!, /larger than Wi-Fi · wlan0/, "a wider range on a LAN still says so");
  });

  test("a range no network of this computer reaches is allowed, with that said", async () => {
    const none = await checkRange("172.20.0.0/16");
    assert.equal(none.ok, true);
    assert.equal(none.address, undefined);
    assert.match(none.warning!, /No network of this computer reaches that range/);
  });
});

describe("trusting and stopping", () => {
  test("only the operator's page may trust: a script's token, a chat's key, a peer, a relayed call and a tour recorder are refused", async () => {
    const body = { range: "10.8.0.0/24" };
    const token = { host: "127.0.0.1:4800", "x-sova-token": sovaToken(), "content-type": "application/json" };
    const script = await ask("POST", "/api/auth/networks/trust", body, token);
    assert.equal(script.status, 403);
    assert.equal(((await script.json()) as { yourClick?: boolean }).yourClick, true);
    assert.equal((await ask("POST", "/api/auth/networks/trust", body, { ...page(), "x-sova-caller": "chat-key" })).status, 403);
    assert.equal((await ask("POST", "/api/auth/networks/trust", body, page(), { incoming: {}, meshPeer: { id: "p" } })).status, 403);
    assert.equal((await ask("POST", "/api/auth/networks/trust", body, { ...page(), "x-sova-relayed": "1" })).status, 403);
    assert.equal((await ask("POST", "/api/auth/networks/trust", body, { ...page(), "x-sova-tour-recorder": "1" })).status, 403);
    assert.equal((await ask("POST", "/api/auth/networks/trust", body, { host: "127.0.0.1:4800", "content-type": "application/json" }, {})).status, 403, "an in-process dispatch shows no page");
    assert.deepEqual(readTrusted(), [], "nothing was trusted");
  });

  test("the page's Trust keeps the range at 0600 with the network it was trusted on, and lists it", async () => {
    const res = await ask("POST", "/api/auth/networks/trust", { range: "10.8.0.7/24" });
    assert.equal(res.status, 200);
    const view = (await res.json()) as { trusted: Array<Record<string, unknown>>; networks: Array<{ iface: string; trusted: boolean }> };
    assert.deepEqual(view.trusted.map((t) => [t.range, t.address, t.iface, t.kind, t.label]), [["10.8.0.0/24", "10.8.0.2", "wg0", "wireguard", "WireGuard · wg0"]]);
    assert.deepEqual(view.networks.map((n) => [n.iface, n.trusted]), [["tun0", false], ["wg0", true], ["wlan0", false]]);
    assert.equal(statSync(trustedFile()).mode & 0o777, 0o600);
    assert.deepEqual(readTrusted().map((e) => [e.range, e.iface, e.kind]), [["10.8.0.0/24", "wg0", "wireguard"]]);
  });

  test("a public range is refused at Trust too, and a range above 65,536 addresses needs the range typed again", async () => {
    assert.equal((await ask("POST", "/api/auth/networks/trust", { range: "8.8.8.0/24" })).status, 400);
    const unconfirmed = await ask("POST", "/api/auth/networks/trust", { range: "10.0.0.0/8" });
    assert.equal(unconfirmed.status, 400);
    assert.equal(((await unconfirmed.json()) as { needsRetype?: boolean }).needsRetype, true);
    assert.equal((await ask("POST", "/api/auth/networks/trust", { range: "10.0.0.0/8", confirm: "10.0.0.0/9" })).status, 400);
    assert.deepEqual(readTrusted(), []);
    assert.equal((await ask("POST", "/api/auth/networks/trust", { range: "10.0.0.0/8", confirm: " 10.1.2.3/8 " })).status, 200, "the same range, however typed");
    assert.deepEqual(readTrusted().map((e) => e.range), ["10.0.0.0/8"]);
  });

  test("on a server that answers on every network there is nothing to trust per network", async () => {
    process.env.HOST = "0.0.0.0";
    assert.equal((await ask("POST", "/api/auth/networks/trust", { range: "10.8.0.0/24" })).status, 409);
    const view = (await (await ask("GET", "/api/auth/networks")).json()) as { wildcard: boolean };
    assert.equal(view.wildcard, true);
  });

  test("Stop Trusting needs no page and removes the range; an untrusted range is a 404; every route is local-only", async () => {
    await ask("POST", "/api/auth/networks/trust", { range: "10.8.0.0/24" });
    const token = { host: "127.0.0.1:4800", "x-sova-token": sovaToken(), "content-type": "application/json" };
    assert.equal((await ask("POST", "/api/auth/networks/untrust", { range: "10.8.0.0/24" }, token, { incoming: {}, meshPeer: { id: "p" } })).status, 403);
    assert.equal((await ask("POST", "/api/auth/networks/untrust", { range: "10.8.0.0/24" }, { ...token, "x-sova-relayed": "1" })).status, 403);
    assert.equal((await ask("GET", "/api/auth/networks", undefined, page(), { incoming: {}, meshPeer: { id: "p" } })).status, 403);
    assert.equal((await ask("POST", "/api/auth/networks/check", { range: "10.8.0.0/24" }, page(), { incoming: {}, meshPeer: { id: "p" } })).status, 403);
    const res = await ask("POST", "/api/auth/networks/untrust", { range: "10.8.0.0/24" }, token);
    assert.equal(res.status, 200);
    assert.deepEqual(((await res.json()) as { trusted: unknown[] }).trusted, []);
    assert.equal((await ask("POST", "/api/auth/networks/untrust", { range: "10.8.0.0/24" }, token)).status, 404);
  });
});

describe("the store", () => {
  test("a damaged file is no trust at all, and an entry naming a public range is dropped", () => {
    writeFileSync(trustedFile(), "{not json");
    assert.deepEqual(readTrusted(), []);
    writeFileSync(trustedFile(), JSON.stringify({ networks: [{ range: "8.8.8.0/24" }, { range: "10.8.0.9/24", iface: "wg0" }, { range: "10.8.0.0/24" }, "junk"] }));
    assert.deepEqual(readTrusted().map((e) => [e.range, e.iface]), [["10.8.0.0/24", "wg0"]], "normalized, one entry per range");
    assert.ok(readFileSync(trustedFile(), "utf8").includes("8.8.8.0"), "reading never rewrites the file");
  });
});

describe("where a trusted range listens", () => {
  const networks = classifyNetworks(SYSTEM);
  const at = (range: string, iface?: string) => resolveEntries([{ range, ...(iface ? { iface } : {}), addedAt: "" }], networks, async (a) => ROUTES[a] ?? null);

  test("at this computer's address inside it; else its interface's; else the address its range is routed from", async () => {
    assert.equal((await at("10.8.0.0/24"))[0]!.address, "10.8.0.2");
    assert.equal((await at("10.99.0.0/24", "wg0"))[0]!.address, "10.8.0.2", "the VPN's own range moved: its interface follows");
    assert.deepEqual((await at("10.224.0.0/22")).map((r) => [r.address, r.iface]), [["10.211.0.6", "tun0"]]);
  });

  test("nowhere while its network is down, with why", async () => {
    const down = await at("10.77.0.0/24", "wg9");
    assert.equal(down[0]!.address, null);
    assert.match(down[0]!.why!, /wg9 isn't connected/);
    assert.match((await at("172.20.0.0/16"))[0]!.why!, /No network of this computer reaches/);
  });
});
