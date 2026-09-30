// Run: pnpm exec tsx --test server/share-security.test.ts. The public-links security primitives
// (§mesh.public/forwarded-for, §mesh.public/ingress, §mesh.public/registry): trustedClient,
// stripForwarded, the edge's raw-target and method judging, validateSnapshot and the gateway gate.
// Hermetic: loopback sockets, a fake LocalAPI (setIdentity), a throwaway PI_CODING_AGENT_DIR.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import type { IncomingHttpHeaders, Server } from "node:http";
import { connect, createServer as createTcpServer, type AddressInfo, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, beforeEach, describe, test } from "node:test";
import WebSocket from "ws";

const root = realpathSync(mkdtempSync(join(tmpdir(), "sova-share-security-")));
process.env.PI_CODING_AGENT_DIR = join(root, "agent");
mkdirSync(join(root, "agent", "sessions"), { recursive: true });
after(() => rmSync(root, { recursive: true, force: true }));

const { canonicalIp, trustedClient, stripForwarded } = await import("./share/security");
const edge = await import("./share/edge");
const { validateSnapshot } = await import("./share/registry-validation");
const { callerNode, gatewayGate } = await import("./mesh/gate");
const { setIdentity } = await import("./mesh/localapi");
const { addressIdentity } = await import("./mesh/address-identity");
type PeerEntry = import("./mesh/peers").PeerEntry;
const { REFUSED_HEADER } = await import("./mesh/hello");
const { REGISTRY_LIMITS, INGRESS_STRIP_HEADERS } = await import("../shared/public-links");

const TOKEN = "A".repeat(43);

type Ctx = Parameters<typeof trustedClient>[1];
const req = (from: string | undefined, xff?: string | string[], more: IncomingHttpHeaders = {}) => ({
  headers: { ...(xff === undefined ? {} : { "x-forwarded-for": xff }), ...more } as IncomingHttpHeaders,
  socket: { remoteAddress: from },
});

const LOCAL: Ctx = { trust: "local-proxy" };
const ADMITTED: Ctx = { trust: "admitted", admitted: true };
const NONE: Ctx = { trust: "none" };

// ---- canonicalIp ----------------------------------------------------------------------------

test("canonicalIp: IPv4, mapped IPv4 and IPv6 in one spelling; anything else is null", () => {
  const good: [string, string][] = [
    ["203.0.113.9", "203.0.113.9"],
    ["::ffff:203.0.113.9", "203.0.113.9"],
    ["::FFFF:203.0.113.9", "203.0.113.9"],
    ["[::ffff:203.0.113.9]", "203.0.113.9"],
    ["2001:DB8:0:0:0:0:0:1", "2001:db8::1"],
    ["2001:db8::1", "2001:db8::1"],
    ["[2001:db8::1]", "2001:db8::1"],
    ["fd7a:115c:a1e0:0:0:0:0:5", "fd7a:115c:a1e0::5"],
    ["::1", "::1"],
    ["127.0.0.1", "127.0.0.1"],
  ];
  for (const [raw, want] of good) assert.equal(canonicalIp(raw), want, raw);
  const bad = ["", " ", "garbage", "203.0.113", "203.0.113.999", "01.2.3.4", "203.0.113.9:80", "[2001:db8::1]:80", "fe80::1%eth0", "2001:db8:::1", "1.2.3.4/32", "localhost", "share.example.com", "1.2.3.4, 5.6.7.8", "0x7f.0.0.1", "2130706433"];
  for (const raw of bad) assert.equal(canonicalIp(raw), null, JSON.stringify(raw));
});

// ---- trustedClient ------------------------------------------------------------------------------

test("trustedClient: the socket address, canonical, when no forwarded header is believed", () => {
  const cases: [string | undefined, string][] = [
    ["198.51.100.7", "198.51.100.7"],
    ["::ffff:198.51.100.7", "198.51.100.7"],
    ["::FFFF:198.51.100.7", "198.51.100.7"],
    ["2001:DB8:0:0:0:0:0:1", "2001:db8::1"],
    ["2001:db8::1", "2001:db8::1"],
    ["::1", "::1"],
    [undefined, "unknown"],
    ["", "unknown"],
  ];
  for (const ctx of [NONE, LOCAL, ADMITTED, { trust: "admitted" } as Ctx])
    for (const [from, want] of cases) assert.equal(trustedClient(req(from), ctx), want, `${from} ${JSON.stringify(ctx)}`);
});

test("trustedClient none: never a forwarded header, from any source", () => {
  for (const from of ["127.0.0.1", "::1", "100.101.1.2", "fd7a:115c:a1e0::5", "198.51.100.7"])
    assert.equal(trustedClient(req(from, "203.0.113.9"), NONE), from === "::1" ? "::1" : from, from);
});

test("trustedClient local-proxy: a loopback front's single X-Forwarded-For is the client", () => {
  for (const from of ["127.0.0.1", "::1", "::ffff:127.0.0.1"]) {
    assert.equal(trustedClient(req(from, "203.0.113.9"), LOCAL), "203.0.113.9", from);
    assert.equal(trustedClient(req(from, " 203.0.113.9 "), LOCAL), "203.0.113.9", `${from}: whitespace trimmed`);
    assert.equal(trustedClient(req(from, "::ffff:203.0.113.9"), LOCAL), "203.0.113.9", `${from}: mapped v4 canonical`);
    assert.equal(trustedClient(req(from, "2001:DB8::0:1"), LOCAL), "2001:db8::1", `${from}: v6 canonical`);
  }
});

test("trustedClient local-proxy: the XFF spoof from the tailnet is closed (a tailnet peer can't pick its key)", () => {
  for (const from of ["100.64.0.1", "100.101.1.2", "100.127.255.254", "::ffff:100.101.1.2", "fd7a:115c:a1e0::5"]) {
    const plain = from.replace(/^::ffff:/, "");
    assert.equal(trustedClient(req(from, "203.0.113.9"), LOCAL), plain, from);
    assert.equal(trustedClient(req(from, "203.0.113.9, 198.51.100.1"), LOCAL), plain, `${from}: multi`);
  }
  for (const from of ["198.51.100.7", "10.0.0.2", "192.168.1.5", "2001:db8::1"])
    assert.equal(trustedClient(req(from, "203.0.113.9"), LOCAL), from, `a non-loopback source: ${from}`);
});

