// Run: pnpm exec tsx --test server/auth-gate.test.ts
// The main listener's token gate (§app.access/gate, §app.access/token, §app.access/unlock) over a
// real socket: the server on an ephemeral port against a throwaway PI_CODING_AGENT_DIR (removed
// after), every request sent with node:http so the Host, Origin and Sec-Fetch-Site headers are
// exactly what a browser (or an attacker's page) would send. app.request() never reaches the gate's
// socket checks, so only the exemption tests use it.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { request, type IncomingHttpHeaders } from "node:http";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { WebSocket } from "ws";

const tmp = mkdtempSync(join(tmpdir(), "sova-auth-gate-test-"));
process.env.PI_CODING_AGENT_DIR = join(tmp, "agent");
process.env.PORT = "0";
// The gate as installed: the token comes from the file, the gate is on, loopback-bound.
for (const name of ["SOVA_TOKEN", "SOVA_AUTH", "HOST", "SOVA_ALLOWED_HOSTS", "SOVA_ALLOWED_ORIGINS"]) delete process.env[name];
mkdirSync(join(tmp, "agent", "sessions", "live"), { recursive: true });

const { app, server } = await import("./index");
const { AUTH_COOKIE, serverAuthEnabled, setAuthHosts, sovaToken, tokenFile } = await import("./auth");
if (!server.listening) await new Promise((r) => server.once("listening", r));
const port = (server.address() as { port: number }).port;

after(() => {
  server.close();
  server.closeAllConnections();
  rmSync(tmp, { recursive: true, force: true });
});

const token = sovaToken();
const self = `127.0.0.1:${port}`;
const cookie = (value: string) => `${AUTH_COOKIE}=${value}`;
/** What the app's own page sends: its cookie, its origin, same-origin fetch metadata. */
const browser = (extra: Record<string, string> = {}) => ({ Host: self, Origin: `http://${self}`, "Sec-Fetch-Site": "same-origin", Cookie: cookie(token), ...extra });

type Answer = { status: number; headers: IncomingHttpHeaders; body: string };
/** One request on a new connection, headers exactly as given (Host included). */
function send(method: string, path: string, headers: Record<string, string> = {}, body?: string): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path, method, headers: { Host: self, ...headers }, agent: false }, (res) => {
      let text = "";
      res.on("data", (c) => (text += c));
      res.on("end", () => resolve({ status: res.statusCode!, headers: res.headers, body: text }));
    });
    req.on("error", reject);
    req.setTimeout(8000, () => req.destroy(new Error(`no answer within 8 s: ${method} ${path}`)));
    req.end(body);
  });
}
const get = (path: string, headers?: Record<string, string>) => send("GET", path, headers);

/** A protected route that answers 200 to anyone the gate lets through. */
const PROTECTED = "/api/settings";

