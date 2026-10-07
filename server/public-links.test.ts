// Run: node scripts/run-tests.mjs server/public-links.test.ts. A throwaway PI_CODING_AGENT_DIR in the OS
// temp dir; ~/.pi untouched. The file, where links point and the routes, in process; the share listener
// following the setting, a port that won't open, Verify and the via PUT's real 3 s wait are
// public-links.integration.test.ts.
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

  test("publicUrl: only the canonical bare https origin; nothing the URL parser would rewrite", () => {
    for (const ok of ["https://share.example.com", "https://share.example.com/", "https://share.example.com:8443", "https://[::1]:8443", " https://share.example.com "])
      assert.equal(store.parsePublicUrl(ok), ok.trim().replace(/\/$/, ""), ok);
    const bad = [
      "https://host\\evil",
      "https://host\\@other",
      "https://host\\",
      "https://share.example.com\\",
      "https://sha\nre.example.com",
      "https://share.example.com\t/",
      "https://share.example.com?",
      "https://share.example.com#",
      "https://share.example.com/.",
      "https://share.example.com/%2e",
      "https://share.example.com/private/..",
      "https://share.example.com\\private",
      "https://share.example.com//",
      "https:share.example.com",
      "https:/share.example.com",
      "https:///share.example.com",
      "https://share.example.com:443",
      "https://SHARE.example.com",
      "HTTPS://share.example.com",
      "https://user@share.example.com",
      "https://:@share.example.com",
      "https://share.example.com/x",
      "http://share.example.com",
    ];
    for (const v of bad) assert.throws(() => store.parsePublicUrl(v), /publicUrl/, JSON.stringify(v));
    assert.ok("error" in store.patchPublicLinks({ route: "self", gateway: { ...GATEWAY, publicUrl: "https://host\\" } }));
  });

  test("the SOVA_SHARE_PUBLIC_URL pin: http allowed, the rest of the rule applies; a refused pin warns once and counts as no pin", () => {
    const pin = (v: string) => store.sharePin({ SOVA_SHARE_PUBLIC_URL: v });
    assert.equal(pin("https://share.example.com/"), "https://share.example.com");
    assert.equal(pin(" http://100.64.0.1:4802 "), "http://100.64.0.1:4802", "a tailnet http pin still works");
    assert.equal(pin("http://[fd7a::1]:4802"), "http://[fd7a::1]:4802");
    const warned: string[] = [];
    const warn = console.warn;
    console.warn = (...a: unknown[]) => void warned.push(a.join(" "));
    try {
      const bad = [
        "https://host\\evil",
        "https://host\\@other",
        "https://host\\",
        "https://sha re.example.com",
        "https://sha\u0001re.example.com",
        "https://user:pw@share.example.com",
        "https://:@share.example.com",
        "https://share.example.com?x=1",
        "https://share.example.com?",
        "https://share.example.com#top",
        "https://share.example.com/x",
        "https://share.example.com/.",
        "https://share.example.com//",
        "ftp://share.example.com",
        "not a url",
      ];
      for (const v of bad) assert.equal(pin(v), null, JSON.stringify(v));
      assert.equal(warned.length, bad.length, "one warning per refused pin");
      assert.ok(warned.every((w) => w.includes("SOVA_SHARE_PUBLIC_URL ignored")));
      for (const v of bad) pin(v);
      assert.equal(warned.length, bad.length, "and only once each, however often it is read");
      const env = { SOVA_SHARE_PUBLIC_URL: "https://share.example.com/x" };
      assert.deepEqual(store.pinnedByEnv(env), [], "a refused pin is no pin");
      assert.equal(listener.shareState(env).state, "off", "nothing else set: off");
      store.patchPublicLinks({ route: "self", gateway: GATEWAY });
      assert.deepEqual([listener.shareState(env).source, listener.shareState(env).publicUrl], ["setting", GATEWAY.publicUrl], "the setting decides");
      assert.equal(listener.linkUrl("h", "A".repeat(43), env), `${GATEWAY.publicUrl}/h/${"A".repeat(43)}`);
    } finally {
      console.warn = warn;
    }
  });

  test("one strict parser (M5's rules): the stored file has every gateway key, no duplicate, URLs in their exact form; a PUT may leave the defaults out", () => {
    const g = { ...GATEWAY };
    const file = (gateway: unknown, more: object = {}) => ({ version: 1, route: "self", gateway, ...more });
    const { sharePort: _p, ...noPort } = g;
    const { acceptFrom: _a, ...noAccept } = g;
    const { front: _f, ...noFront } = g;
    for (const [what, raw] of [
      ["missing sharePort", file(noPort)],
      ["missing acceptFrom", file(noAccept)],
      ["missing front", file(noFront)],
      ["acceptFrom twice", file({ ...g, acceptFrom: ["n1", "n1"] })],
      ["stored URL with a trailing slash", file({ ...g, publicUrl: "https://share.example.com/" })],
      ["lastKnownUrl with a trailing slash", { version: 1, route: "off", lastKnownUrl: "https://gw.example.com/" }],
      ["backslash URL", file({ ...g, publicUrl: "https://share.example.com\\private" })],
    ] as const)
      assert.throws(() => store.parsePublicLinks(raw), /./, what);
    assert.deepEqual(store.parsePublicLinks(file(g)), file(g), "a whole, canonical file parses as itself");
    const put = store.patchPublicLinks({ route: "self", gateway: { publicUrl: "https://share.example.com/", front: "vhost" } });
    assert.ok("file" in put && put.file.gateway?.sharePort === 4802 && put.file.gateway.acceptFrom === "all" && put.file.gateway.publicUrl === "https://share.example.com");
    assert.ok("error" in store.patchPublicLinks({ gateway: { ...g, acceptFrom: ["n1", "n1"] } }), "a PUT's duplicate is refused, never quietly dropped");
  });

  test("a bad file is warned about once per version, never quoting it", () => {
    const warned: string[] = [];
    const warn = console.warn;
    console.warn = (...a: unknown[]) => void warned.push(a.join(" "));
    try {
      writeFileSync(store.publicLinksFile(), JSON.stringify({ version: 1, route: "off", secretish: "tok-XYZ" }));
      for (let i = 0; i < 5; i++) assert.deepEqual(store.readPublicLinks(), { version: 1, route: "off" });
      assert.equal(warned.length, 1, "once, however often it is read");
      assert.match(warned[0]!, /public-links\.json ignored/);
      assert.ok(!/secretish|tok-XYZ/.test(warned[0]!), "the file's contents are never logged");
      writeFileSync(store.publicLinksFile(), "{nope");
      store.readPublicLinks();
      assert.equal(warned.length, 2, "a new version warns again");
      assert.match(warned[1]!, /not JSON/);
    } finally {
      console.warn = warn;
    }
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

  test("routed (only while route is self) and gateways, on GET and PUT; a failing source leaves its field out or empty", async () => {
    const routed = [{ nodeId: "nB", peer: "b", links: 2, up: true, lastPushAt: 5, accepted: true }];
    const gateways = [{ nodeId: "nG", peer: "g", publicUrl: "https://gw.example.com" }];
    let calls = 0;
    const a = new Hono();
    mountPublicLinks(a, { routed: async () => (calls++, routed), gateways: async () => gateways });
    const off = await (await a.request("/api/public-links")).json();
    assert.equal(off.routed, undefined, "not a gateway: no routed");
    assert.equal(calls, 0, "and the registry isn't asked");
    assert.deepEqual(off.gateways, gateways);
    const self = await (await a.request("/api/public-links", put({ route: "self", gateway: GATEWAY }))).json();
    assert.deepEqual([self.routed, self.gateways], [routed, gateways], "the PUT answers them too");
    assert.deepEqual((await (await a.request("/api/public-links")).json()).routed, routed);
    const b = new Hono();
    mountPublicLinks(b, { routed: async () => null, gateways: async () => Promise.reject(new Error("probe")) });
    const failed = await (await b.request("/api/public-links")).json();
    assert.equal(failed.routed, undefined);
    assert.deepEqual(failed.gateways, []);
    const real = await (await app().request("/api/public-links")).json();
    assert.deepEqual(real.gateways, [], "the real providers: no peers, no gateways");
    assert.ok(Array.isArray(real.routed), "a gateway with nothing registered: an empty list");
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

  test("the operator's browser behind a reverse proxy (X-Forwarded-Host) is served", async () => {
    const res = await app().request("/api/public-links", { headers: { "X-Forwarded-Host": "host.example.ts.net:8443" } });
    assert.equal(res.status, 200);
  });

  test("refused from the peer listener and relayed by a peer's proxy (X-Sova-Relayed): the plain 404, nothing written", async () => {
    const a = app();
    const peer = { meshPeer: { id: "p", nodeId: "n1" } };
    for (const [path, init] of [
      ["/api/public-links", {}],
      ["/api/public-links", put({ route: "self", gateway: GATEWAY })],
      ["/api/public-links/verify", { method: "POST" }],
    ] as const) {
      assert.equal((await a.request(path, init, peer)).status, 404, `peer ${path}`);
      const headers = { ...((init as { headers?: Record<string, string> }).headers ?? {}), "X-Forwarded-Host": "front.example.com", "X-Sova-Relayed": "1" };
      assert.equal((await a.request(path, { ...init, headers })).status, 404, `relayed ${path}`);
    }
    assert.throws(() => statSync(store.publicLinksFile()));
  });

});

test("PUT routing through a gateway answers with the gateway's address and state, not off; with no answer, as it stands after 3 s (§mesh.public/via-answer)", async () => {
  const gw = await import("./share/gateway-client");
  const { VIA_ANSWER_WAIT_MS } = await import("./public-links-routes");
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
    // The wait stepped by hand: the PUT is held until it ends, then answers the state as it stands.
    // Its real length (VIA_ANSWER_WAIT_MS) is measured in public-links.integration.test.ts.
    let end!: () => void;
    let asked!: () => void;
    const waiting = new Promise<void>((r) => (asked = r));
    const a = new Hono();
    mountPublicLinks(a, { routed: async () => null, gateways: async () => [], viaAnswerWait: () => (asked(), new Promise<void>((r) => (end = r))) });
    let answered = false;
    const pending = Promise.resolve(a.request("/api/public-links", via)).then((r) => ((answered = true), r));
    await waiting;
    assert.equal(answered, false, "held on the wait while the gateway hasn't answered");
    end();
    const slow = await (await pending).json();
    assert.equal(slow.share.state, "off", "nothing learnt: the state as it stands");
    assert.equal(VIA_ANSWER_WAIT_MS, 3000, "the wait it stands in for is 3 s");
  } finally {
    undo();
    gw.resetGatewayClient();
    store.patchPublicLinks({ route: "off" });
  }
});