test("trustedClient local-proxy: malformed X-Forwarded-For falls back to the socket address", () => {
  const bad = [
    "",
    "   ",
    "garbage",
    "unknown",
    "203.0.113.999",
    "203.0.113",
    "203.0.113.9:1234",
    "[2001:db8::1]:80",
    "01.2.3.4",
    "1.2.3.4\u0000",
    "1.2.3.4/32",
    "2001:db8:::1",
    "fe80::1%eth0",
    "x".repeat(1000),
    "<script>",
    ",",
  ];
  for (const xff of bad) assert.equal(trustedClient(req("127.0.0.1", xff), LOCAL), "127.0.0.1", JSON.stringify(xff));
  // Node joins repeated headers with ", "; a raw array (a hook's own IncomingHttpHeaders) is still not a single value.
  assert.equal(trustedClient(req("127.0.0.1", ["garbage"]), LOCAL), "127.0.0.1", "an array of garbage");
});

test("trustedClient local-proxy: never returns anything but an IP or the socket's own key", () => {
  // Property: over many shapes, the result is the socket address or a canonical IP literal.
  const ip = /^(\d{1,3}\.){3}\d{1,3}$|^[0-9a-f:]+$/;
  const shapes = ["1.2.3.4", "1.2.3.4, 5.6.7.8", " , 1.2.3.4", "1.2.3.4,,", "a, b, c", "5.6.7.8 , evil", "::", "::ffff:1.2.3.4, x", "\t1.2.3.4\t"];
  for (const xff of shapes) {
    const got = trustedClient(req("127.0.0.1", xff), LOCAL);
    assert.ok(got === "127.0.0.1" || ip.test(got), `${JSON.stringify(xff)} → ${got}`);
    assert.ok(!/[\s,]/.test(got), `${JSON.stringify(xff)} → no separators: ${got}`);
  }
});

test("trustedClient local-proxy: the LAST hop is the client (the one the loopback front appended)", () => {
  assert.equal(trustedClient(req("127.0.0.1", "198.51.100.1, 203.0.113.9"), LOCAL), "203.0.113.9");
  assert.equal(trustedClient(req("127.0.0.1", ["198.51.100.1", "203.0.113.9"]), LOCAL), "203.0.113.9", "the array form");
  assert.equal(trustedClient(req("127.0.0.1", "203.0.113.9, junk"), LOCAL), "127.0.0.1", "a malformed last hop: the socket");
});

test("trustedClient admitted: only a single-valued X-Forwarded-For, and only when the gate admitted the connection", () => {
  for (const from of ["100.101.1.2", "fd7a:115c:a1e0::5", "127.0.0.1"]) {
    assert.equal(trustedClient(req(from, "203.0.113.9"), ADMITTED), "203.0.113.9", from);
    assert.equal(trustedClient(req(from, "::ffff:203.0.113.9"), ADMITTED), "203.0.113.9", `${from}: canonical`);
    const plain = from.replace(/^::ffff:/, "");
    assert.equal(trustedClient(req(from, "203.0.113.9"), { trust: "admitted" }), plain, `${from}: admitted absent`);
    assert.equal(trustedClient(req(from, "203.0.113.9"), { trust: "admitted", admitted: false }), plain, `${from}: admitted false`);
    for (const multi of ["203.0.113.9, 198.51.100.1", "203.0.113.9,203.0.113.9", "203.0.113.9 ,"])
      assert.equal(trustedClient(req(from, multi), ADMITTED), plain, `${from}: multi-valued ${multi}`);
    assert.equal(trustedClient(req(from, ["203.0.113.9", "198.51.100.1"]), ADMITTED), plain, `${from}: an array`);
    for (const bad of ["", "garbage", "203.0.113.9:80", "999.1.1.1"])
      assert.equal(trustedClient(req(from, bad), ADMITTED), plain, `${from}: malformed ${JSON.stringify(bad)}`);
  }
});

test("trustedClient: forged Forwarded, X-Real-IP, Tailscale-* and x-sova-* are never believed", () => {
  const forged: IncomingHttpHeaders = {
    forwarded: "for=203.0.113.66",
    "x-real-ip": "203.0.113.66",
    "tailscale-user-login": "someone@example.com",
    "tailscale-client-ip": "203.0.113.66",
    "x-sova-client": "203.0.113.66",
    "x-client-ip": "203.0.113.66",
    "true-client-ip": "203.0.113.66",
    "cf-connecting-ip": "203.0.113.66",
  };
  for (const ctx of [NONE, LOCAL, ADMITTED])
    for (const from of ["127.0.0.1", "100.101.1.2", "198.51.100.7"]) {
      const got = trustedClient(req(from, undefined, forged), ctx);
      assert.equal(got, from, `${from} ${JSON.stringify(ctx)}`);
    }
});

// ---- stripForwarded -----------------------------------------------------------------------------

const lower = (h: Record<string, unknown>) => Object.keys(h).map((k) => k.toLowerCase());

test("stripForwarded: every INGRESS_STRIP_HEADERS name and prefix, case-insensitively", () => {
  const input: IncomingHttpHeaders = {
    forwarded: "for=203.0.113.66",
    "x-forwarded-for": "203.0.113.66",
    "x-forwarded-host": "evil.example.com",
    "x-forwarded-proto": "http",
    "x-forwarded-port": "80",
    "x-forwarded-prefix": "/x",
    "x-real-ip": "203.0.113.66",
    "tailscale-user-login": "someone@example.com",
    "tailscale-user-name": "Someone",
    "tailscale-headers-info": "x",
    "x-sova-peer": "nB",
    "x-sova-refused": "refused",
    accept: "text/html",
    "user-agent": "ua",
    "content-type": "application/json",
    "content-length": "2",
    cookie: "c=1",
  };
  // IncomingHttpHeaders keys are lowercase; a hook may still hand mixed case.
  const mixed = Object.fromEntries(Object.entries(input).map(([k, v]) => [k.replace(/(^|-)([a-z])/g, (_m, a, b) => a + b.toUpperCase()), v])) as IncomingHttpHeaders;
  for (const h of [input, mixed]) {
    const out = stripForwarded(h);
    const keys = lower(out);
    for (const k of keys) {
      for (const rule of INGRESS_STRIP_HEADERS) {
        const hit = rule.endsWith("*") ? k.startsWith(rule.slice(0, -1)) : k === rule;
        assert.ok(!hit, `${k} kept despite ${rule}`);
      }
    }
    for (const kept of ["accept", "user-agent", "content-type", "cookie"]) assert.ok(keys.includes(kept), `${kept} kept`);
  }
});