describe("the token", () => {
  test("no token is a 401 — on the API, the sockets' HTTP twins, /explain, /ext and /peer alike (default deny)", async () => {
    for (const path of [PROTECTED, "/api/sessions", "/api/no-such-route", "/explain/x/y", "/ext/stub/api/rows", "/peer/b/api/health", "/ws/chat"]) {
      const res = await get(path, { Origin: `http://${self}`, "Sec-Fetch-Site": "same-origin" });
      assert.equal(res.status, 401, path);
      assert.equal(res.body.includes(token), false, "a refusal never carries the token");
    }
    const post = await send("POST", PROTECTED, { "Content-Type": "application/json", Origin: `http://${self}` }, "{}");
    assert.equal(post.status, 401, "a write with no token");
  });

  test("a wrong token is a 401, as a cookie or a header", async () => {
    assert.equal((await get(PROTECTED, browser({ Cookie: cookie("not-the-token") }))).status, 401);
    assert.equal((await get(PROTECTED, { "x-sova-token": "not-the-token" })).status, 401);
    assert.equal((await get(PROTECTED, { "x-sova-token": `${token}x` })).status, 401, "a longer value is not a match");
    assert.equal((await get(PROTECTED, { Cookie: `sova_token=${token}` })).status, 401, "only this install's cookie name counts");
    assert.equal((await get(PROTECTED, { Authorization: `Bearer ${token}` })).status, 401, "x-sova-token is the one header; a bearer isn't accepted");
  });

  test("the cookie from the app's own page passes", async () => {
    const res = await get(PROTECTED, browser());
    assert.equal(res.status, 200);
    assert.doesNotThrow(() => JSON.parse(res.body));
  });

  test("the x-sova-token header passes (a script, a link tool: no Origin, no fetch metadata)", async () => {
    assert.equal((await get(PROTECTED, { "x-sova-token": token })).status, 200);
  });

  test("duplicate cookies: any one value that matches passes (another port's page can't shadow it)", async () => {
    assert.equal((await get(PROTECTED, browser({ Cookie: `${cookie("clobbered")}; ${cookie(token)}` }))).status, 200);
    assert.equal((await get(PROTECTED, browser({ Cookie: `${cookie(token)}; ${cookie("clobbered")}` }))).status, 200);
    assert.equal((await get(PROTECTED, browser({ Cookie: `other=1; ${cookie("a")}; ${cookie("b")}` }))).status, 401);
  });

  test("Sec-Fetch-Site none (typed URL, bookmark) or absent passes with a valid token", async () => {
    assert.equal((await get(PROTECTED, { Cookie: cookie(token), "Sec-Fetch-Site": "none" })).status, 200);
    assert.equal((await get(PROTECTED, { Cookie: cookie(token) })).status, 200);
  });
});

describe("where the request comes from (403, even with a valid token)", () => {
  test("a foreign Host (DNS rebinding) is a 403; a forwarded-host header doesn't launder it", async () => {
    assert.equal((await get(PROTECTED, { Host: "evil.example" })).status, 403, "Host is judged before the token");
    assert.equal((await get(PROTECTED, { "x-sova-token": token, "X-Forwarded-Host": "example.test" })).status, 200, "X-Forwarded-Host is ignored, not refused");
    // An IP literal is no exception on a loopback bind: only the loopback ones are this app.
    for (const host of [`evil.example:${port}`, "evil.example", `127.0.0.1.evil.example:${port}`, `192.168.1.20:${port}`, `100.64.0.7:${port}`, "[2001:db8::1]"]) {
      assert.equal((await get(PROTECTED, { Host: host, Cookie: cookie(token) })).status, 403, host);
      assert.equal((await get(PROTECTED, { Host: host, "x-sova-token": token })).status, 403, `${host} (header)`);
      assert.equal((await get(PROTECTED, { Host: host, "x-sova-token": token, "X-Forwarded-Host": self, "X-Sova-Relayed": "1" })).status, 403, `${host} + forwarded marks`);
    }
    // Loopback names on any port stay this app (the Vite proxy keeps Host=localhost:5173).
    for (const host of [`localhost:${port}`, "localhost:5173", self]) {
      assert.equal((await get(PROTECTED, { Host: host, "x-sova-token": token })).status, 200, host);
    }
  });

  test("same-site from another 127.0.0.1 port is a 403, with the cookie the browser hands it", async () => {
    const other = "http://127.0.0.1:8999";
    assert.equal((await get(PROTECTED, browser({ Origin: other, "Sec-Fetch-Site": "same-site" }))).status, 403);
    assert.equal((await get(PROTECTED, { Cookie: cookie(token), "Sec-Fetch-Site": "same-site" })).status, 403, "an <img>/<script> GET: no Origin, still same-site");
    assert.equal((await send("POST", PROTECTED, browser({ Origin: other, "Sec-Fetch-Site": "same-site", "Content-Type": "application/json" }), "{}")).status, 403);
    assert.equal((await get(PROTECTED, browser({ Origin: other, "Sec-Fetch-Site": "same-origin" }))).status, 403, "an Origin that isn't this Host");
  });

  test("cross-site is a 403: the CSRF demo's shape, an Origin: null, a bare cross-site fetch", async () => {
    const evil = "https://evil.example";
    // The demo: a form/fetch POST from another site; the browser omits the Strict cookie, but even with it, no.
    assert.equal((await send("POST", PROTECTED, browser({ Origin: evil, "Sec-Fetch-Site": "cross-site", "Content-Type": "text/plain;charset=UTF-8" }), "{}")).status, 403);
    assert.equal((await get(PROTECTED, browser({ Origin: evil, "Sec-Fetch-Site": "cross-site" }))).status, 403);
    assert.equal((await get(PROTECTED, browser({ Origin: "null" }))).status, 403, "Origin: null (sandboxed frame, data: URL)");
    assert.equal((await get(PROTECTED, { Cookie: cookie(token), "Sec-Fetch-Site": "cross-site" })).status, 403);
    assert.equal((await get(PROTECTED, { "x-sova-token": token, Origin: evil })).status, 403);
  });
});

