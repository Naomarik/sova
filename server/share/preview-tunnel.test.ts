// A Free preview tunnel's host (§mesh.public/preview-tunnels), in process: the key rule (the open hop and the
// cookie), `/_sova/` never reaching the app, the exact Host match, and the misses' limit. The proxy is a
// stand-in that records what reaches the app; the share edge's wiring is the integration file's.
import "../testing/scratch-agent-dir.ts";
import assert from "node:assert/strict";
import type { IncomingMessage, ServerResponse } from "node:http";
import { test } from "node:test";
import type { PreviewRecord } from "../preview-links";
import type { PreviewProxy } from "./preview-proxy";

const { createPreviewTunnelHooks, keyCookie, openRedirect, tunnelHostOf, KEY_MISSES_PER_MINUTE } = await import("./preview-tunnel");

const NOW = Date.parse("2026-11-12T12:00:00Z");
const label = (c: string) => c.repeat(52);
const iso = (ms: number) => new Date(ms).toISOString();
const rec = (l: string, over: Partial<PreviewRecord>): PreviewRecord => ({ id: `pv_${l.slice(0, 16)}`, hash: l, projectId: "p", port: 5173, createdAt: iso(NOW - 1000), expiresAt: iso(NOW + 3_600_000), createdBy: "operator", ...over });

// The labels by what they are: an active preview of this tunnel's port, another port's, a turned-off one, an expired one, one unknown.
const VALID = label("a");
const OTHER_PORT = label("b");
const OFF = label("c");
const EXPIRED = label("d");
const UNKNOWN = label("e");
const RECORDS = new Map<string, PreviewRecord>([
  [VALID, rec(VALID, {})],
  [OTHER_PORT, rec(OTHER_PORT, { port: 3000 })],
  [OFF, rec(OFF, { revokedAt: iso(NOW - 10) })],
  [EXPIRED, rec(EXPIRED, { expiresAt: iso(NOW - 10) })],
]);
const HOST = "able-baker-charlie-delta.trycloudflare.com";

function harness() {
  const reached: { label: string; url: string }[] = [];
  const proxy: PreviewProxy = {
    dispatch: (req, res, l) => {
      reached.push({ label: l, url: req.url ?? "" });
      res.writeHead(200);
      res.end("app");
    },
    upgrade: (req, socket, _head, l) => {
      reached.push({ label: l, url: req.url ?? "" });
      socket.end();
    },
    sweep: () => {},
    openCount: () => 0,
    dispose: () => {},
  };
  const hooks = createPreviewTunnelHooks({ hosts: () => new Map([[HOST, 5173]]), originOf: () => `https://${HOST}`, find: (l) => RECORDS.get(l) ?? null, proxy, now: () => NOW });
  return { hooks, reached };
}

interface Answer {
  status: number;
  headers: Record<string, string>;
}
function call(hooks: ReturnType<typeof harness>["hooks"], url: string, opts: { cookie?: string; method?: string; client?: string } = {}): Answer {
  const req = { url, method: opts.method ?? "GET", headers: { host: HOST, ...(opts.cookie ? { cookie: opts.cookie } : {}) }, resume() {} } as unknown as IncomingMessage;
  const out: Answer = { status: 0, headers: {} };
  const fake = { destroyed: false, headersSent: false, writeHead: (_s: number, _h?: Record<string, string>) => fake, end: () => {} };
  fake.writeHead = (status, headers) => {
    out.status = status;
    for (const [k, v] of Object.entries(headers ?? {})) out.headers[k.toLowerCase()] = String(v);
    fake.headersSent = true;
    return fake;
  };
  const res = fake as unknown as ServerResponse;
  hooks.dispatch(req, res, 5173, opts.client ?? "198.51.100.7");
  return out;
}