test("stripForwarded: a CDN's client-address headers go too (CF-Connecting-IP, True-Client-IP)", () => {
  const keys = lower(stripForwarded({ "CF-Connecting-IP": "203.0.113.66", "true-client-ip": "203.0.113.66", "True-Client-IP": "203.0.113.67", accept: "*/*" }));
  assert.deepEqual(keys, ["accept"]);
});

test("stripForwarded: hop-by-hop headers go", () => {
  const out = stripForwarded({
    connection: "keep-alive",
    "keep-alive": "timeout=5",
    "proxy-connection": "keep-alive",
    te: "trailers",
    trailer: "x-foo",
    "transfer-encoding": "chunked",
    upgrade: "h2c",
    "proxy-authorization": "Basic Zm9vOmJhcg==",
    "proxy-authenticate": "Basic",
    accept: "*/*",
  });
  const keys = lower(out);
  for (const k of ["connection", "keep-alive", "proxy-connection", "te", "trailer", "transfer-encoding", "upgrade", "proxy-authorization", "proxy-authenticate"])
    assert.ok(!keys.includes(k), `${k} kept`);
  assert.ok(keys.includes("accept"));
});

test("stripForwarded: any header Connection names goes, case-insensitively, comma lists and arrays", () => {
  const cases: IncomingHttpHeaders[] = [
    { connection: "X-Secret, accept-language", "x-secret": "1", "accept-language": "en", accept: "*/*" },
    { connection: "  x-secret ,ACCEPT-LANGUAGE,,", "x-secret": "1", "accept-language": "en", accept: "*/*" },
    { connection: ["x-secret", "accept-language"] as unknown as string, "x-secret": "1", "accept-language": "en", accept: "*/*" },
  ];
  for (const h of cases) {
    const keys = lower(stripForwarded(h));
    assert.ok(!keys.includes("x-secret"), JSON.stringify(h.connection));
    assert.ok(!keys.includes("accept-language"), JSON.stringify(h.connection));
    assert.ok(keys.includes("accept"), "an unnamed header stays");
  }
});

test("stripForwarded: Connection can't smuggle a set header back, nor remove one the hop sets after", () => {
  // Stripping happens before setting: a hop that strips and then sets X-Forwarded-For has exactly its own value.
  const out = stripForwarded({ connection: "x-forwarded-for", "x-forwarded-for": "203.0.113.66, 1.1.1.1" });
  assert.ok(!lower(out).includes("x-forwarded-for"));
  const hop = { ...out, "x-forwarded-for": "198.51.100.7" };
  assert.equal(hop["x-forwarded-for"], "198.51.100.7");
});

test("stripForwarded: array values survive for kept headers, and the input is not mutated", () => {
  const h: IncomingHttpHeaders = { "set-cookie": ["a=1", "b=2"], "x-forwarded-for": "1.2.3.4", accept: "*/*" };
  const copy = structuredClone(h);
  const out = stripForwarded(h);
  assert.deepEqual(out["set-cookie"], ["a=1", "b=2"]);
  assert.deepEqual(h, copy, "the input is untouched");
});

test("stripForwarded: undefined values are dropped, never forwarded as 'undefined'", () => {
  const out = stripForwarded({ accept: undefined, "user-agent": "ua" });
  for (const v of Object.values(out)) assert.notEqual(v, undefined);
  assert.ok(!Object.values(out).some((v) => String(v) === "undefined"));
});

// ---- the edge: raw target and method ------------------------------------------------------------

async function bound(server: Server): Promise<{ port: number; close: () => void }> {
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  return {
    port,
    close: () => {
      server.close();
      server.closeAllConnections();
    },
  };
}

/** Send `raw` bytes on a fresh connection; resolve with the status line's code (0: closed without one). */
function rawStatus(port: number, raw: string): Promise<number> {
  return new Promise((resolve) => {
    const s = connect(port, "127.0.0.1");
    let buf = "";
    const done = () => {
      const m = /^HTTP\/1\.[01] (\d{3})/.exec(buf);
      resolve(m ? Number(m[1]) : 0);
      s.destroy();
    };
    s.on("data", (d) => {
      buf += d.toString("latin1");
      if (buf.includes("\r\n")) done();
    });
    s.on("error", done);
    s.on("close", done);
    s.setTimeout(3000, done);
    s.write(raw);
  });
}

function probeServer() {
  const reached: string[] = [];
  const server = edge.createShareServer({
    client: () => "k",
    dispatch: (req, res) => {
      reached.push(`${req.method} ${req.url}`);
      res.writeHead(299).end();
    },
    upgrade: (req, socket) => {
      reached.push(`UPGRADE ${req.url}`);
      socket.destroy();
    },
  });
  return { server, reached };
}

const get = (target: string, method = "GET") => `${method} ${target} HTTP/1.1\r\nHost: share.example.com\r\nConnection: close\r\n\r\n`;
const upgradeReq = (target: string) =>
  `GET ${target} HTTP/1.1\r\nHost: share.example.com\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n`;

test("rawTarget: origin-form only, split at the first ?", () => {
  assert.deepEqual(edge.rawTarget(`/h/${TOKEN}`), { path: `/h/${TOKEN}`, query: "" });
  const q = edge.rawTarget(`/ws/h?token=${TOKEN}`);
  assert.equal(q?.path, "/ws/h");
  assert.equal(q?.query, `token=${TOKEN}`);
  for (const t of [`http://share.example.com/h/${TOKEN}`, "share.example.com:443", "*", "", `//h/${TOKEN}`, `h/${TOKEN}`])
    assert.equal(edge.rawTarget(t), null, JSON.stringify(t));
});