describe("the allowed-origin set: exact scheme, host and port, never the host alone", () => {
  // What the mesh would name: this host's MagicDNS name, its front door and serve URL, a peer's serve URL.
  const MAGIC = "a.tail1234.ts.net";
  const DOOR = "https://door.example.com";
  const PEER = "https://b.tail1234.ts.net";
  const withNames = (t: { after: (fn: () => void) => void }) => {
    setAuthHosts(() => ({ magicDns: MAGIC, own: [DOOR, `https://${MAGIC}`], peers: [PEER] }));
    t.after(() => setAuthHosts(() => ({})));
  };
  const withCookie = (extra: Record<string, string>) => ({ Cookie: cookie(token), ...extra });

  test("the other loopback names and this machine's hostname on this port pass; a host-only match on another port is a 403", async () => {
    for (const origin of [`http://localhost:${port}`, `http://127.0.0.1:${port}`]) {
      assert.equal((await get(PROTECTED, withCookie({ Origin: origin, "Sec-Fetch-Site": "same-origin" }))).status, 200, origin);
    }
    const me = hostname().toLowerCase();
    assert.equal((await get(PROTECTED, withCookie({ Host: `${me}:${port}`, Origin: `http://${me}:${port}` }))).status, 200, "this machine's hostname");
    for (const origin of ["http://127.0.0.1:8999", "http://localhost:5173", `http://${me}:8999`, "http://127.0.0.1"]) {
      assert.equal((await get(PROTECTED, withCookie({ Origin: origin }))).status, 403, `GET from ${origin}`);
      assert.equal((await send("POST", PROTECTED, withCookie({ Origin: origin, "Content-Type": "application/json" }), "{}")).status, 403, `POST from ${origin}`);
    }
  });

  test("the front door's origin passes, cross-site fetch metadata and all", async (t) => {
    withNames(t);
    assert.equal((await get(PROTECTED, withCookie({ Origin: DOOR, "Sec-Fetch-Site": "cross-site" }))).status, 200, "Host: this listener (the door proxies here)");
    assert.equal((await get(PROTECTED, withCookie({ Host: "door.example.com", Origin: DOOR, "Sec-Fetch-Site": "same-origin" }))).status, 200, "Host: the door's own name");
    assert.equal((await get(PROTECTED, withCookie({ Origin: "https://door.example.com:8443" }))).status, 403, "the door's host on another port");
    assert.equal((await get(PROTECTED, withCookie({ Origin: "http://door.example.com" }))).status, 403, "the door's host on another scheme");
  });

  test("this host's MagicDNS name passes on any port (tailscale serve at :8443); a peer's serve URL passes; a look-alike doesn't", async (t) => {
    withNames(t);
    for (const origin of [`https://${MAGIC}:8443`, `https://${MAGIC}`, `http://${MAGIC}:${port}`]) {
      assert.equal((await get(PROTECTED, withCookie({ Host: `${MAGIC}:8443`, Origin: origin, "Sec-Fetch-Site": "same-origin" }))).status, 200, origin);
    }
    assert.equal((await get(PROTECTED, withCookie({ Origin: PEER, "Sec-Fetch-Site": "same-site" }))).status, 200, "a peer's page (the mesh switcher)");
    for (const origin of ["https://c.tail1234.ts.net", `https://${MAGIC}.evil.example`, "https://evil.ts.net"]) {
      assert.equal((await get(PROTECTED, withCookie({ Origin: origin }))).status, 403, origin);
    }
  });

  test("SOVA_ALLOWED_ORIGINS adds exact origins", async (t) => {
    const extra = "https://extra.example:9443";
    assert.equal((await get(PROTECTED, withCookie({ Origin: extra }))).status, 403, "not before it's listed");
    process.env.SOVA_ALLOWED_ORIGINS = `https://other.example, ${extra}`;
    t.after(() => delete process.env.SOVA_ALLOWED_ORIGINS);
    assert.equal((await get(PROTECTED, withCookie({ Origin: extra }))).status, 200);
    assert.equal((await get(PROTECTED, withCookie({ Origin: "https://extra.example" }))).status, 403, "the listed host on another port");
  });

  test("same-site or cross-site with no allowed Origin is a 403, valid cookie or not", async () => {
    for (const site of ["same-site", "cross-site"]) {
      assert.equal((await get(PROTECTED, withCookie({ "Sec-Fetch-Site": site }))).status, 403, `${site}, no Origin`);
      assert.equal((await get(PROTECTED, withCookie({ "Sec-Fetch-Site": site, Origin: "http://127.0.0.1:8999" }))).status, 403, `${site}, another port`);
    }
  });

  test("a cross-site navigation opens only the shell: an /api route is refused however it is reached", async () => {
    const nav = { "Sec-Fetch-Site": "cross-site", "Sec-Fetch-Mode": "navigate", "Sec-Fetch-Dest": "document" };
    for (const headers of [nav, { ...nav, Origin: "https://evil.example" }]) {
      const shell = await get("/", headers);
      assert.notEqual(shell.status, 401, "the shell");
      assert.notEqual(shell.status, 403, "the shell");
      assert.ok(shell.headers["x-sova-server"]);
      assert.equal((await get(PROTECTED, headers)).status, 403, "an /api route, no cookie (Strict withholds it)");
      assert.equal((await get(PROTECTED, withCookie(headers))).status, 403, "an /api route, even with the cookie");
      assert.equal((await get("/explain/x/y", withCookie(headers))).status, 403, "/explain");
      assert.equal((await send("POST", "/", withCookie({ ...headers, "Content-Type": "application/x-www-form-urlencoded" }), "a=1")).status, 403, "a form POST navigation");
    }
    const sameNav = { "Sec-Fetch-Site": "none", "Sec-Fetch-Mode": "navigate", "Sec-Fetch-Dest": "document" };
    assert.equal((await get(PROTECTED, sameNav)).status, 401, "a typed /api URL with no cookie: the token, not the origin");
    assert.equal((await get(PROTECTED, withCookie(sameNav))).status, 200, "and with it");
  });

  test("WS: 127.0.0.1:8999 with a valid cookie is a 403; the front door's origin opens", async (t) => {
    withNames(t);
    const status = (headers: Record<string, string>) =>
      new Promise<"open" | number | string>((resolve) => {
        const ws = new WebSocket(`ws://${self}/ws/watch?path=nope`, { headers });
        ws.on("open", () => (resolve("open"), ws.terminate()));
        ws.on("unexpected-response", (_req, res) => (resolve(res.statusCode ?? 0), ws.terminate()));
        ws.on("error", (err) => resolve(err.message));
      });
    assert.equal(await status(withCookie({ Origin: "http://127.0.0.1:8999" })), 403);
    assert.equal(await status(withCookie({ Origin: "http://localhost:5173" })), 403);
    assert.equal(await status(withCookie({ Origin: DOOR })), "open");
    assert.equal(await status(withCookie({ Origin: `https://${MAGIC}:8443` })), "open");
  });
});

