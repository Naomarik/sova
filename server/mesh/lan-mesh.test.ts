// Run: pnpm test -- server/mesh/lan-mesh.test.ts
// Dial-out pairings' Mesh page routes on this host's own app, in-process (§mesh/lan): built with
// nothing started, so no relay listener ever binds: who may call the routes, what a relay setting
// and a pairing may be, and that a pairing whose grant can't be written is not made. Both channels
// end to end, over real TLS: lan-mesh.integration.test.ts.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import type { LanStatus } from "../../shared/mesh-lan";
import { testApp } from "./app-test-fixtures";

const tmp = mkdtempSync(join(tmpdir(), "sova-lan-mesh-unit-"));
process.env.PI_CODING_AGENT_DIR = join(tmp, "agent");
mkdirSync(join(tmp, "agent", "sessions", "live"), { recursive: true });

const { setIdentity } = await import("./localapi");
// No tailnet at all: a host whose only peers are pairings never asks for one.
let tailscaleAsked = 0;
setIdentity({
  status: async () => {
    tailscaleAsked++;
    throw new Error("no tailscale here");
  },
  whois: async () => {
    tailscaleAsked++;
    return null;
  },
});

const app = await testApp();
const { listenerInfo, stopMesh } = await import("./index");
const { mintLanIdentity, parsePin } = await import("./lan-cert");
const { accessFile } = await import("./access");
// The mesh's link transfers probe tar when it starts: answered here, so no tar runs.
(await import("./links-transfer")).setTarAvailableForTest(true);

after(() => {
  stopMesh();
  rmSync(tmp, { recursive: true, force: true });
});

const api = async <T>(method: string, path: string, body?: unknown): Promise<[number, T]> => {
  const res = await app.request(path, {
    method,
    headers: body !== undefined ? { "content-type": "application/json" } : {},
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return [res.status, (await res.json()) as T];
};
const lan = async () => (await api<LanStatus>("GET", "/api/mesh/lan"))[1];

test("the pairing routes are this host's own browser's only", async () => {
  for (const [method, path] of [
    ["GET", "/api/mesh/lan"],
    ["POST", "/api/mesh/lan/key"],
    ["POST", "/api/mesh/lan/pairings"],
    ["PUT", "/api/mesh/lan/relay"],
  ] as const) {
    const res = await app.request(path, { method, headers: { "X-Sova-Relayed": "1" } });
    assert.equal(res.status, 404, `${method} ${path} relayed`);
    await res.body?.cancel();
  }
  const [, before] = await api<LanStatus>("GET", "/api/mesh/lan");
  assert.equal(before.fingerprint, undefined, "no key until asked for");
  assert.deepEqual(before.pairings, []);
});

describe("this host as the relay", () => {
  const other = mintLanIdentity();
  let relayPin = "";

  before(async () => {
    const [, key] = await api<LanStatus>("POST", "/api/mesh/lan/key");
    relayPin = parsePin(key.fingerprint)!;
    assert.ok(relayPin);
    const [s1, r1] = await api<LanStatus>("PUT", "/api/mesh/lan/relay", { relay: { host: "127.0.0.1", port: 0 } });
    assert.equal(s1, 200, JSON.stringify(r1));
    assert.equal(r1.relay?.listening, false, "no listener before a pairing exists");
  });

  test("a LAN relay setting takes only a local-network address of this host; no internet relay without an accept process", async () => {
    const bad: Array<[unknown, RegExp]> = [
      [{ host: "203.0.113.7", port: 4803 }, /public address/],
      [{ host: "2001:db8::7", port: 4803 }, /public address/],
      [{ host: "0::", port: 4803 }, /every interface/],
      [{ host: "::ffff:0.0.0.0", port: 4803 }, /every interface/],
      // Private, but not an address of this host.
      [{ host: "10.255.255.254", port: 4803 }, /not an address of this host/],
    ];
    for (const [relay, why] of bad) {
      const [status, r] = await api<{ error: string }>("PUT", "/api/mesh/lan/relay", { relay });
      assert.equal(status, 400, JSON.stringify(relay));
      assert.match(r.error, why, JSON.stringify(relay));
    }
    // This host has no SOVA_RELAY_HANDOFF, so no accept process can be running.
    const [status, r] = await api<{ error: string }>("PUT", "/api/mesh/lan/relay", { relay: { host: "127.0.0.1", port: 4803, exposure: "internet" } });
    assert.equal(status, 409);
    assert.equal(r.error, "the accept process isn't running (SUDO.md §5)");
    assert.equal((await lan()).acceptor.state, "not configured");
    assert.equal((await lan()).relay?.host, "127.0.0.1", "the setting is unchanged");
    assert.equal((await lan()).relay?.exposure, "lan");
  });

  test("a bad pairing is refused whole", async () => {
    const bad: Array<[unknown, RegExp]> = [
      [{ id: "laptop", role: "accept", pin: "1234" }, /32 hex/],
      [{ id: "Laptop!", role: "accept", pin: other.pin }, /id must/],
      [{ id: "laptop", role: "both", pin: other.pin }, /role/],
      [{ id: "laptop", role: "accept", pin: relayPin }, /own fingerprint/],
      [{ id: "laptop", role: "dial", pin: other.pin, host: "0.0.0.0", port: 1 }, /host/],
      [{ id: "laptop", role: "dial", pin: other.pin, host: "198.51.100.7", port: 1 }, /public address/],
      [{ id: "laptop", role: "accept", pin: other.pin, grant: "root" }, /grant/],
    ];
    for (const [body, why] of bad) {
      const [status, r] = await api<{ error: string }>("POST", "/api/mesh/lan/pairings", body);
      assert.equal(status, 400, JSON.stringify(body));
      assert.match(r.error, why);
    }
  });

  test("M1: a pairing whose grant can't be written is not made, and a refused one never touches an existing grant", async () => {
    // An existing pairing, with presence (nothing listens: nothing was started).
    const [made] = await api("POST", "/api/mesh/lan/pairings", { id: "laptop", label: "Laptop", role: "accept", pin: other.pin });
    assert.equal(made, 200);
    assert.equal(listenerInfo(), null, "no tailnet listener for a pairing alone");
    const before = readFileSync(join(tmp, "agent", "sova", "peers.json"), "utf8");
    writeFileSync(accessFile(), "{broken");
    const [status, r] = await api<{ error: string }>("POST", "/api/mesh/lan/pairings", { id: "second", role: "accept", pin: mintLanIdentity().pin, grant: "presence" });
    assert.equal(status, 409, JSON.stringify(r));
    assert.match(r.error, /grant couldn't be written/);
    assert.equal(readFileSync(join(tmp, "agent", "sova", "peers.json"), "utf8"), before, "peers.json untouched");
    rmSync(accessFile(), { force: true });
    // A refused pairing never touches an existing pairing's grant either.
    await api("PUT", "/api/mesh/access", { peer: "laptop", grant: { preset: "presence" } });
    const [dup] = await api("POST", "/api/mesh/lan/pairings", { id: "again", role: "accept", pin: other.pin, grant: "full" });
    assert.equal(dup, 400);
    const [, view] = await api<{ peers: Array<{ id: string; grant?: { preset: string } }> }>("GET", "/api/mesh/access");
    assert.equal(view.peers.find((p) => p.id === "laptop")?.grant?.preset, "presence");
    assert.equal(tailscaleAsked, 0, "nothing ever asked Tailscale");
  });
});