test("edge: a well-formed target still reaches dispatch (the control)", async () => {
  const { server, reached } = probeServer();
  const s = await bound(server);
  try {
    assert.equal(await rawStatus(s.port, get(`/h/${TOKEN}`)), 299);
    assert.equal(await rawStatus(s.port, get(`/h/${TOKEN}`, "HEAD")), 299);
    assert.deepEqual(reached, [`GET /h/${TOKEN}`, `HEAD /h/${TOKEN}`]);
  } finally {
    s.close();
  }
});

test("edge: dot segments, encoded dots and slashes, backslashes never reach a route", async () => {
  const { server, reached } = probeServer();
  const s = await bound(server);
  const targets = [
    `/bad/../h/${TOKEN}`,
    `/bad/%2e%2e/h/${TOKEN}`,
    `/bad/%2E%2E/h/${TOKEN}`,
    `/bad/%252e%252e/h/${TOKEN}`,
    `/bad/.%2e/h/${TOKEN}`,
    `/h/./${TOKEN}`,
    `/h/%2e/${TOKEN}`,
    `/x/..%2fh/${TOKEN}`,
    `/x/..%2Fh/${TOKEN}`,
    `/x/%2e%2e%2fh/${TOKEN}`,
    `/x/..\\h/${TOKEN}`,
    `/x/..%5ch/${TOKEN}`,
    `\\h\\${TOKEN}`,
    `/h\\${TOKEN}`,
    `//h/${TOKEN}`,
    `/h//${TOKEN}`,
    `/h/${TOKEN}/`,
    `/h/${TOKEN}/.`,
    `/h/${TOKEN}/..`,
    `/api/h/x/../${TOKEN}`,
    `/api/x/../h/${TOKEN}/message`,
    `/h/assets/../../api/sessions`,
    `/h/assets/..%2f..%2fapi%2fsessions`,
    `/h/assets/%2e%2e`,
    `/h/assets/..`,
    `/i/../h/${TOKEN}`,
    `h/${TOKEN}`,
    `*`,
  ];
  try {
    for (const t of targets) {
      const status = await rawStatus(s.port, get(t));
      assert.ok(status === 0 || (status >= 400 && status < 500), `${t} → ${status}`);
    }
    assert.deepEqual(reached, [], "nothing reached dispatch");
  } finally {
    s.close();
  }
});

test("edge: absolute-form targets are refused, whatever host they name", async () => {
  const { server, reached } = probeServer();
  const s = await bound(server);
  try {
    for (const t of [`http://share.example.com/h/${TOKEN}`, `https://share.example.com/h/${TOKEN}`, `http://127.0.0.1:4801/api/sessions`, `http://evil.example.com/h/${TOKEN}`, `HTTP://share.example.com/h/${TOKEN}`]) {
      const status = await rawStatus(s.port, get(t));
      assert.ok(status === 0 || (status >= 400 && status < 500), `${t} → ${status}`);
    }
    for (const t of [`http://share.example.com/ws/h?token=${TOKEN}`]) {
      const status = await rawStatus(s.port, upgradeReq(t));
      assert.ok(status === 0 || (status >= 400 && status < 500), `upgrade ${t} → ${status}`);
    }
    assert.deepEqual(reached, []);
  } finally {
    s.close();
  }
});

test("edge: CONNECT, TRACE and the other wrong methods never reach a route", async () => {
  const { server, reached } = probeServer();
  const s = await bound(server);
  try {
    assert.ok([0, 400, 403, 404, 405, 501].includes(await rawStatus(s.port, get("share.example.com:443", "CONNECT"))), "CONNECT authority-form");
    assert.ok([0, 400, 403, 404, 405, 501].includes(await rawStatus(s.port, get(`/h/${TOKEN}`, "CONNECT"))), "CONNECT origin-form");
    for (const m of ["TRACE", "OPTIONS", "PUT", "DELETE", "PATCH", "POST", "PROPFIND", "get"]) {
      const status = await rawStatus(s.port, get(`/h/${TOKEN}`, m));
      assert.ok(status === 0 || (status >= 400 && status < 500), `${m} → ${status}`);
    }
    for (const m of ["GET", "PUT", "DELETE"]) {
      const status = await rawStatus(s.port, get(`/api/h/${TOKEN}/message`, m));
      assert.ok(status === 0 || (status >= 400 && status < 500), `${m} message → ${status}`);
    }
    assert.deepEqual(reached, []);
  } finally {
    s.close();
  }
});

test("edge: upgrades on any path but a raw /ws/h are refused; dot and encoded spellings too", async () => {
  const { server, reached } = probeServer();
  const s = await bound(server);
  const targets = [
    `/bad/../ws/h?token=${TOKEN}`,
    `/bad/%2e%2e/ws/h?token=${TOKEN}`,
    `/ws/./h?token=${TOKEN}`,
    `/ws/%68?token=${TOKEN}`,
    `/ws//h?token=${TOKEN}`,
    `/ws/h/?token=${TOKEN}`,
    `/ws\\h?token=${TOKEN}`,
    `/ws/chat?token=${TOKEN}`,
    `/ws/watch`,
    `/h/${TOKEN}`,
    `/ws/h?token=${TOKEN.slice(1)}`,
    `/ws/h?token=${TOKEN}%00`,
    `/ws/h?token=${TOKEN}&token=${"B".repeat(43)}`,
    `/ws/h?token=${TOKEN}&token=${TOKEN}`,
  ];
  try {
    for (const t of targets) {
      const status = await rawStatus(s.port, upgradeReq(t));
      assert.ok(status === 0 || (status >= 400 && status < 500), `${t} → ${status}`);
    }
    assert.deepEqual(reached, []);
    // The control: the exact shape reaches the upgrade hook.
    await rawStatus(s.port, upgradeReq(`/ws/h?token=${TOKEN}`));
    assert.deepEqual(reached, [`UPGRADE /ws/h?token=${TOKEN}`]);
  } finally {
    s.close();
  }
});