describe("tailscale serve with the mesh off: a *.ts.net Host on its own https origin", () => {
  // No peers.json, no SOVA_ALLOWED_HOSTS/ORIGINS: nothing names this host's MagicDNS name.
  const TS = "laptop.tail1234.ts.net:8443";
  const served = (extra: Record<string, string> = {}) => ({ Host: TS, Cookie: cookie(token), ...extra });

  test("(a) Host and Origin both https://<name>.ts.net:8443 with the cookie is answered, HTTP and WS", async () => {
    assert.equal((await get(PROTECTED, served({ Origin: `https://${TS}`, "Sec-Fetch-Site": "same-origin" }))).status, 200);
    assert.equal((await send("POST", PROTECTED, served({ Origin: `https://${TS}`, "Content-Type": "application/json" }), "{}")).status !== 403, true, "a write too");
    // A fully-qualified name (trailing dot) is the same name; its page's Origin carries the dot too.
    // (Upper case can't be sent here: @hono/node-server answers a 400 for it before any route runs.)
    assert.equal((await get(PROTECTED, served({ Host: "laptop.tail1234.ts.net.:8443", Origin: "https://laptop.tail1234.ts.net.:8443" }))).status, 200, "a trailing dot");
    assert.equal((await get(PROTECTED, served())).status, 200, "no Origin (a navigation or script)");
    assert.equal((await get(PROTECTED, { Host: TS, Origin: `https://${TS}` })).status, 401, "still the token: the name only admits the host");
    const opened = await new Promise<"open" | number | string>((resolve) => {
      const ws = new WebSocket(`ws://${self}/ws/watch?path=nope`, { headers: served({ Origin: `https://${TS}` }) });
      ws.on("open", () => (resolve("open"), ws.terminate()));
      ws.on("unexpected-response", (_req, res) => (resolve(res.statusCode ?? 0), ws.terminate()));
      ws.on("error", (err) => resolve(err.message));
    });
    assert.equal(opened, "open");
  });

  test("(b) the same Host with Origin https://evil.example is a 403", async () => {
    assert.equal((await get(PROTECTED, served({ Origin: "https://evil.example" }))).status, 403);
    assert.equal((await send("POST", PROTECTED, served({ Origin: "https://evil.example", "Content-Type": "text/plain" }), "{}")).status, 403);
  });

  test("(c) the same Host with another ts.net origin, or this one on another port or scheme, is a 403", async () => {
    for (const origin of ["https://other.ts.net:8443", "https://other.tail1234.ts.net:8443", "https://laptop.tail1234.ts.net", "https://laptop.tail1234.ts.net:9443", `http://${TS}`]) {
      assert.equal((await get(PROTECTED, served({ Origin: origin }))).status, 403, origin);
    }
    // A ts.net Origin is only ever its own Host: from this listener's loopback Host it proves nothing.
    assert.equal((await get(PROTECTED, { Cookie: cookie(token), Origin: `https://${TS}` })).status, 403, "Host 127.0.0.1");
    // And ts.net is matched as a suffix of labels, never of characters.
    assert.equal((await get(PROTECTED, { Host: "evilts.net:8443", Cookie: cookie(token), Origin: "https://evilts.net:8443" })).status, 403, "evilts.net");
  });
});

