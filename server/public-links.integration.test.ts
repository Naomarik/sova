// Run: node scripts/run-tests.mjs server/public-links.integration.test.ts. The share listener
// following the setting, a share port that won't open, Verify against a real address, and the via
// PUT's real 3 s wait (§mesh.public/via-answer, measured with a generous upper bound). A throwaway
// PI_CODING_AGENT_DIR in the OS temp dir; the share listener binds ephemeral loopback ports; ~/.pi
// untouched. The file, where links point and the routes in process are public-links.test.ts.
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
const { gatewayHooks } = await import("./share/router");

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

/** Resolves once `ok` holds, checked every 10 ms; fails after 10 s (a hang guard, not a bound). */
async function until(ok: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 1000 && !ok(); i++) await new Promise((r) => setTimeout(r, 10));
  assert.ok(ok(), what);
}

function app(): Hono {
  const a = new Hono();
  mountPublicLinks(a);
  return a;
}
const put = (body: unknown) => ({ method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

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

  test("each bound server's gateway router is disposed on rebind, off, stop and a failed bind; the same address keeps it", async () => {
    const made: { disposed: number }[] = [];
    const hooks = () => {
      const real = gatewayHooks();
      const rec = { disposed: 0 };
      made.push(rec);
      return { ...real, dispose: () => (rec.disposed++, real.dispose()) };
    };
    const [p1, p2] = [await freePort(), await freePort()];
    store.patchPublicLinks({ route: "self", gateway: { ...GATEWAY, sharePort: p1 } });
    await listener.startShareListener({}, { hooks });
    assert.deepEqual(made.map((r) => r.disposed), [0]);
    const a = app();
    await a.request("/api/public-links", put({ gateway: { ...GATEWAY, sharePort: p2 } }));
    await until(() => listener.shareListenerState()?.port === p2, "rebound");
    assert.deepEqual(made.map((r) => r.disposed), [1, 0], "the old server's router is disposed, the new one is live");
    await a.request("/api/public-links", put({ gateway: { ...GATEWAY, sharePort: p2, front: "funnel" } }));
    await new Promise((r) => setTimeout(r, 50));
    assert.deepEqual(made.map((r) => r.disposed), [1, 0], "same address: same server, same router");
    await a.request("/api/public-links", put({ route: "off" }));
    await until(() => listener.shareListenerState() === null, "off");
    assert.deepEqual(made.map((r) => r.disposed), [1, 1]);
    const taken = createServer();
    await new Promise<void>((r) => taken.listen(p1, "127.0.0.1", r));
    try {
      store.patchPublicLinks({ route: "self", gateway: { ...GATEWAY, sharePort: p1 } });
      assert.equal(await listener.startShareListener({}, { hooks }), null, "the port is taken");
      assert.equal(made.at(-1)!.disposed, 1, "a bind that failed leaves no router behind");
    } finally {
      await new Promise<void>((r) => taken.close(() => r()));
    }
    store.patchPublicLinks({ route: "self", gateway: { ...GATEWAY, sharePort: p2 } });
    await listener.startShareListener({}, { hooks });
    listener.stopShareListener();
    assert.equal(made.at(-1)!.disposed, 1, "stop disposes it");
    assert.ok(made.every((r) => r.disposed === 1), "each router disposed exactly once");
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

describe("a share port that won't open (§mesh.public/listener-failure)", () => {
  afterEach(reset);

  test("a taken port shows on the state with its reason; a PUT answers after the rebind, and a bind that works clears it", async () => {
    const [p1, p2] = [await freePort(), await freePort()];
    const taken = createServer();
    await new Promise<void>((r) => taken.listen(p1, "127.0.0.1", r));
    try {
      store.patchPublicLinks({ route: "self", gateway: { ...GATEWAY, sharePort: p1 } });
      assert.equal(await listener.startShareListener({}), null);
      const s = listener.shareState({});
      assert.deepEqual(s.listener, { host: "127.0.0.1", port: p1, reason: `Another program is already using 127.0.0.1:${p1}.` });
      assert.deepEqual([s.state, s.source, s.publicUrl, s.warningCode], ["configured", "setting", GATEWAY.publicUrl, "unverified"], "the other fields stay as they were");
      const a = app();
      const got = (await (await a.request("/api/public-links")).json()) as { share: { listener?: unknown } };
      assert.equal((got.share.listener as { port: number }).port, p1, "GET carries it");
      const moved = (await (await a.request("/api/public-links", put({ gateway: { ...GATEWAY, sharePort: p2 } }))).json()) as { share: { listener?: unknown } };
      assert.equal(moved.share.listener, undefined, "the PUT's own answer: bound, no failure");
      assert.equal(listener.shareListenerState()?.port, p2);
      const back = (await (await a.request("/api/public-links", put({ gateway: { ...GATEWAY, sharePort: p1 } }))).json()) as { share: { listener?: { port: number } } };
      assert.equal(back.share.listener?.port, p1, "the PUT's own answer carries a failed rebind");
      await a.request("/api/public-links", put({ route: "off" }));
      assert.equal(listener.shareState({}).listener, undefined, "a setting that binds nothing clears it");
    } finally {
      await new Promise<void>((r) => taken.close(() => r()));
    }
  });

  test("a SOVA_SHARE_PORT that isn't a port is a failure when a bind is wanted, and nothing otherwise", async () => {
    const env = { SOVA_SHARE_HOST: "127.0.0.1", SOVA_SHARE_PORT: "48o2" };
    assert.equal(await listener.startShareListener(env), null);
    assert.deepEqual(listener.shareState(env).listener, { host: "127.0.0.1", port: null, reason: "SOVA_SHARE_PORT isn't a port number." });
    store.patchPublicLinks({ route: "self", gateway: GATEWAY });
    assert.equal(await listener.startShareListener({ SOVA_SHARE_PORT: "70000" }), null);
    assert.equal(listener.shareState({ SOVA_SHARE_PORT: "70000" }).listener?.reason, "SOVA_SHARE_PORT isn't a port number.");
    store.patchPublicLinks({ route: "off" });
    assert.equal(await listener.startShareListener({ SOVA_SHARE_PORT: "70000" }), null);
    assert.equal(listener.shareState({ SOVA_SHARE_PORT: "70000" }).listener, undefined, "the setting binds nothing and the host isn't pinned: no bind was wanted");
  });
});

describe("the routes", () => {
  afterEach(reset);

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

test("a via PUT with no answer from the gateway answers after the real 3 s wait, not before and not much later (§mesh.public/via-answer)", async () => {
  const gw = await import("./share/gateway-client");
  const PEER = { id: "gw", nodeId: "nGATEWAYCNTRL", label: "gw", dnsName: "gw.example.invalid", url: "http://100.64.0.9:4801" };
  let answer: "now" | "never" = "now";
  const undo = gw.setGatewayDeps({
    peers: () => [PEER],
    endpoint: async () => "http://gw.example.invalid",
    recordUrl: () => {},
    call: async (url: string) =>
      answer === "never"
        ? new Promise(() => {})
        : url.endsWith("/api/peer/hello")
          ? { status: 200, body: { mesh: 1, shareGateway: { publicUrl: "https://gw.example.com" } } }
          : { status: 200, body: { publicUrl: "https://gw.example.com", accepting: true, seq: null } },
  } as never);
  const via = put({ route: { via: { nodeId: "nGATEWAYCNTRL" } } });
  try {
    store.patchPublicLinks({ route: "off" });
    gw.resetGatewayClient();
    const now = await (await app().request("/api/public-links", via)).json();
    assert.deepEqual([now.share.state, now.share.source, now.share.publicUrl, now.share.warningCode], ["verified", "gateway", "https://gw.example.com", undefined]);

    store.patchPublicLinks({ route: "off" });
    gw.resetGatewayClient();
    answer = "never";
    const t = Date.now();
    const slow = await (await app().request("/api/public-links", via)).json();
    const took = Date.now() - t;
    assert.equal(slow.share.state, "off", "nothing learnt: the state as it stands");
    // The wait itself, in real time: never early, and an upper bound only to catch a wait that
    // doesn't end (the stepped twin in public-links.test.ts checks what it waits on).
    assert.ok(took >= 2900 && took < 15_000, `answered after the 3 s wait: ${took} ms`);
  } finally {
    undo();
    gw.resetGatewayClient();
    store.patchPublicLinks({ route: "off" });
  }
});