test("edge: an upgrade by POST or another method is refused", async () => {
  const { server, reached } = probeServer();
  const s = await bound(server);
  try {
    for (const m of ["POST", "PUT", "CONNECT"]) {
      const raw = upgradeReq(`/ws/h?token=${TOKEN}`).replace(/^GET/, m);
      const status = await rawStatus(s.port, raw);
      assert.ok(status === 0 || (status >= 400 && status < 500), `${m} → ${status}`);
    }
    assert.deepEqual(reached, []);
  } finally {
    s.close();
  }
});

test("edge default client: a loopback front's malformed X-Forwarded-For can't mint fresh rate-limit keys", async () => {
  // Today's clientAddress would key each request on its own garbage value; trustedClient keys them all on 127.0.0.1.
  let ok = 0;
  const s = await bound(edge.createShareServer({ dispatch: (_q, r) => void (ok++, r.writeHead(299).end()), upgrade: (_q, sock) => void sock.destroy() }));
  try {
    const statuses: number[] = [];
    for (let i = 0; i < edge.REQUESTS_PER_MINUTE + 1; i++) {
      const res = await fetch(`http://127.0.0.1:${s.port}/h/${TOKEN}`, { headers: { "x-forwarded-for": `spoof-${i}` } });
      statuses.push(res.status);
      await res.arrayBuffer();
    }
    assert.equal(statuses.at(-1), 429, "the 61st request from one socket address is limited");
    assert.equal(ok, edge.REQUESTS_PER_MINUTE);
  } finally {
    s.close();
  }
});

test("edge default client: a loopback front's well-formed X-Forwarded-For still keys per client", async () => {
  const s = await bound(edge.createShareServer({ dispatch: (_q, r) => void r.writeHead(299).end(), upgrade: (_q, sock) => void sock.destroy() }));
  try {
    for (let i = 0; i < edge.REQUESTS_PER_MINUTE + 5; i++) {
      const res = await fetch(`http://127.0.0.1:${s.port}/h/${TOKEN}`, { headers: { "x-forwarded-for": `203.0.113.${i % 250}` } });
      assert.equal(res.status, 299, `request ${i}`);
      await res.arrayBuffer();
    }
  } finally {
    s.close();
  }
});

test("edge: exact statuses — absolute-form and * 400, dotted or encoded 404, CONNECT 405", async () => {
  const { server, reached } = probeServer();
  const s = await bound(server);
  try {
    assert.equal(await rawStatus(s.port, get(`http://share.example.com/h/${TOKEN}`)), 400, "absolute-form");
    assert.equal(await rawStatus(s.port, get("*", "OPTIONS")), 400, "asterisk-form");
    for (const t of [`/bad/%2e%2e/h/${TOKEN}`, `/bad/../h/${TOKEN}`, `/h/./${TOKEN}`, `//h/${TOKEN}`]) {
      const want = t.startsWith("//") ? 400 : 404;
      assert.equal(await rawStatus(s.port, get(t)), want, t);
    }
    assert.equal(await rawStatus(s.port, get("share.example.com:443", "CONNECT")), 405, "CONNECT");
    assert.deepEqual(reached, []);
  } finally {
    s.close();
  }
});

// ---- validateSnapshot ---------------------------------------------------------------------------

const NOW = 1_800_000_000_000;
const DAY = 86_400_000;
const hex = (n: number) => n.toString(16).padStart(64, "0");
const good = () => ({
  v: 1 as const,
  seq: 7,
  links: [
    { h: hex(1), exp: NOW + DAY, kind: "h" as const },
    { h: hex(2), exp: NOW + 30 * DAY, kind: "i" as const },
    { h: hex(3), exp: NOW + 90 * DAY, kind: "x" as const },
  ],
  assets: ["index-abc123.js", "style.DEF_456.css", "font-x.woff2"],
  ingressPort: 4802,
});
const check = (body: unknown, now = NOW) => validateSnapshot(body, { now });

test("validateSnapshot: a well-formed snapshot passes, returned whole", () => {
  const r = check(good());
  assert.equal(r.ok, true, JSON.stringify(r));
  if (r.ok) assert.deepEqual(r.snapshot, good());
  assert.equal(check({ ...good(), links: [], assets: [], seq: 0 }).ok, true, "empty and seq 0");
  assert.equal(check({ ...good(), ingressPort: 1 }).ok, true);
  assert.equal(check({ ...good(), ingressPort: 65535 }).ok, true);
  assert.equal(check({ ...good(), seq: Number.MAX_SAFE_INTEGER }).ok, true);
  assert.equal(check({ ...good(), links: [{ h: hex(9), exp: NOW + REGISTRY_LIMITS.maxExpiryAheadMs, kind: "h" }] }).ok, true, "exp exactly at the ceiling");
});

test("validateSnapshot: a rejection is bad-snapshot with a reason", () => {
  const r = check(null);
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.equal(r.error, "bad-snapshot");
    assert.equal(typeof r.why, "string");
    assert.ok(r.why.length > 0);
  }
});

test("validateSnapshot: the top-level shape", () => {
  const bad: [string, unknown][] = [
    ["null", null],
    ["array", []],
    ["string", "{}"],
    ["number", 1],
    ["empty object", {}],
    ["v 2", { ...good(), v: 2 }],
    ["v '1'", { ...good(), v: "1" }],
    ["v missing", (({ v: _v, ...r }) => r)(good())],
    ["seq -1", { ...good(), seq: -1 }],
    ["seq 1.5", { ...good(), seq: 1.5 }],
    ["seq NaN", { ...good(), seq: NaN }],
    ["seq Infinity", { ...good(), seq: Infinity }],
    ["seq unsafe", { ...good(), seq: Number.MAX_SAFE_INTEGER + 1 }],
    ["seq string", { ...good(), seq: "7" }],
    ["seq missing", (({ seq: _s, ...r }) => r)(good())],
    ["ingressPort 0", { ...good(), ingressPort: 0 }],
    ["ingressPort 65536", { ...good(), ingressPort: 65536 }],
    ["ingressPort 80.5", { ...good(), ingressPort: 80.5 }],
    ["ingressPort string", { ...good(), ingressPort: "4802" }],
    ["ingressPort missing", (({ ingressPort: _p, ...r }) => r)(good())],
    ["links not an array", { ...good(), links: {} }],
    ["links missing", (({ links: _l, ...r }) => r)(good())],
    ["assets not an array", { ...good(), assets: "a.js" }],
    ["assets missing", (({ assets: _a, ...r }) => r)(good())],
    ["unknown key", { ...good(), extra: 1 }],
    ["unknown key: owner", { ...good(), owner: "nB" }],
    ["unknown key: address", { ...good(), address: "100.64.0.9" }],
    ["__proto__ key", JSON.parse(`{"v":1,"seq":1,"links":[],"assets":[],"ingressPort":4802,"__proto__":{"x":1}}`)],
  ];
  for (const [name, body] of bad) assert.equal(check(body).ok, false, name);
});

