// Run: node scripts/run-tests.mjs server/share-security.integration.test.ts. The public-links edge
// over real loopback sockets (§mesh.public/ingress): raw request targets and methods as bytes on the
// wire, the default client's rate-limit keys, and the gateway gate refusing a non-gateway caller over
// HTTP and WS. Hermetic: loopback sockets, a fake LocalAPI (setIdentity), a throwaway
// PI_CODING_AGENT_DIR. The primitives in process are share-security.test.ts.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import type { Server } from "node:http";
import { connect, type AddressInfo, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import WebSocket from "ws";

const root = realpathSync(mkdtempSync(join(tmpdir(), "sova-share-security-")));
process.env.PI_CODING_AGENT_DIR = join(root, "agent");
mkdirSync(join(root, "agent", "sessions"), { recursive: true });
after(() => rmSync(root, { recursive: true, force: true }));

const { canonicalIp, trustedClient, stripForwarded } = await import("./share/security");
const edge = await import("./share/edge");
const { callerNode, gatewayGate } = await import("./mesh/gate");
const { setIdentity } = await import("./mesh/localapi");
const { REFUSED_HEADER } = await import("./mesh/hello");

const TOKEN = "A".repeat(43);

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

// ---- the gateway gate on the edge ----------------------------------------------------------------

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
