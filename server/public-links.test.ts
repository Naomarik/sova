// Run: pnpm exec tsx --test server/public-links.test.ts. A throwaway PI_CODING_AGENT_DIR in the OS
// temp dir; the share listener binds ephemeral loopback ports; ~/.pi untouched.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer, Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, describe, test } from "node:test";
import { Hono } from "hono";

const root = realpathSync(mkdtempSync(join(tmpdir(), "sova-public-links-")));
process.env.PI_CODING_AGENT_DIR = join(root, "agent");
mkdirSync(join(root, "agent"), { recursive: true });
for (const k of ["SOVA_SHARE_PUBLIC_URL", "SOVA_SHARE_HOST", "SOVA_SHARE_PORT"]) delete process.env[k];

const { LINK_WARNINGS } = await import("../shared/public-links");
const store = await import("./public-links");
const listener = await import("./share/listener");
const events = await import("./share/links-events");
const { mountPublicLinks } = await import("./public-links-routes");

after(() => {
  listener.stopShareListener();
  rmSync(root, { recursive: true, force: true });
});

const GATEWAY = { publicUrl: "https://share.example.com", front: "caddy", sharePort: 4802, acceptFrom: "all" } as const;

function reset(): void {
  rmSync(store.publicLinksFile(), { force: true });
  listener.stopShareListener();
  listener.noteVerify("", true);
}

/** A free loopback port (bound, read, released). */
async function freePort(): Promise<number> {
  const s = createServer();
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  const port = (s.address() as { port: number }).port;
  await new Promise<void>((r) => s.close(() => r()));
  return port;
}

const connects = (port: number) =>
  new Promise<boolean>((resolve) => {
    const s = new Socket();
    s.once("connect", () => (s.destroy(), resolve(true)));
    s.once("error", () => resolve(false));
    s.connect(port, "127.0.0.1");
  });

async function until(ok: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 200 && !ok(); i++) await new Promise((r) => setTimeout(r, 10));
  assert.ok(ok(), what);
}