test("validateSnapshot: each link row", () => {
  const row = (r: unknown) => ({ ...good(), links: [r] });
  const bad: [string, unknown][] = [
    ["not an object", "x"],
    ["null", null],
    ["h uppercase", { h: hex(1).toUpperCase().replace(/^0/, "A"), exp: NOW + DAY, kind: "h" }],
    ["h 63", { h: hex(1).slice(1), exp: NOW + DAY, kind: "h" }],
    ["h 65", { h: `${hex(1)}0`, exp: NOW + DAY, kind: "h" }],
    ["h non-hex", { h: "g".repeat(64), exp: NOW + DAY, kind: "h" }],
    ["h a raw token", { h: TOKEN, exp: NOW + DAY, kind: "h" }],
    ["h number", { h: 1, exp: NOW + DAY, kind: "h" }],
    ["h missing", { exp: NOW + DAY, kind: "h" }],
    ["kind z", { h: hex(1), exp: NOW + DAY, kind: "z" }],
    ["kind H", { h: hex(1), exp: NOW + DAY, kind: "H" }],
    ["kind missing", { h: hex(1), exp: NOW + DAY }],
    ["exp past", { h: hex(1), exp: NOW - 1, kind: "h" }],
    ["exp now", { h: hex(1), exp: NOW, kind: "h" }],
    ["exp too far", { h: hex(1), exp: NOW + REGISTRY_LIMITS.maxExpiryAheadMs + 1, kind: "h" }],
    ["exp a year", { h: hex(1), exp: NOW + 365 * DAY, kind: "h" }],
    ["exp NaN", { h: hex(1), exp: NaN, kind: "h" }],
    ["exp Infinity", { h: hex(1), exp: Infinity, kind: "h" }],
    ["exp string", { h: hex(1), exp: String(NOW + DAY), kind: "h" }],
    ["exp missing", { h: hex(1), kind: "h" }],
    ["unknown row key", { h: hex(1), exp: NOW + DAY, kind: "h", host: "100.64.0.9" }],
    ["unknown row key: token", { h: hex(1), exp: NOW + DAY, kind: "h", token: TOKEN }],
  ];
  for (const [name, r] of bad) assert.equal(check(row(r)).ok, false, name);
});

test("validateSnapshot: exp is judged against ctx.now, not the wall clock", () => {
  const body = { ...good(), links: [{ h: hex(1), exp: NOW + DAY, kind: "h" }] };
  assert.equal(check(body, NOW).ok, true);
  assert.equal(check(body, NOW + 2 * DAY).ok, false, "expired by then");
  assert.equal(check(body, NOW - REGISTRY_LIMITS.maxExpiryAheadMs).ok, false, "too far ahead from then");
});

test("validateSnapshot: no duplicate hash, no duplicate asset", () => {
  assert.equal(check({ ...good(), links: [{ h: hex(1), exp: NOW + DAY, kind: "h" }, { h: hex(1), exp: NOW + 2 * DAY, kind: "i" }] }).ok, false, "same h, different kind");
  assert.equal(check({ ...good(), links: [{ h: hex(1), exp: NOW + DAY, kind: "h" }, { h: hex(1), exp: NOW + DAY, kind: "h" }] }).ok, false, "identical rows");
  assert.equal(check({ ...good(), assets: ["a.js", "a.js"] }).ok, false);
});

test("validateSnapshot: asset names are safe filenames", () => {
  const bad = ["", ".", "..", "...", ".hidden", "a/b.js", "a\\b.js", "../a.js", "a..js", "a..", "..a", "a b.js", "a%2e.js", "a\u0000.js", "a.js\n", "é.js", "a:b.js", "a?.js", "a#.js"];
  for (const name of bad) assert.equal(check({ ...good(), assets: [name] }).ok, false, JSON.stringify(name));
  for (const name of [1, null, {}, []]) assert.equal(check({ ...good(), assets: [name] }).ok, false, JSON.stringify(name));
  for (const name of ["a", "a.js", "_x", "-x", "index-AbC_9.js", "a.b.c.css"]) assert.equal(check({ ...good(), assets: [name] }).ok, true, name);
});

test("validateSnapshot: REGISTRY_LIMITS", () => {
  const links = (n: number) => Array.from({ length: n }, (_, i) => ({ h: hex(i + 1), exp: NOW + DAY, kind: "h" as const }));
  assert.equal(check({ ...good(), links: links(REGISTRY_LIMITS.maxLinks) }).ok, true, "maxLinks rows (no byte cap here: that is the route's)");
  assert.equal(check({ ...good(), links: links(REGISTRY_LIMITS.maxLinks + 1) }).ok, false, "maxLinks + 1");
  const assets = (n: number) => Array.from({ length: n }, (_, i) => `a${i}.js`);
  assert.equal(check({ ...good(), assets: assets(REGISTRY_LIMITS.maxAssets) }).ok, true);
  assert.equal(check({ ...good(), assets: assets(REGISTRY_LIMITS.maxAssets + 1) }).ok, false);
});

test("validateSnapshot: all or nothing — one bad row among good ones rejects the whole body", () => {
  const body = good();
  body.links.push({ h: "nothex", exp: NOW + DAY, kind: "h" });
  assert.equal(check(body).ok, false);
  const late = good();
  late.links.push({ h: hex(99), exp: NOW - 1, kind: "h" });
  assert.equal(check(late).ok, false, "an expired row rejects the snapshot (snapshots leave expired links out)");
});

