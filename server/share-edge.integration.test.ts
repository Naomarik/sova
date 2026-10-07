// Run: node scripts/run-tests.mjs server/share-edge.integration.test.ts. The share edge's hooks on an
// ephemeral loopback port: dispatch, hook failures, admission (refused, pending, after a wait) and the
// upgrade hook's paths, with a throwaway PI_CODING_AGENT_DIR; ~/.pi untouched. The public-links seams
// in process are share-edge.test.ts.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { request } from "node:http";
import type { AddressInfo } from "node:net";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import WebSocket from "ws";


const root = realpathSync(mkdtempSync(join(tmpdir(), "sova-share-edge-")));
process.env.PI_CODING_AGENT_DIR = join(root, "agent");
mkdirSync(join(root, "agent", "sessions"), { recursive: true });
after(() => rmSync(root, { recursive: true, force: true }));

const edge = await import("./share/edge");
const { REFUSED_HEADER } = await import("./mesh/hello");

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
  /** Each waiting request's leaving, as the edge notices it: an HTTP request's socket closed (it
      checks `destroyed`), an upgrade's ended or closed (its watcher, registered before `admit` runs,
      hears the same event first). */
  const left: Promise<void>[] = [];
  const s = await bound(
    edge.createShareServer({
      admit: (req) => {
        admits++;
        const sock = req.socket;
        left.push(new Promise<void>((r) => (sock.destroyed ? r() : (sock.once("close", () => r()), req.url?.startsWith("/ws/") && sock.once("end", () => r())))));
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
    // The edge has seen both clients leave.
    await Promise.all(left);
    release(true);
    // What the admission's answer runs, it runs before the next turn of the loop.
    await new Promise((r) => setImmediate(r));
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