function app(): Hono {
  const a = new Hono();
  mountPublicLinks(a);
  return a;
}
const put = (body: unknown) => ({ method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

describe("the file", () => {
  afterEach(reset);

  test("missing reads as off; a PUT writes it 0600 and it round-trips", () => {
    assert.deepEqual(store.readPublicLinks(), { version: 1, route: "off" });
    const r = store.patchPublicLinks({ route: "self", gateway: { publicUrl: "https://share.example.com/", front: "vhost" } });
    assert.ok("file" in r);
    assert.deepEqual(r.file, { version: 1, route: "self", gateway: { publicUrl: "https://share.example.com", front: "vhost", sharePort: 4802, acceptFrom: "all" } }, "defaults filled, the slash dropped");
    assert.equal(statSync(store.publicLinksFile()).mode & 0o777, 0o600);
    assert.deepEqual(store.readPublicLinks(), r.file);
    assert.deepEqual(store.parsePublicLinks(JSON.parse(readFileSync(store.publicLinksFile(), "utf8"))), r.file);
    const via = store.patchPublicLinks({ route: { via: { nodeId: "nGATEWAYCNTRL" } }, ingressPort: 4803 });
    assert.ok("file" in via);
    assert.deepEqual(via.file.gateway, r.file.gateway, "the gateway setting is kept while the route is not self");
    assert.deepEqual(store.readPublicLinks().route, { via: { nodeId: "nGATEWAYCNTRL" } });
  });

  test("strict: an unknown key or a wrong type rejects the whole file (read as off) or patch (400, nothing written)", () => {
    const bad: unknown[] = [
      { version: 1, route: "off", extra: 1 },
      { version: 2, route: "off" },
      { version: 1, route: "on" },
      { version: 1, route: "self" },
      { version: 1, route: { via: { nodeId: "a b" } } },
      { version: 1, route: { via: { nodeId: "n1" }, x: 1 } },
      { version: 1, route: "self", gateway: { ...GATEWAY, publicUrl: "http://share.example.com" } },
      { version: 1, route: "self", gateway: { ...GATEWAY, publicUrl: "https://share.example.com/x" } },
      { version: 1, route: "self", gateway: { ...GATEWAY, publicUrl: "https://u:p@share.example.com" } },
      { version: 1, route: "self", gateway: { ...GATEWAY, front: "nginx" } },
      { version: 1, route: "self", gateway: { ...GATEWAY, sharePort: 70000 } },
      { version: 1, route: "self", gateway: { ...GATEWAY, acceptFrom: ["ok", 3] } },
      { version: 1, route: "self", gateway: { ...GATEWAY, more: true } },
      { version: 1, route: "off", ingressPort: "4802" },
      { version: 1, route: "off", verifiedAt: -1 },
      [],
    ];
    for (const b of bad) assert.throws(() => store.parsePublicLinks(b), /./, JSON.stringify(b));
    writeFileSync(store.publicLinksFile(), JSON.stringify({ version: 1, route: "self", gateway: GATEWAY, extra: true }));
    assert.deepEqual(store.readPublicLinks(), { version: 1, route: "off" }, "never half-applied");
    writeFileSync(store.publicLinksFile(), "{nope");
    assert.deepEqual(store.readPublicLinks(), { version: 1, route: "off" });
    rmSync(store.publicLinksFile());
    for (const p of [{ verifiedAt: 1 }, { lastKnownUrl: "https://x.example.com" }, { version: 1 }, { route: "self" }, "off", null])
      assert.ok("error" in store.patchPublicLinks(p), JSON.stringify(p));
    assert.throws(() => statSync(store.publicLinksFile()), "a refused patch writes nothing");
  });

  test("verifiedAt is the server's, and a new address drops it", () => {
    store.patchPublicLinks({ route: "self", gateway: GATEWAY });
    store.writeServerFields({ verifiedAt: 1000 });
    assert.ok("file" in store.patchPublicLinks({ gateway: { ...GATEWAY, front: "funnel" } }));
    assert.equal(store.readPublicLinks().verifiedAt, 1000, "same address: still verified");
    store.patchPublicLinks({ gateway: { ...GATEWAY, publicUrl: "https://other.example.com" } });
    assert.equal(store.readPublicLinks().verifiedAt, undefined);
  });

  test("recordLastKnownUrl: the server's writer for a via gateway's URL; keeps the rest of the file", () => {
    store.patchPublicLinks({ route: { via: { nodeId: "nGATEWAYCNTRL" } }, ingressPort: 4803 });
    assert.deepEqual(store.recordLastKnownUrl("https://gw.example.com/"), { version: 1, route: { via: { nodeId: "nGATEWAYCNTRL" } }, ingressPort: 4803, lastKnownUrl: "https://gw.example.com" });
    assert.equal(store.readPublicLinks().lastKnownUrl, "https://gw.example.com");
    assert.equal(statSync(store.publicLinksFile()).mode & 0o777, 0o600);
    assert.throws(() => store.recordLastKnownUrl("http://gw.example.com"));
    assert.equal(store.readPublicLinks().lastKnownUrl, "https://gw.example.com", "a refused URL writes nothing");
  });

  test("pinnedByEnv lists the SOVA_SHARE_* variables that are set", () => {
    assert.deepEqual(store.pinnedByEnv({}), []);
    assert.deepEqual(store.pinnedByEnv({ SOVA_SHARE_PUBLIC_URL: "https://a.example.com", SOVA_SHARE_PORT: "4802", SOVA_SHARE_HOST: " " }), ["SOVA_SHARE_PUBLIC_URL", "SOVA_SHARE_PORT"]);
  });
});

describe("the listener follows the setting", () => {
  afterEach(reset);

  test("self binds 127.0.0.1:<sharePort>; a PUT rebinds without a restart and releases the old port; off unbinds", async () => {
    const [p1, p2] = [await freePort(), await freePort()];
    store.patchPublicLinks({ route: "self", gateway: { ...GATEWAY, sharePort: p1 } });
    assert.deepEqual(await listener.startShareListener({}), { host: "127.0.0.1", port: p1 });
    assert.equal(await connects(p1), true);
    const a = app();
    assert.equal((await a.request("/api/public-links", put({ gateway: { ...GATEWAY, sharePort: p2 } }))).status, 200);
    await until(() => listener.shareListenerState()?.port === p2, "rebound to the new port");
    assert.equal(await connects(p2), true);
    assert.equal(await connects(p1), false, "the old port is released");
    const taken = createServer();
    await new Promise<void>((r, j) => (taken.once("error", j), taken.listen(p1, "127.0.0.1", r)));
    await new Promise<void>((r) => taken.close(() => r()));
    assert.equal((await a.request("/api/public-links", put({ gateway: { ...GATEWAY, sharePort: p2, front: "funnel" } }))).status, 200);
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(listener.shareListenerState()?.port, p2, "the same address keeps its socket");
    assert.equal((await a.request("/api/public-links", put({ route: "off" }))).status, 200);
    await until(() => listener.shareListenerState() === null, "off unbinds");
    assert.equal(await connects(p2), false);
  });

  test("SOVA_SHARE_HOST and SOVA_SHARE_PORT pin the bind; the setting can't move it", async () => {
    const [p1, p2] = [await freePort(), await freePort()];
    assert.equal(await listener.startShareListener({}), null, "neither the setting nor the variables: nothing bound");
    const env = { SOVA_SHARE_HOST: "127.0.0.1", SOVA_SHARE_PORT: String(p1) };
    assert.deepEqual(listener.bindTarget({ version: 1, route: "self", gateway: { ...GATEWAY, sharePort: p2 } }, env), { host: "127.0.0.1", port: p1 });
    assert.deepEqual(listener.bindTarget({ version: 1, route: "self", gateway: { ...GATEWAY, sharePort: p2 } }, { SOVA_SHARE_PORT: String(p1) }), { host: "127.0.0.1", port: p1 });
    assert.equal(listener.bindTarget({ version: 1, route: "off" }, { SOVA_SHARE_HOST: "127.0.0.1" }), null, "one variable alone binds nothing, as before");
    assert.deepEqual(await listener.startShareListener(env), { host: "127.0.0.1", port: p1 });
    assert.equal(listener.shareState(env).source, "bound");
    assert.deepEqual(Object.keys(listener.shareInfo(env)).sort(), ["bound", "publicUrl"], "shareInfo's wire shape is unchanged");
    assert.deepEqual(listener.shareInfo(env), { bound: true, publicUrl: `http://127.0.0.1:${p1}` });
  });
});

describe("where links point", () => {
  afterEach(reset);

  test("shareState: env pin → own gateway → via gateway → bound → off, each with its state and warning", () => {
    assert.deepEqual(listener.shareState({}), { state: "off", source: "setting", publicUrl: null, warning: LINK_WARNINGS.off, warningCode: "off" });
    store.patchPublicLinks({ route: "self", gateway: GATEWAY });
    assert.deepEqual(listener.shareState({}), { state: "configured", source: "setting", publicUrl: GATEWAY.publicUrl, warning: LINK_WARNINGS.unverified, warningCode: "unverified" });
    store.writeServerFields({ verifiedAt: Date.now() });
    assert.deepEqual(listener.shareState({}), { state: "verified", source: "setting", publicUrl: GATEWAY.publicUrl });
    listener.noteVerify(GATEWAY.publicUrl, false);
    assert.equal(listener.shareState({}).state, "unreachable", "the last check failed");
    assert.equal(listener.shareState({}).warningCode, "unverified");
    listener.noteVerify(GATEWAY.publicUrl, true);
    const pinned = listener.shareState({ SOVA_SHARE_PUBLIC_URL: "https://pin.example.com/" });
    assert.equal(pinned.source, "env");
    assert.equal(pinned.publicUrl, "https://pin.example.com", "the pin wins over the setting");
    store.patchPublicLinks({ route: { via: { nodeId: "nGATEWAYCNTRL" } } });
    assert.equal(listener.shareState({}).state, "off", "a via gateway with no address known yet");
    store.writeServerFields({ lastKnownUrl: "https://gw.example.com" });
    assert.deepEqual(listener.shareState({}), {
      state: "configured",
      source: "gateway",
      publicUrl: "https://gw.example.com",
      warning: LINK_WARNINGS.unconfirmed.replaceAll("{gateway}", "the gateway"),
      warningCode: "unconfirmed",
    });
  });

  test("/h/ and /i/ links come from one helper, on the effective address or as a path", () => {
    const t = "A".repeat(43);
    assert.equal(listener.linkUrl("h", t, {}), `/h/${t}`);
    assert.equal(listener.linkUrl("i", t, {}), `/i/${t}`);
    const env = { SOVA_SHARE_PUBLIC_URL: "https://pin.example.com" };
    assert.equal(listener.linkUrl("h", t, env), `https://pin.example.com/h/${t}`);
    assert.equal(listener.linkUrl("i", t, env), `https://pin.example.com/i/${t}`);
  });

  test("linkWarning: the address's warning first, else the mint's: unconfirmed when a listener timed out or failed", async () => {
    assert.deepEqual(listener.linkWarning(undefined, {}), { linkWarning: LINK_WARNINGS.off, linkWarningCode: "off" });
    store.patchPublicLinks({ route: "self", gateway: GATEWAY });
    assert.deepEqual(listener.linkWarning(undefined, {}), { linkWarning: LINK_WARNINGS.unverified, linkWarningCode: "unverified" });
    store.writeServerFields({ verifiedAt: Date.now() });
    assert.deepEqual(listener.linkWarning(undefined, {}), {});
    assert.deepEqual(listener.linkWarning({ warning: null, timedOut: false, failed: false }, {}), {});
    const unconfirmed = { linkWarning: LINK_WARNINGS.unconfirmed.replaceAll("{gateway}", "the gateway"), linkWarningCode: "unconfirmed" };
    const stuck = events.onShareLinksChanged(() => new Promise(() => {}));
    const late = await events.awaitShareLinks(() => events.shareLinksChanged({ kind: "h", cause: "mint" }), 30);
    stuck();
    assert.deepEqual(listener.linkWarning(late.outcome, {}), unconfirmed);
    const broken = events.onShareLinksChanged(() => {
      throw new Error("push failed");
    });
    const failed = await events.awaitShareLinks(() => events.shareLinksChanged({ kind: "i", cause: "mint" }));
    broken();
    assert.deepEqual(listener.linkWarning(failed.outcome, {}), unconfirmed);
    const said = LINK_WARNINGS["not-accepted"].replaceAll("{gateway}", "the gateway");
    assert.deepEqual(listener.linkWarning({ warning: said, timedOut: false, failed: false }, {}), { linkWarning: said });
  });
});

describe("the routes", () => {
  afterEach(reset);

  test("GET and PUT answer PublicLinksInfo; the chosen front's guide for self; 400 names the problem", async () => {
    const a = app();
    const got = await (await a.request("/api/public-links")).json();
    assert.deepEqual(got.file, { version: 1, route: "off" });
    assert.equal(got.share.state, "off");
    assert.equal(got.front, undefined);
    const res = await a.request("/api/public-links", put({ route: "self", gateway: GATEWAY }));
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("cache-control"), "no-store");
    const info = await res.json();
    assert.equal(info.share.source, "setting");
    assert.equal(info.front.front, "caddy");
    assert.ok(Array.isArray(info.front.steps));
    const bad = await a.request("/api/public-links", put({ verifiedAt: 5 }));
    assert.equal(bad.status, 400);
    assert.match((await bad.json()).error, /unknown key "verifiedAt"/);
    assert.equal((await a.request("/api/public-links", { method: "PUT", body: "{" })).status, 400);
  });

  test("pinnedByEnv reports the variables that win", async () => {
    process.env.SOVA_SHARE_PUBLIC_URL = "https://pin.example.com";
    try {
      const info = await (await app().request("/api/public-links")).json();
      assert.deepEqual(info.pinnedByEnv, ["SOVA_SHARE_PUBLIC_URL"]);
      assert.equal(info.share.source, "env");
    } finally {
      delete process.env.SOVA_SHARE_PUBLIC_URL;
    }
  });

  test("refused from the peer listener and through a proxy (X-Forwarded-Host): the plain 404, nothing written", async () => {
    const a = app();
    const peer = { meshPeer: { id: "p", nodeId: "n1" } };
    for (const [path, init] of [
      ["/api/public-links", {}],
      ["/api/public-links", put({ route: "self", gateway: GATEWAY })],
      ["/api/public-links/verify", { method: "POST" }],
    ] as const) {
      assert.equal((await a.request(path, init, peer)).status, 404, `peer ${path}`);
      const headers = { ...((init as { headers?: Record<string, string> }).headers ?? {}), "X-Forwarded-Host": "front.example.com" };
      assert.equal((await a.request(path, { ...init, headers })).status, 404, `proxied ${path}`);
    }
    assert.throws(() => statSync(store.publicLinksFile()));
  });

  test("Verify checks the effective address; a failure reads unreachable and drops verifiedAt", async () => {
    const a = app();
    const none = await (await a.request("/api/public-links/verify", { method: "POST" })).json();
    assert.equal(none.ok, false);
    store.patchPublicLinks({ route: "self", gateway: { ...GATEWAY, publicUrl: "https://127.0.0.1:1" } });
    store.writeServerFields({ verifiedAt: 1 });
    const r = await (await a.request("/api/public-links/verify", { method: "POST" })).json();
    assert.equal(r.ok, false);
    assert.equal(store.readPublicLinks().verifiedAt, undefined);
    assert.equal(listener.shareState({}).state, "unreachable");
  });
});