test("validateSnapshot: pure — the input is not mutated, and the same input gives the same answer", () => {
  const body = good();
  const copy = structuredClone(body);
  const a = check(body);
  const b = check(body);
  assert.deepEqual(body, copy);
  assert.deepEqual(a, b);
  const bad = { ...good(), extra: 1 };
  assert.deepEqual(check(bad), check(bad));
});

test("validateSnapshot: never throws, over a table of hostile bodies (a parsed JSON body has no getters)", () => {
  const cyclic: Record<string, unknown> = { v: 1, seq: 1, assets: [], ingressPort: 4802 };
  cyclic.links = [cyclic];
  for (const body of [undefined, Symbol("x"), () => 1, new Date(), cyclic, { ...good(), links: [undefined] }, { ...good(), links: new Array(3) }, Object.create(null)]) {
    let r: ReturnType<typeof check> | undefined;
    assert.doesNotThrow(() => void (r = check(body)));
    assert.equal(r?.ok, false);
  }
});

// ---- the gateway gate ---------------------------------------------------------------------------

/** What the fake LocalAPI's whois answers, by the caller's address:port. */
let whois: (addr: string) => Promise<{ nodeId: string; name: string; tags: string[]; login: string } | null> = async () => null;
let whoisCalls = 0;
const fakeIdentity = {
  status: async (): Promise<never> => {
    throw new Error("status is not used by the gate");
  },
  whois: (addr: string) => {
    whoisCalls++;
    return whois(addr);
  },
};
setIdentity(fakeIdentity);
const node = (nodeId: string) => async () => ({ nodeId, name: "x", tags: [], login: "me" });

/** A connected server-side socket (a real remoteAddress and port), and its cleanup. */
async function accepted(): Promise<{ socket: Socket; close: () => void }> {
  const srv = createTcpServer();
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const got = new Promise<Socket>((r) => srv.once("connection", r));
  const client = connect((srv.address() as AddressInfo).port, "127.0.0.1");
  const socket = await got;
  return {
    socket,
    close: () => {
      client.destroy();
      socket.destroy();
      srv.close();
    },
  };
}

test("callerNode: the whois StableID of a connection; null when whois knows nobody or fails", async () => {
  const quiet = console.warn;
  console.warn = () => {};
  try {
    for (const [answer, want] of [
      [node("nGW"), "nGW"],
      [async () => null, null],
      [async () => { throw new Error("tailscaled down"); }, null],
    ] as const) {
      whois = answer as typeof whois;
      const c = await accepted();
      try {
        assert.equal(await callerNode(c.socket), want);
      } finally {
        c.close();
      }
    }
  } finally {
    console.warn = quiet;
  }
});

test("callerNode: asks a non-LocalAPI identity (address mode, a fake) on every call, with the connection's address and port", async () => {
  // Per-socket caching applies only to the real LocalAPI identity, which a hermetic test can't reach.
  const asked: string[] = [];
  whois = async (addr) => (asked.push(addr), { nodeId: "nGW", name: "x", tags: [], login: "me" });
  const c = await accepted();
  try {
    await callerNode(c.socket);
    await callerNode(c.socket);
    assert.equal(asked.length, 2, "not cached for a non-LocalAPI identity");
    assert.equal(asked[0], `127.0.0.1:${c.socket.remotePort}`);
  } finally {
    c.close();
  }
});

test("callerNode: a socket with no remote address is nobody, without asking whois", async () => {
  const { Socket: NetSocket } = await import("node:net");
  const before = whoisCalls;
  assert.equal(await callerNode(new NetSocket()), null);
  assert.equal(whoisCalls, before);
});

test("gatewayGate: admits only the expected gateway's StableID", async () => {
  const gate = gatewayGate(() => ({ nodeId: "nGW" }));
  const table: [typeof whois, boolean, string][] = [
    [node("nGW"), true, "the gateway"],
    [node("nOTHER"), false, "another peer"],
    [node("nSTRANGER"), false, "a stranger"],
    [node("ngw"), false, "case matters"],
    [node(""), false, "an empty id"],
    [async () => null, false, "whois knows nobody"],
    [async () => { throw new Error("down"); }, false, "whois fails"],
  ];
  const quiet = console.warn;
  console.warn = () => {};
  try {
    for (const [answer, want, name] of table) {
      whois = answer;
      const c = await accepted();
      try {
        assert.equal(await gate(c.socket), want, name);
      } finally {
        c.close();
      }
    }
  } finally {
    console.warn = quiet;
  }
});

test("gatewayGate: no expected gateway (null, or an empty nodeId) admits nobody", async () => {
  whois = node("nGW");
  for (const expected of [() => null, () => ({ nodeId: "" })]) {
    const c = await accepted();
    try {
      assert.equal(await gatewayGate(expected)(c.socket), false);
    } finally {
      c.close();
    }
  }
});

test("gatewayGate: expected() is read fresh on every call (a changed via refuses at once)", async () => {
  whois = node("nGW");
  let current: { nodeId: string } | null = { nodeId: "nGW" };
  let reads = 0;
  const gate = gatewayGate(() => (reads++, current));
  const c = await accepted();
  try {
    assert.equal(await gate(c.socket), true);
    current = { nodeId: "nNEW" };
    assert.equal(await gate(c.socket), false, "the same connection, after via changed");
    current = null;
    assert.equal(await gate(c.socket), false, "after the gateway was removed");
    current = { nodeId: "nGW" };
    assert.equal(await gate(c.socket), true);
    assert.ok(reads >= 4, `read ${reads} times`);
  } finally {
    c.close();
  }
});