test("the key rule: only an active preview of this tunnel's port opens, by the open hop or by its cookie", () => {
  const cases: [string, string, boolean][] = [
    ["valid", VALID, true],
    ["another port's", OTHER_PORT, false],
    ["turned off", OFF, false],
    ["expired", EXPIRED, false],
    ["unknown", UNKNOWN, false],
  ];
  for (const [name, l, opens] of cases) {
    const { hooks, reached } = harness();
    const open = call(hooks, `/_sova/open/${l}/deep/route?x=1`);
    if (opens) {
      assert.equal(open.status, 302, name);
      assert.equal(open.headers.location, "/deep/route?x=1", name);
      assert.equal(open.headers["set-cookie"], `__Host-sova-pk=${l}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=3600`, name);
      assert.equal(open.headers["cache-control"], "no-store", name);
      assert.equal(open.headers["referrer-policy"], "no-referrer", name);
    } else {
      assert.equal(open.status, 404, name);
      assert.equal(open.headers["set-cookie"], undefined, name);
    }
    const page = call(hooks, "/deep/route", { cookie: `sid=1; __Host-sova-pk=${l}` });
    assert.equal(page.status, opens ? 200 : 404, name);
    assert.deepEqual(reached, opens ? [{ label: l, url: "/deep/route" }] : [], `${name}: what reached the app`);
  }
  // No cookie at all, and a cookie of the wrong shape, are the unknown-preview 404.
  for (const cookie of [undefined, "__Host-sova-pk=short", `__Host-sova-pk=${VALID.toUpperCase()}`]) {
    const { hooks, reached } = harness();
    assert.equal(call(hooks, "/", cookie ? { cookie } : {}).status, 404, String(cookie));
    assert.deepEqual(reached, []);
  }
});

test("/_sova/ never reaches the app, with a valid cookie or a valid key under another method", () => {
  const { hooks, reached } = harness();
  const cookie = `__Host-sova-pk=${VALID}`;
  for (const url of ["/_sova", "/_sova/", "/_sova/x", `/_sova/open/${VALID}x`, "/_sova/open/", `/_sova/other/${VALID}`]) assert.equal(call(hooks, url, { cookie }).status, 404, url);
  assert.equal(call(hooks, `/_sova/open/${VALID}`, { method: "POST" }).status, 404);
  assert.deepEqual(reached, []);
});

test("wrong or missing keys: 20 a minute per client address, then 429; another address keeps its own count", () => {
  const { hooks } = harness();
  for (let i = 0; i < KEY_MISSES_PER_MINUTE; i++) assert.equal(call(hooks, `/_sova/open/${UNKNOWN}`).status, 404, `miss ${i + 1}`);
  assert.equal(call(hooks, "/").status, 429);
  assert.equal(call(hooks, "/", { client: "203.0.113.9" }).status, 404);
  // The key holder still opens: only misses count.
  assert.equal(call(hooks, `/_sova/open/${VALID}`).status, 302);
});

test("the open hop redirects only to a path on the same host", () => {
  assert.equal(openRedirect(undefined, ""), "/");
  assert.equal(openRedirect("/", "a=1"), "/?a=1");
  assert.equal(openRedirect("/x/y", ""), "/x/y");
  for (const rest of ["//evil.example/x", "/\\evil.example", "/"]) assert.equal(openRedirect(rest, ""), "/", rest);
});

test("a request is a preview tunnel's only when its Host is exactly a running tunnel's host", () => {
  const { hooks } = harness();
  const match = (host: string | undefined) => hooks.match({ headers: host === undefined ? {} : { host } } as IncomingMessage);
  assert.equal(match(HOST), 5173);
  assert.equal(match(HOST.toUpperCase()), 5173);
  assert.equal(match(`${HOST}:443`), 5173);
  for (const host of [undefined, "", `${HOST}:8443`, `x.${HOST}`, `${HOST}.evil.example`, "share-words.trycloudflare.com", "localhost:4802"]) assert.equal(match(host), null, String(host));
  assert.equal(tunnelHostOf(" A.B:443 "), "a.b");
});

test("the key cookie: the label's shape only, the last one when sent twice", () => {
  assert.equal(keyCookie(`a=1; __Host-sova-pk=${VALID}`), VALID);
  assert.equal(keyCookie(`__Host-sova-pk=${OFF}; __Host-sova-pk=${VALID}`), VALID);
  assert.equal(keyCookie("__Host-sova-pv=abc"), null);
  assert.equal(keyCookie(undefined), null);
});
