// Run: pnpm exec tsx --test server/share-edge.test.ts. The share edge's hooks and the public-links
// seams, on an ephemeral loopback port with a throwaway PI_CODING_AGENT_DIR; ~/.pi untouched.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { request } from "node:http";
import type { AddressInfo } from "node:net";
import { connect, Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import WebSocket from "ws";

const root = realpathSync(mkdtempSync(join(tmpdir(), "sova-share-edge-")));
process.env.PI_CODING_AGENT_DIR = join(root, "agent");
mkdirSync(join(root, "agent", "sessions"), { recursive: true });
after(() => rmSync(root, { recursive: true, force: true }));

const edge = await import("./share/edge");
const listener = await import("./share/listener");
const events = await import("./share/links-events");
const settingEvents = await import("./share/setting-events");
const security = await import("./share/security");
const { validateSnapshot } = await import("./share/registry-validation");
const { callerNode, gatewayGate } = await import("./mesh/gate");
const { REFUSED_HEADER } = await import("./mesh/hello");
const contract = await import("../shared/public-links");

const TOKEN = "A".repeat(43);

async function bound(server: import("node:http").Server): Promise<{ base: string; port: number; close: () => void }> {
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  return {
    base: `127.0.0.1:${port}`,
    port,
    close: () => {
      server.close();
      server.closeAllConnections();
    },
  };
}

/** The status a WebSocket handshake got (0: none), and the answer's headers. */
function wsStatus(url: string): Promise<{ status: number; headers: Record<string, string | string[] | undefined> }> {
  return new Promise((resolve) => {
    const ws = new WebSocket(url);
    ws.on("unexpected-response", (_req, res) => resolve({ status: res.statusCode ?? 0, headers: res.headers }));
    ws.on("error", () => resolve({ status: 0, headers: {} }));
  });
}

/** Everything console.warn printed while `fn` ran. */
async function warnings(fn: () => Promise<void>): Promise<string> {
  const lines: string[] = [];
  const orig = console.warn;
  console.warn = (...a: unknown[]) => void lines.push(a.map(String).join(" "));
  try {
    await fn();
  } finally {
    console.warn = orig;
  }
  return lines.join("\n");
}

test("listener.ts still exports the edge's names, the same functions", () => {
  assert.equal(listener.createShareServer, edge.createShareServer);
  assert.equal(listener.shareMayReach, edge.shareMayReach);
  assert.equal(listener.clientAddress, edge.clientAddress);
  assert.equal(edge.clientAddress, security.clientAddress);
  assert.equal(listener.RateLimiter, edge.RateLimiter);
});

test("dispatch runs only for an allowed path, after the limit, with the parsed url and the client key", async () => {
  const seen: { path: string; client: string }[] = [];
  const s = await bound(
    edge.createShareServer({
      client: () => "k1",
      dispatch: (_req, res, ctx) => {
        seen.push({ path: ctx.url.pathname, client: ctx.client });
        res.writeHead(299).end();
      },
    }),
  );
  try {
    assert.equal((await fetch(`http://${s.base}/h/${TOKEN}`)).status, 299);
    assert.equal((await fetch(`http://${s.base}/api/sessions`)).status, 404, "the allowlist runs first");
    assert.deepEqual(seen, [{ path: `/h/${TOKEN}`, client: "k1" }]);
  } finally {
    s.close();
  }
});

test("hook failures: a throwing or rejecting dispatch, client or upgrade is a 500, and the log never carries the token or the error's text", async () => {
  const marker = `${"Z".repeat(37)}SECRET`; // 43 characters, a well-formed token
  const boom = () => new Error(`upstream http://x/h/${marker} failed`);
  const cases: { name: string; opts: import("./share/edge").ShareServerOptions }[] = [
    { name: "dispatch throws", opts: { dispatch: () => { throw boom(); } } },
    { name: "dispatch rejects", opts: { dispatch: async () => { throw boom(); } } },
    { name: "client throws", opts: { client: () => { throw boom(); }, dispatch: (_q, r) => void r.end() } },
  ];
  const log = await warnings(async () => {
    for (const c of cases) {
      const s = await bound(edge.createShareServer(c.opts));
      try {
        assert.equal((await fetch(`http://${s.base}/h/${marker}`)).status, 500, c.name);
      } finally {
        s.close();
      }
    }
    for (const upgrade of [() => { throw boom(); }, async () => { throw boom(); }]) {
      const s = await bound(edge.createShareServer({ upgrade }));
      try {
        assert.equal((await wsStatus(`ws://${s.base}/ws/h?token=${marker}`)).status, 500);
      } finally {
        s.close();
      }
    }
  });
  assert.match(log, /failed on a page request \(Error\)/);
  assert.match(log, /failed on a socket request/);
  assert.ok(!log.includes(marker.slice(0, 6)), "no part of the token is logged");
  assert.ok(!log.includes("upstream"), "the error's message is not logged");
});

test("admit false, throwing or rejecting: 403 with the gate's marker and Connection: close, before the allowlist, HTTP and upgrades", async () => {
  for (const admit of [async () => false, () => false, () => { throw new Error("x"); }, async () => { throw new Error("x"); }]) {
    let dispatched = 0;
    const s = await bound(
      edge.createShareServer({
        admit,
        dispatch: (_req, res) => {
          dispatched++;
          res.end();
        },
        upgrade: (_req, socket) => {
          dispatched++;
          socket.destroy();
        },
      }),
    );
    try {
      for (const p of [`/h/${TOKEN}`, "/api/sessions"]) {
        const res = await fetch(`http://${s.base}${p}`);
        assert.equal(res.status, 403, p);
        assert.equal(res.headers.get(REFUSED_HEADER), "refused", p);
        assert.equal(res.headers.get("connection"), "close", p);
        await res.arrayBuffer();
      }
      const ws = await wsStatus(`ws://${s.base}/ws/h?token=${TOKEN}`);
      assert.equal(ws.status, 403);
      assert.equal(ws.headers[REFUSED_HEADER.toLowerCase()], "refused");
      assert.equal(dispatched, 0);
    } finally {
      s.close();
    }
  }
});

test("a client that leaves while admission is pending is never served", async () => {
  let release!: (ok: boolean) => void;
  const decided = new Promise<boolean>((r) => (release = r));
  let admits = 0;
  let served = 0;
  const s = await bound(
    edge.createShareServer({
      admit: () => {
        admits++;
        return decided;
      },
      dispatch: (_req, res) => {
        served++;
        res.end();
      },
      upgrade: (_req, socket) => {
        served++;
        socket.destroy();
      },
    }),
  );
  try {
    const http = request({ port: s.port, host: "127.0.0.1", path: `/h/${TOKEN}` });
    http.on("error", () => {});
    http.end();
    const raw = connect(s.port, "127.0.0.1", () => raw.write(`GET /ws/h?token=${TOKEN} HTTP/1.1\r\nHost: x\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n`));
    raw.on("error", () => {});
    while (admits < 2) await new Promise((r) => setTimeout(r, 5));
    http.destroy();
    raw.destroy();
    await new Promise((r) => setTimeout(r, 50));
    release(true);
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(served, 0);
  } finally {
    s.close();
  }
});

test("admitted after a wait: the request is served, and an upgrade's early bytes still reach its hook", async () => {
  const s = await bound(
    edge.createShareServer({
      admit: () => new Promise((r) => setTimeout(() => r(true), 50)),
      dispatch: (_req, res) => void res.writeHead(299).end(),
      upgrade: (_req, socket, head) => {
        let got = head.toString();
        const done = () => socket.end(`HTTP/1.1 418 Teapot\r\nX-Got: ${got.includes("EARLY") ? "yes" : "no"}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`);
        if (got.includes("EARLY")) {
          done();
          return;
        }
        socket.on("data", (d: Buffer) => {
          got += d.toString();
          if (got.includes("EARLY")) done();
        });
      },
    }),
  );
  try {
    assert.equal((await fetch(`http://${s.base}/h/${TOKEN}`)).status, 299);
    const answer = await new Promise<string>((resolve) => {
      let text = "";
      const raw = connect(s.port, "127.0.0.1", () => {
        raw.write(`GET /ws/h?token=${TOKEN} HTTP/1.1\r\nHost: x\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n`);
        setTimeout(() => raw.write("EARLY"), 10); // while admission is still pending
      });
      raw.on("data", (d) => (text += d.toString()));
      raw.on("close", () => resolve(text));
      raw.on("error", () => resolve(text));
    });
    assert.match(answer, /^HTTP\/1\.1 418/);
    assert.match(answer, /X-Got: yes/);
  } finally {
    s.close();
  }
});

test("the upgrade hook gets /ws/h with a well-formed token only", async () => {
  const tokens: string[] = [];
  const s = await bound(
    edge.createShareServer({
      upgrade: (_req, socket, _head, ctx) => {
        tokens.push(ctx.token);
        socket.end("HTTP/1.1 418 Teapot\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
      },
    }),
  );
  try {
    assert.equal((await wsStatus(`ws://${s.base}/ws/h?token=${TOKEN}`)).status, 418);
    assert.equal((await wsStatus(`ws://${s.base}/ws/h?token=short`)).status, 404);
    assert.equal((await wsStatus(`ws://${s.base}/ws/chat?token=${TOKEN}`)).status, 404);
    assert.deepEqual(tokens, [TOKEN]);
  } finally {
    s.close();
  }
});

test("links-events: emitting returns at once; a mint's wait sees only its own changes: the first warning, timedOut, or failed", async () => {
  const mint = (kind: "h" | "i") => () => events.shareLinksChanged({ kind, cause: "mint" });
  const offA = events.onShareLinksChanged(() => {});
  const offB = events.onShareLinksChanged(async () => ({ warning: "not public yet" }));
  assert.equal(events.shareLinksChanged({ kind: "h", cause: "revoke" }), undefined, "outside a wait: fire and forget");
  assert.deepEqual((await events.awaitShareLinks(mint("h"))).outcome, { warning: "not public yet", timedOut: false, failed: false });
  offB();
  assert.deepEqual((await events.awaitShareLinks(() => 7)).result, 7);
  assert.deepEqual((await events.awaitShareLinks(() => 7)).outcome, { warning: null, timedOut: false, failed: false }, "nothing emitted, nothing to wait for");
  const offC = events.onShareLinksChanged(() => new Promise<void>(() => {}));
  const t0 = Date.now();
  assert.deepEqual((await events.awaitShareLinks(mint("i"), 50)).outcome, { warning: null, timedOut: true, failed: false });
  assert.ok(Date.now() - t0 < 1000);
  offC();
  assert.deepEqual((await events.awaitShareLinks(mint("h"), 200)).outcome, { warning: null, timedOut: false, failed: false }, "a stuck answer from an earlier mint is not this one's");
  const offD = events.onShareLinksChanged(() => {
    throw new Error("listener bug");
  });
  const log = await warnings(async () => {
    const { outcome } = await events.awaitShareLinks(async () => {
      await new Promise((r) => setTimeout(r, 5));
      events.shareLinksChanged({ kind: "h", cause: "mint" }); // after an await: still this mint's
    });
    assert.deepEqual(outcome, { warning: null, timedOut: false, failed: true }, "a throwing listener is failed, never confirmed");
  });
  assert.match(log, /listener failed/);
  offA();
  offD();
});

test("setting-events: a throwing or rejecting listener is logged, never unhandled, and the others still run", async () => {
  const file = { version: 1 as const, route: "off" as const };
  const got: string[] = [];
  const unhandled: unknown[] = [];
  const onUnhandled = (e: unknown) => void unhandled.push(e);
  process.on("unhandledRejection", onUnhandled);
  const offs = [
    settingEvents.onPublicLinksChanged(async () => {
      throw new Error("rebind failed");
    }),
    settingEvents.onPublicLinksChanged(() => {
      throw new Error("sync failure");
    }),
    settingEvents.onPublicLinksChanged((f) => void got.push(f.route as string)),
  ];
  try {
    const log = await warnings(async () => {
      settingEvents.publicLinksChanged(file);
      await new Promise((r) => setTimeout(r, 20));
    });
    assert.deepEqual(got, ["off"]);
    assert.match(log, /rebind failed/);
    assert.match(log, /sync failure/);
    assert.deepEqual(unhandled, []);
  } finally {
    process.off("unhandledRejection", onUnhandled);
    for (const off of offs) off();
  }
});

test("the security helpers are real (their full tables: share-security.test.ts); clientAddress is unchanged", async () => {
  const req = (from: string, xff?: string) => ({ headers: xff ? { "x-forwarded-for": xff } : {}, socket: { remoteAddress: from } });
  for (const from of ["127.0.0.1", "100.101.1.2", "198.51.100.7"])
    assert.equal(security.trustedClient(req(from, "203.0.113.9"), { trust: "admitted", admitted: true }), "203.0.113.9", `admitted, from ${from}`);
  assert.equal(security.trustedClient(req("127.0.0.1", "198.51.100.1, 203.0.113.9"), { trust: "local-proxy" }), "203.0.113.9", "a loopback front: its last hop");
  assert.equal(security.trustedClient(req("100.101.1.2", "203.0.113.9"), { trust: "local-proxy" }), "100.101.1.2", "a tailnet source: its socket");
  assert.equal(security.trustedClient(req("127.0.0.1", "203.0.113.9"), { trust: "none" }), "127.0.0.1");
  assert.equal(edge.clientAddress(req("127.0.0.1", "203.0.113.9")), "203.0.113.9", "the listener's old rule is unchanged");
  assert.deepEqual(security.stripForwarded({ "x-forwarded-for": "1.2.3.4", accept: "*/*" }), { accept: "*/*" });
  assert.equal(validateSnapshot({ v: 1, seq: 1, links: [], assets: [], ingressPort: 4802 }, { now: Date.now() }).ok, true);
  assert.equal(await callerNode(new Socket()), null, "no remote address: nobody");
  assert.equal(await gatewayGate(() => ({ nodeId: "n1" }))(new Socket()), false);
});

test("shareState: off with its warning, the env pin configured but unverified (the setting's cases: public-links.test.ts)", () => {
  assert.deepEqual(listener.shareState({}), { state: "off", source: "setting", publicUrl: null, warning: contract.LINK_WARNINGS.off, warningCode: "off" });
  assert.deepEqual(listener.shareState({ SOVA_SHARE_PUBLIC_URL: "https://share.example.com/" }), {
    state: "configured",
    source: "env",
    publicUrl: "https://share.example.com",
    warning: contract.LINK_WARNINGS.unverified,
    warningCode: "unverified",
  });
});

test("every copy string is written: no placeholder left in the frozen contract", () => {
  const all = [...Object.values(contract.LINK_WARNINGS), ...Object.values(contract.FRONT_LABELS), ...Object.values(contract.OFFLINE_PAGE)];
  for (const text of all) assert.ok(!/^[A-Z-]+$/.test(text) && !/PENDING|TODO/.test(text), text);
});

test("session shares: /s/, /api/s/ and its image route are allowed, GET only; nothing else under /s", () => {
  const ok = [`/s/${TOKEN}`, `/api/s/${TOKEN}`, `/api/s/${TOKEN}/img/0`, `/api/s/${TOKEN}/img/7`, `/api/s/${TOKEN}/img/99999`];
  for (const p of ok) assert.equal(edge.shareMayReach("GET", p), true, p);
  const no: [string, string][] = [
    ["POST", `/api/s/${TOKEN}`],
    ["POST", `/api/s/${TOKEN}/message`],
    ["GET", `/api/s/${TOKEN}/message`],
    ["GET", `/api/s/${TOKEN}/img/01`],
    ["GET", `/api/s/${TOKEN}/img/-1`],
    ["GET", `/api/s/${TOKEN}/img/100000`],
    ["GET", `/api/s/${TOKEN}/img/`],
    ["GET", `/s/${TOKEN}/x`],
    ["GET", `/s/assets/index.js`],
    ["GET", `/api/s/${TOKEN}/img/1%2e`],
  ];
  for (const [m, p] of no) assert.equal(edge.shareMayReach(m, p), false, `${m} ${p}`);
});

test("the upgrade hook gets /ws/h and /ws/s with their kind from the path; no other socket", async () => {
  const got: [string, string][] = [];
  const s = await bound(
    edge.createShareServer({
      upgrade: (_req, socket, _head, ctx) => {
        got.push([ctx.kind, ctx.token]);
        socket.end("HTTP/1.1 418 Teapot\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
      },
    }),
  );
  try {
    assert.equal((await wsStatus(`ws://${s.base}/ws/s?token=${TOKEN}`)).status, 418);
    assert.equal((await wsStatus(`ws://${s.base}/ws/h?token=${TOKEN}`)).status, 418);
    assert.equal((await wsStatus(`ws://${s.base}/ws/s?token=short`)).status, 404);
    assert.equal((await wsStatus(`ws://${s.base}/ws/i?token=${TOKEN}`)).status, 404);
    assert.equal((await wsStatus(`ws://${s.base}/ws/s/?token=${TOKEN}`)).status, 404);
    assert.deepEqual(got, [
      ["s", TOKEN],
      ["h", TOKEN],
    ]);
  } finally {
    s.close();
  }
});