test("gatewayGate: with pinned addresses (address identity), the connection's address must be one of them too", async () => {
  whois = node("nGW");
  const c = await accepted(); // from 127.0.0.1
  try {
    assert.equal(await gatewayGate(() => ({ nodeId: "nGW", addresses: ["127.0.0.1"] }))(c.socket), true, "pinned and matching");
    assert.equal(await gatewayGate(() => ({ nodeId: "nGW", addresses: ["100.64.0.2", "127.0.0.1"] }))(c.socket), true, "one of several");
    assert.equal(await gatewayGate(() => ({ nodeId: "nGW", addresses: ["::ffff:127.0.0.1"] }))(c.socket), true, "compared canonically");
    assert.equal(await gatewayGate(() => ({ nodeId: "nGW", addresses: ["100.64.0.2"] }))(c.socket), false, "the right node from the wrong address");
    assert.equal(await gatewayGate(() => ({ nodeId: "nOTHER", addresses: ["127.0.0.1"] }))(c.socket), false, "the right address, the wrong node");
    assert.equal(await gatewayGate(() => ({ nodeId: "nGW", addresses: [] }))(c.socket), false, "an empty pin list denies");
    assert.equal(await gatewayGate(() => ({ nodeId: "nGW" }))(c.socket), true, "addresses absent (LocalAPI mode): StableID alone");
  } finally {
    c.close();
  }
});

test("gatewayGate: an expected() that throws admits nobody, never rejects", async () => {
  whois = node("nGW");
  const c = await accepted();
  try {
    const r = await gatewayGate(() => {
      throw new Error("peers.json unreadable");
    })(c.socket).catch(() => "rejected");
    assert.equal(r, false);
  } finally {
    c.close();
  }
});

test("gatewayGate on the edge: a non-gateway caller gets 403 with the refused marker, HTTP and WS", async () => {
  let dispatched = 0;
  const gate = gatewayGate(() => ({ nodeId: "nGW" }));
  const server = edge.createShareServer({
    admit: (req) => gate(req.socket as Socket),
    client: (req) => trustedClient(req, { trust: "admitted", admitted: true }),
    dispatch: (_q, r) => void (dispatched++, r.writeHead(299).end()),
    upgrade: (_q, sock) => void (dispatched++, sock.destroy()),
  });
  const s = await bound(server);
  try {
    whois = node("nSTRANGER");
    const res = await fetch(`http://127.0.0.1:${s.port}/h/${TOKEN}`);
    assert.equal(res.status, 403);
    assert.equal(res.headers.get(REFUSED_HEADER), "refused");
    await res.arrayBuffer();
    const ws = await new Promise<{ status: number; marker?: string }>((resolve) => {
      const w = new WebSocket(`ws://127.0.0.1:${s.port}/ws/h?token=${TOKEN}`);
      w.on("unexpected-response", (_r, r) => resolve({ status: r.statusCode ?? 0, marker: r.headers[REFUSED_HEADER.toLowerCase()] as string | undefined }));
      w.on("error", () => resolve({ status: 0 }));
    });
    assert.equal(ws.status, 403);
    assert.equal(ws.marker, "refused");
    assert.equal(dispatched, 0);
    whois = node("nGW");
    const ok = await fetch(`http://127.0.0.1:${s.port}/h/${TOKEN}`, { headers: { "x-forwarded-for": "203.0.113.9" } });
    assert.equal(ok.status, 299, "the gateway passes");
    assert.equal(dispatched, 1);
  } finally {
    s.close();
  }
});

// ---- B1: address identity, re-asked on every call (M2 review) -----------------------------------

describe("gatewayGate with the real address-identity adapter", () => {
  const SELF = "100.64.0.9"; // SOVA_PEER_HOST: this host, a different tailnet IP
  const SRC = "100.64.0.2"; // the gateway's tailnet source address
  let peers: PeerEntry[] = [];
  const gatewayPeer = (): PeerEntry => ({ id: "vps", label: "VPS", nodeId: "nGW", dnsName: SRC });
  /** A fake accepted socket at the tailnet source: only remoteAddress and remotePort are read. */
  const fakeSocket = (port = 40000) => ({ remoteAddress: SRC, remotePort: port }) as unknown as Socket;
  let quiet: typeof console.warn;
  let nextPort = 41000;
  const fresh = () => fakeSocket(nextPort++);

  beforeEach(() => {
    peers = [gatewayPeer()];
    setIdentity(addressIdentity(() => peers, { SOVA_PEER_HOST: SELF }));
    quiet = console.warn;
    console.warn = () => {};
  });
  afterEach(() => {
    setIdentity(fakeIdentity);
    console.warn = quiet;
  });

  test("(d) control: a unique mapping admits, on a fresh and a reused socket", async () => {
    const gate = gatewayGate(() => ({ nodeId: "nGW" }));
    const reused = fakeSocket();
    assert.equal(await gate(reused), true);
    assert.equal(await gate(reused), true, "reused");
    assert.equal(await gate(fresh()), true, "fresh");
  });

  test("(a) a second peer with the same address makes the mapping ambiguous: the same socket is refused", async () => {
    const gate = gatewayGate(() => ({ nodeId: "nGW" }));
    const reused = fakeSocket();
    assert.equal(await gate(reused), true, "unique first");
    peers.push({ id: "phone", label: "Phone", nodeId: "nPHONE", dnsName: SRC });
    assert.equal(await gate(reused), false, "the same socket, now ambiguous");
    assert.equal(await gate(fresh()), false, "a fresh socket too (control)");
  });

  test("(b) the peer's address removed from its entry: the same socket is refused", async () => {
    const gate = gatewayGate(() => ({ nodeId: "nGW" }));
    const reused = fakeSocket();
    assert.equal(await gate(reused), true, "unique first");
    peers = [{ ...gatewayPeer(), dnsName: "vps.example.ts.net" }];
    assert.equal(await gate(reused), false, "the same socket, the mapping gone");
    assert.equal(await gate(fresh()), false, "a fresh socket too");
  });

  test("(c) pins [source], then pins [] (an empty list): refused; absent pins are no pin check", async () => {
    let pins: string[] | undefined = [SRC];
    const gate = gatewayGate(() => ({ nodeId: "nGW", ...(pins === undefined ? {} : { addresses: pins }) }));
    const reused = fakeSocket();
    assert.equal(await gate(reused), true, "pinned to the source");
    pins = [];
    assert.equal(await gate(reused), false, "an empty pin list denies");
    pins = ["100.64.0.77"];
    assert.equal(await gate(reused), false, "pinned elsewhere");
    pins = undefined;
    assert.equal(await gate(reused), true, "no pins: StableID alone");
  });
});