describe("what stays open", () => {
  test("GET /api/health answers with no token", async () => {
    const res = await get("/api/health");
    assert.equal(res.status, 200);
    assert.equal((JSON.parse(res.body) as { ok: boolean }).ok, true);
  });

  test("POST /api/auth/unlock: a wrong token sets nothing; the right one sets an HttpOnly, SameSite=Strict cookie that then passes", async () => {
    const json = { "Content-Type": "application/json", Origin: `http://${self}`, "Sec-Fetch-Site": "same-origin" };
    const wrong = await send("POST", "/api/auth/unlock", json, JSON.stringify({ token: "nope" }));
    assert.equal(wrong.status, 401);
    assert.equal(wrong.headers["set-cookie"], undefined);
    const right = await send("POST", "/api/auth/unlock", json, JSON.stringify({ token }));
    assert.ok(right.status >= 200 && right.status < 300, `unlock answered ${right.status}`);
    assert.equal(right.body.includes(token), false, "the answer never echoes the token");
    const set = (right.headers["set-cookie"] ?? []).find((c) => c.startsWith(`${AUTH_COOKIE}=`));
    assert.ok(set, `a ${AUTH_COOKIE} cookie is set`);
    const attrs = set.split(";").map((a) => a.trim().toLowerCase());
    assert.equal(set.split(";")[0], cookie(token));
    assert.ok(attrs.includes("httponly"), set);
    assert.ok(attrs.includes("samesite=strict"), set);
    assert.ok(attrs.includes("path=/"), set);
    assert.equal(attrs.some((a) => a.startsWith("domain=")), false, "host-only: never shared with subdomains");
    assert.equal((await get(PROTECTED, browser({ Cookie: set.split(";")[0]! }))).status, 200, "the cookie it set passes");
  });

  test("the unlock cookie is Secure on a ts.net Host, never because of X-Forwarded-Proto", async (t) => {
    const body = JSON.stringify({ token });
    const json = { "Content-Type": "application/json" };
    const spoofed = await send("POST", "/api/auth/unlock", { ...json, "X-Forwarded-Proto": "https" }, body);
    assert.equal(spoofed.status, 200);
    assert.equal(/;\s*secure/i.test(spoofed.headers["set-cookie"]?.[0] ?? ""), false, "a header can't make it Secure");
    setAuthHosts(() => ({ magicDns: "a.tail1234.ts.net" }));
    t.after(() => setAuthHosts(() => ({})));
    const served = await send("POST", "/api/auth/unlock", { ...json, Host: "a.tail1234.ts.net", Origin: "https://a.tail1234.ts.net" }, body);
    assert.equal(served.status, 200);
    assert.match(served.headers["set-cookie"]?.[0] ?? "", /;\s*Secure/i, "tailscale serve is https");
  });

  test("GET /api/auth/status: 401 without the token, 200 with it", async () => {
    const locked = await get("/api/auth/status");
    assert.equal(locked.status, 401);
    assert.equal((JSON.parse(locked.body) as { locked: boolean }).locked, true);
    const open = await get("/api/auth/status", browser());
    assert.equal(open.status, 200);
    assert.deepEqual(JSON.parse(open.body), { ok: true });
  });

  test("unlock from another site is refused like any cross-site request", async () => {
    const res = await send("POST", "/api/auth/unlock", { "Content-Type": "application/json", Origin: "https://evil.example", "Sec-Fetch-Site": "cross-site" }, JSON.stringify({ token }));
    assert.equal(res.status, 403);
    assert.equal(res.headers["set-cookie"], undefined);
  });

  test("every route the app mounts is in a family the gate asks for (no new family is silently open)", () => {
    const open = [...new Set(app.routes.map((r) => r.path))].filter((p) => p !== "*" && p !== "/*" && !/^\/(?:api|ext|peer|explain|design|ws)(?:\/|$)/.test(p));
    assert.deepEqual(open, []);
  });

  test("the static shell is not behind the token (404 with no build, the app with one)", async () => {
    for (const path of ["/", "/assets/index.js"]) {
      const res = await get(path, { "Sec-Fetch-Site": "none" });
      assert.notEqual(res.status, 401, path);
      assert.notEqual(res.status, 403, path);
    }
  });
});

describe("X-Sova-Server marks every main-listener answer (a preview of this port refuses it)", () => {
  test("on a 200, a 401, a 403, health, unlock and the static shell", async () => {
    const answers: Array<[string, Answer]> = [
      ["200", await get(PROTECTED, browser())],
      ["401", await get(PROTECTED)],
      ["403", await get(PROTECTED, { Host: "evil.example", Cookie: cookie(token) })],
      ["health", await get("/api/health")],
      ["unlock 401", await send("POST", "/api/auth/unlock", { "Content-Type": "application/json" }, JSON.stringify({ token: "nope" }))],
      ["static", await get("/")],
    ];
    for (const [what, res] of answers) assert.ok(res.headers["x-sova-server"], `${what} (${res.status}) carries X-Sova-Server`);
  });
});

describe("exempt callers: no socket, or the peer listener", () => {
  // What @hono/node-server passes as env for a real socket, minimally.
  const incoming = { socket: { remoteAddress: "127.0.0.1" }, headers: { host: self }, url: PROTECTED, method: "GET" };

  test("app.request (the Overseer, schedules, tests: no socket at all) passes with no token", async () => {
    assert.equal((await app.request(PROTECTED)).status, 200);
  });

  test("a peer-listener call (env.meshPeer) passes with no token; the same env without meshPeer doesn't", async () => {
    assert.equal((await app.request(PROTECTED, { headers: { Host: self } }, { incoming, meshPeer: { id: "p" } })).status, 200);
    assert.equal((await app.request(PROTECTED, { headers: { Host: self } }, { incoming })).status, 401, "not vacuous: a socket with no peer is gated");
  });
});

describe("SOVA_AUTH=off (a test rig's switch)", () => {
  const saved = { auth: process.env.SOVA_AUTH, host: process.env.HOST };
  const restore = () => {
    for (const [k, v] of [["SOVA_AUTH", saved.auth], ["HOST", saved.host]] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };

  test("honoured on a loopback bind: the gate lets a tokenless same-origin request through", async (t) => {
    t.after(restore);
    assert.equal(serverAuthEnabled(), true, "on by default");
    process.env.SOVA_AUTH = "off";
    assert.equal(serverAuthEnabled(), false);
    assert.equal((await get(PROTECTED, { Origin: `http://${self}`, "Sec-Fetch-Site": "same-origin" })).status, 200);
  });

  test("ignored when bound off loopback: the token is asked for", async (t) => {
    t.after(restore);
    process.env.SOVA_AUTH = "off";
    for (const host of ["0.0.0.0", "::", "192.168.1.20", "100.64.0.7"]) {
      process.env.HOST = host;
      assert.equal(serverAuthEnabled(), true, `HOST=${host}`);
      assert.equal((await get(PROTECTED, { Origin: `http://${self}`, "Sec-Fetch-Site": "same-origin" })).status, 401, `HOST=${host}`);
    }
  });

  test("never lifts the Host or cross-site rules", async (t) => {
    t.after(restore);
    process.env.SOVA_AUTH = "off";
    assert.equal((await get(PROTECTED, { Host: "evil.example" })).status, 403);
    assert.equal((await get(PROTECTED, { Origin: "https://evil.example", "Sec-Fetch-Site": "cross-site" })).status, 403);
  });
});

describe("the WebSocket upgrade", () => {
  test("a refused upgrade carries X-Sova-Server too", async () => {
    const mark = await new Promise<string | undefined>((resolve) => {
      const ws = new WebSocket(`ws://${self}/ws/watch?path=nope`);
      ws.on("unexpected-response", (_req, res) => (resolve(res.headers["x-sova-server"] as string | undefined), ws.terminate()));
      ws.on("open", () => (resolve("opened"), ws.terminate()));
      ws.on("error", () => resolve(undefined));
    });
    assert.equal(mark, "sova");
  });

  /** "open" if the handshake succeeded, else the refusal's HTTP status (or the error). */
  function upgrade(path: string, headers: Record<string, string> = {}): Promise<"open" | number | string> {
    return new Promise((resolve) => {
      const ws = new WebSocket(`ws://${self}${path}`, { headers });
      ws.on("open", () => {
        resolve("open");
        ws.terminate();
      });
      ws.on("unexpected-response", (_req, res) => {
        resolve(res.statusCode ?? 0);
        ws.terminate();
      });
      ws.on("error", (err) => resolve(err.message));
      setTimeout(() => {
        resolve("no answer within 8 s");
        ws.terminate();
      }, 8000).unref();
    });
  }
  const watch = "/ws/watch?path=nope";

  test("no token: refused with a 401, before any dispatch (an /ext socket too)", async () => {
    assert.equal(await upgrade(watch, { Origin: `http://${self}` }), 401);
    assert.equal(await upgrade("/ws/chat?path=nope", { Origin: `http://${self}` }), 401);
    assert.equal(await upgrade("/ext/stub/ws/x", { Origin: `http://${self}` }), 401);
    assert.equal(await upgrade(watch, { Origin: `http://${self}`, Cookie: cookie("wrong") }), 401);
  });

  test("a foreign Origin is refused even with the cookie (cross-site and another 127.0.0.1 port)", async () => {
    assert.equal(await upgrade(watch, { Origin: "https://evil.example", Cookie: cookie(token) }), 403);
    assert.equal(await upgrade(watch, { Origin: "http://127.0.0.1:8999", Cookie: cookie(token) }), 403);
    assert.equal(await upgrade(watch, { Origin: "null", Cookie: cookie(token) }), 403);
    assert.equal(await upgrade(watch, { Host: `evil.example:${port}`, Origin: `http://evil.example:${port}`, Cookie: cookie(token) }), 403);
  });

  test("the cookie with this host's own origin is allowed; so is the header with no Origin (a script)", async () => {
    assert.equal(await upgrade(watch, { Origin: `http://${self}`, Cookie: cookie(token) }), "open");
    assert.equal(await upgrade(watch, { Origin: `http://${self}`, Cookie: `${cookie("clobbered")}; ${cookie(token)}` }), "open");
    assert.equal(await upgrade(watch, { "x-sova-token": token }), "open");
  });
});

/** A fresh start of server/auth.ts in its own process (the token is held for a process's life). */
function startAuth(env: Record<string, string> = {}): { token: string; file: string; inherited: string | null } {
  const code = 'import("./server/auth.ts").then((m) => console.log(JSON.stringify({ token: m.sovaToken(), file: m.tokenFile(), inherited: process.env.SOVA_TOKEN ?? null })))';
  const { SOVA_TOKEN: _drop, ...base } = process.env;
  const run = spawnSync(join(process.cwd(), "node_modules", ".bin", "tsx"), ["--eval", code], { env: { ...base, PI_CODING_AGENT_DIR: join(tmp, "agent"), ...env }, encoding: "utf8", timeout: 60_000 });
  assert.equal(run.status, 0, run.stderr);
  return JSON.parse(run.stdout.trim().split("\n").at(-1)!);
}

describe("the token file", () => {
  test("lives at <agent dir>/sova/auth-token, mode 0600, the same bytes on every read", () => {
    const file = tokenFile();
    assert.equal(file, join(tmp, "agent", "sova", "auth-token"));
    assert.equal(statSync(file).mode & 0o777, 0o600);
    const a = readFileSync(file);
    const b = readFileSync(file);
    assert.ok(a.equals(b));
    assert.equal(a.toString().trim(), token);
    assert.equal(sovaToken(), token, "stable while the file exists");
    assert.ok(token.length >= 32, "a real secret, not a placeholder");
    assert.equal(startAuth().token, token, "the next start reads the same token");
  });

  test("SOVA_TOKEN pins the token, and is taken out of the environment children inherit", () => {
    const pinned = "pinned-test-token-0123456789abcdefghij";
    const run = startAuth({ SOVA_TOKEN: pinned });
    assert.equal(run.token, pinned);
    assert.equal(run.inherited, null);
    assert.equal(readFileSync(tokenFile(), "utf8").trim(), token, "a pin never rewrites the file");
  });

  test("deleted, the next start mints a new one (0600) and the old one is revoked", async () => {
    rmSync(tokenFile());
    const fresh = startAuth();
    assert.equal(fresh.file, tokenFile());
    assert.notEqual(fresh.token, token);
    assert.equal(readFileSync(tokenFile(), "utf8").trim(), fresh.token);
    assert.equal(statSync(tokenFile()).mode & 0o777, 0o600);
    assert.equal(startAuth().token, fresh.token, "and keeps it");
  });
});
