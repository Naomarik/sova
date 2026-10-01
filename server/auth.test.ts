// Run: npx tsx --test server/auth.test.ts
// The gate (server/auth.ts) on a small Hono app wired as server/index.ts wires it, driven through
// app.fetch with the env a real socket gets ({ incoming }), the peer listener's ({ meshPeer }) or
// none (app.request). Uses a throwaway PI_CODING_AGENT_DIR; ~/.pi is never read or written.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, describe, test } from "node:test";
import { Hono } from "hono";

const agentDir = mkdtempSync(join(tmpdir(), "sova-auth-test-"));
process.env.PI_CODING_AGENT_DIR = agentDir; // before auth.ts computes its cookie name
delete process.env.SOVA_TOKEN;
delete process.env.SOVA_AUTH;
delete process.env.HOST;
delete process.env.SOVA_ALLOWED_HOSTS;

const { AUTH_COOKIE, SERVER_HEADER, authGate, initAuthToken, serverAuthEnabled, setAuthHosts, setAuthPort, sovaToken, tokenFile, unlock, upgradeAllowed } = await import("./auth");
setAuthPort(4800);

after(() => rmSync(agentDir, { recursive: true, force: true }));
afterEach(() => {
  delete process.env.SOVA_AUTH;
  delete process.env.HOST;
  delete process.env.SOVA_ALLOWED_HOSTS;
  delete process.env.SOVA_ALLOWED_ORIGINS;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  setAuthHosts(() => ({}));
});

const app = new Hono();
app.use("*", async (c, next) => {
  const refused = authGate(c);
  if (refused) return refused;
  await next();
  c.res.headers.set(SERVER_HEADER, "sova");
});
app.get("/api/health", (c) => c.json({ ok: true }));
app.post("/api/auth/unlock", unlock);
app.get("/api/auth/status", (c) => c.json({ ok: true }));
app.get("/api/sessions", (c) => c.json([]));
app.post("/api/sessions", (c) => c.json({ made: true }));
app.get("/explain/:id", (c) => c.text("page"));
app.get("*", (c) => c.text("<!doctype html>shell"));

const SOCKET = { incoming: {} };
const PEER = { incoming: {}, meshPeer: { id: "peer" } };
const HOST = "127.0.0.1:4800";

function ask(path: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}, env: object | undefined = SOCKET) {
  const headers = { host: HOST, ...init.headers };
  return app.fetch(new Request(`http://${headers.host}${path}`, { method: init.method ?? "GET", headers, ...(init.body ? { body: init.body } : {}) }), env);
}
const cookie = (t = sovaToken()) => ({ cookie: `${AUTH_COOKIE}=${t}` });

describe("the token", () => {
  test("is minted once at 0600 under <agent dir>/sova and never rewritten", () => {
    const t = sovaToken();
    assert.equal(tokenFile(), join(agentDir, "sova", "auth-token"));
    assert.match(t, /^[A-Za-z0-9_-]{43}$/); // 32 bytes, base64url
    assert.equal(readFileSync(tokenFile(), "utf8").trim(), t);
    assert.equal(statSync(tokenFile()).mode & 0o777, 0o600);
    assert.equal(sovaToken(), t);
  });

  test("an existing file wins over a mint", () => {
    const other = mkdtempSync(join(tmpdir(), "sova-auth-other-"));
    try {
      mkdirSync(join(other, "sova"));
      const theirs = "x".repeat(43);
      writeFileSync(join(other, "sova", "auth-token"), `${theirs}\n`, { mode: 0o600 });
      process.env.PI_CODING_AGENT_DIR = other;
      assert.equal(sovaToken(), theirs);
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });

  test("a damaged token logs once, keeps the shell open and refuses every credential with recovery instructions", async (t) => {
    const log = t.mock.method(console, "error", () => {});
    for (const contents of ["", "short\n"]) {
      const damaged = mkdtempSync(join(tmpdir(), "sova-auth-damaged-"));
      try {
        mkdirSync(join(damaged, "sova"));
        const file = join(damaged, "sova", "auth-token");
        writeFileSync(file, contents);
        const before = statSync(file);
        process.env.PI_CODING_AGENT_DIR = damaged;
        const problem = `${file} does not hold a Sova token: delete it and restart to mint a new one`;
        const calls = log.mock.callCount();
        assert.equal(initAuthToken().token, null, "initialization does not throw or invent a token");
        assert.equal(initAuthToken().problem, problem);
        assert.throws(() => sovaToken(), /does not hold a Sova token/, "trusted callers never get a placeholder");
        assert.equal((await ask("/")).status, 200);
        assert.equal((await ask("/api/health")).status, 200);
        const candidates: Array<Record<string, string>> = [{}, cookie(""), cookie("x".repeat(43)), { "x-sova-token": "" }, { "x-sova-token": "x".repeat(43) }];
        for (const headers of candidates) {
          const res = await ask("/api/sessions", { headers });
          assert.equal(res.status, 401);
          assert.deepEqual(await res.json(), { error: problem, locked: true, hint: problem });
        }
        for (const token of [undefined, "", "x".repeat(43)]) {
          const res = await ask("/api/auth/unlock", { method: "POST", body: JSON.stringify({ token }) });
          assert.equal(res.status, 401);
          assert.deepEqual(await res.json(), { error: problem, locked: true, hint: problem });
          assert.equal(res.headers.get("set-cookie"), null);
        }
        assert.equal(log.mock.callCount(), calls + 1, "one loud log, not one per request");
        assert.deepEqual(log.mock.calls.at(-1)?.arguments, [`[auth] ${problem}`]);
        assert.equal(readFileSync(file, "utf8"), contents);
        assert.equal(statSync(file).ino, before.ino);
        assert.equal(statSync(file).mtimeMs, before.mtimeMs);
      } finally {
        rmSync(damaged, { recursive: true, force: true });
      }
    }
  });

  test("the cookie name is per install", () => {
    assert.match(AUTH_COOKIE, /^sova_token_[0-9a-f]{8}$/);
  });
});

describe("the gate", () => {
  test("no token: 401, JSON with a reload hint, marked as Sova", async () => {
    const res = await ask("/api/sessions");
    assert.equal(res.status, 401);
    const body = (await res.json()) as { locked?: boolean; hint?: string };
    assert.equal(body.locked, true);
    assert.match(body.hint ?? "", /reload/);
    assert.equal(res.headers.get(SERVER_HEADER), "sova");
    assert.ok(!JSON.stringify(body).includes(sovaToken()));
  });

  test("a wrong token: 401, whichever way it comes", async () => {
    assert.equal((await ask("/api/sessions", { headers: cookie("nope") })).status, 401);
    assert.equal((await ask("/api/sessions", { headers: { "x-sova-token": "nope" } })).status, 401);
    // x-sova-token is the one header: a bearer, even the right one, is no credential here
    assert.equal((await ask("/api/sessions", { headers: { authorization: `Bearer ${sovaToken()}` } })).status, 401);
  });

  test("the right token: the cookie or the header", async () => {
    assert.equal((await ask("/api/sessions", { headers: { ...cookie(), "sec-fetch-site": "same-origin", origin: `http://${HOST}` } })).status, 200);
    assert.equal((await ask("/api/sessions", { headers: { "x-sova-token": sovaToken() } })).status, 200);
  });

  test("any duplicate cookie that matches: a planted one beside the real one doesn't lock out", async () => {
    const res = await ask("/api/sessions", { headers: { cookie: `${AUTH_COOKIE}=planted; other=1; ${AUTH_COOKIE}=${sovaToken()}` } });
    assert.equal(res.status, 200);
  });

  test("a same-site page on another 127.0.0.1 port: 403 even with the cookie", async () => {
    const headers = { ...cookie(), origin: "http://127.0.0.1:9999", "sec-fetch-site": "same-site" };
    assert.equal((await ask("/api/sessions", { method: "POST", headers, body: "{}" })).status, 403);
    // without fetch metadata (an older browser), the Origin alone refuses it
    assert.equal((await ask("/api/sessions", { method: "POST", headers: { ...cookie(), origin: "http://127.0.0.1:9999" }, body: "{}" })).status, 403);
    // an img/script load: no Origin, but Sec-Fetch-Site says same-site
    assert.equal((await ask("/api/sessions", { headers: { ...cookie(), "sec-fetch-site": "same-site" } })).status, 403);
    assert.equal((await ask("/api/sessions", { headers: { ...cookie(), "sec-fetch-site": "cross-site" } })).status, 403);
    assert.equal((await ask("/api/sessions", { headers: { ...cookie(), origin: "null" } })).status, 403);
  });

  test("a foreign Host (a rebound name): 403 even with the token, the shell included", async () => {
    assert.equal((await ask("/api/sessions", { headers: { ...cookie(), host: "evil.example:4800" } })).status, 403);
    assert.equal((await ask("/", { headers: { host: "evil.example:4800" } })).status, 403);
    // a forwarded-host mark doesn't admit a Host
    assert.equal((await ask("/api/sessions", { headers: { ...cookie(), host: "evil.example", "x-forwarded-host": "127.0.0.1:4800", "x-sova-relayed": "1" } })).status, 403);
  });

  test("hosts this app is reachable at: loopback names on any port, SOVA_ALLOWED_HOSTS, registered names", async () => {
    for (const host of ["localhost:5173", "[::1]:4800", "127.0.0.1"]) assert.equal((await ask("/api/sessions", { headers: { ...cookie(), host } })).status, 200, host);
    process.env.SOVA_ALLOWED_HOSTS = "sova.lan, other.lan:8080";
    assert.equal((await ask("/api/sessions", { headers: { ...cookie(), host: "sova.lan" } })).status, 200);
    assert.equal((await ask("/api/sessions", { headers: { ...cookie(), host: "other.lan" } })).status, 200);
    setAuthHosts(() => ({ magicDns: "box.tail1234.ts.net.", own: ["https://door.example/"] }));
    const viaServe = { ...cookie(), host: "box.tail1234.ts.net", origin: "https://box.tail1234.ts.net", "sec-fetch-site": "same-origin" };
    assert.equal((await ask("/api/sessions", { method: "POST", headers: viaServe, body: "{}" })).status, 200);
  });

  // The operator's checks (DECISION-front-door-origin.md): an exact allowed-origin set.
  const MESH = { magicDns: "box.tail1234.ts.net.", own: ["https://door.example", null], peers: ["https://peer.example:8443"] };
  const post = (headers: Record<string, string>) => ask("/api/sessions", { method: "POST", headers: { ...cookie(), "sec-fetch-site": "same-origin", ...headers }, body: "{}" });

  test("check 1: a tailnet browser (Origin https://<ts.net>:8443) passes", async () => {
    setAuthHosts(() => MESH);
    assert.equal((await post({ host: "box.tail1234.ts.net:8443", origin: "https://box.tail1234.ts.net:8443" })).status, 200);
    // the mesh's own MagicDNS name on any port, whatever the Host
    assert.equal((await post({ host: "box.tail1234.ts.net", origin: "https://box.tail1234.ts.net" })).status, 200);
    assert.equal((await post({ host: "box.tail1234.ts.net", origin: "https://box.tail1234.ts.net:8443" })).status, 200);
  });

  test("tailscale serve with the mesh off: a ts.net Host and exactly its own https origin pass", async () => {
    // no mesh names, no SOVA_ALLOWED_HOSTS, no SOVA_ALLOWED_ORIGINS (afterEach clears them)
    const host = "phone-box.tail9999.ts.net:8443";
    assert.equal((await post({ host, origin: "https://phone-box.tail9999.ts.net:8443" })).status, 200); // (a)
    assert.equal((await post({ host, origin: "https://evil.example" })).status, 403); // (b)
    assert.equal((await post({ host, origin: "https://other.ts.net:8443" })).status, 403); // (c) another tailnet's page
    assert.equal((await post({ host, origin: "https://phone-box.tail9999.ts.net" })).status, 403); // another port
    assert.equal((await post({ host, origin: "http://phone-box.tail9999.ts.net:8443" })).status, 403); // not https
    // the unlock screen loads, and a ts.net socket passes the same way
    assert.equal((await ask("/", { headers: { host } })).status, 200);
    assert.equal((await ask("/api/sessions", { headers: { host } })).status, 401);
    // a rebound name is still not one of ours
    assert.equal((await post({ host: "evil.example:8443", origin: "https://evil.example:8443" })).status, 403);
  });

  test("a loopback Host with an allowed forwarded Host and matching Origin passes, still requiring the token", async () => {
    const forwarded = { "x-forwarded-host": "phone-box.tail9999.ts.net:8443", origin: "https://phone-box.tail9999.ts.net:8443" };
    for (const host of [HOST, "localhost:4800", "[::1]:4800"]) {
      assert.equal((await post({ host, ...forwarded })).status, 200, host);
      assert.equal((await ask("/api/sessions", { method: "POST", headers: { host, ...forwarded } })).status, 401, "the forward is not a credential");
    }
  });

  test("a loopback Host with a portless forwarded ts.net name admits its HTTPS Origin on any port", async () => {
    for (const host of [HOST, "localhost:4800", "[::1]:4800"]) {
      for (const forwarded of ["phone-box.tail9999.ts.net", "PHONE-BOX.tail9999.ts.net.:9443"]) {
        for (const origin of ["https://phone-box.tail9999.ts.net:8443", "https://PHONE-BOX.tail9999.ts.net.:8443", "https://phone-box.tail9999.ts.net"]) {
          const headers = { host, "x-forwarded-host": forwarded, origin };
          assert.equal((await post(headers)).status, 200, `${host}, ${forwarded}, ${origin}`);
          assert.equal((await ask("/api/sessions", { method: "POST", headers })).status, 401, "still requires the token");
        }
      }
    }
  });

  test("a portless forwarded ts.net name never admits another hostname or HTTP", async () => {
    for (const origin of ["https://other.ts.net:8443", "https://evil.example", "http://phone-box.tail9999.ts.net:8443"]) {
      assert.equal((await post({ "x-forwarded-host": "phone-box.tail9999.ts.net", origin })).status, 403, origin);
    }
  });

  test("the forwarded-name exception never widens direct Host or non-ts.net origin matches", async () => {
    const origin = "https://phone-box.tail9999.ts.net:8443";
    assert.equal((await post({ host: "phone-box.tail9999.ts.net", origin })).status, 403, "direct Host keeps the exact port rule");
    for (const host of [HOST, "evil.example", "localhost:5173"]) {
      assert.equal((await post({ host, origin })).status, 403, "no forwarded header");
      if (host !== HOST) assert.equal((await post({ host, origin, "x-forwarded-host": "phone-box.tail9999.ts.net" })).status, 403, host);
    }
    process.env.SOVA_ALLOWED_HOSTS = "door.example";
    process.env.SOVA_ALLOWED_ORIGINS = "https://door.example";
    assert.equal((await post({ "x-forwarded-host": "door.example", origin: "https://door.example" })).status, 200);
    assert.equal((await post({ "x-forwarded-host": "door.example", origin: "https://door.example:8443" })).status, 403, "non-ts.net stays exact");
  });

  test("a loopback Host with an allowed forwarded Host but a foreign Origin is 403", async () => {
    for (const origin of ["https://evil.example", "https://other.ts.net:8443", "http://phone-box.tail9999.ts.net:8443"]) {
      assert.equal((await post({ "x-forwarded-host": "phone-box.tail9999.ts.net:8443", origin })).status, 403, origin);
    }
  });

  test("an unallowed or malformed forwarded Host cannot admit an Origin", async () => {
    for (const forwarded of ["evil.example:8443", "phone-box.tail9999.ts.net:8443, other.ts.net", "https://phone-box.tail9999.ts.net:8443", "user@phone-box.tail9999.ts.net:8443", "phone-box.tail9999.ts.net:8443/path", "phone-box.tail9999.ts.net:99999"]) {
      assert.equal((await post({ "x-forwarded-host": forwarded, origin: "https://phone-box.tail9999.ts.net:8443" })).status, 403, forwarded);
    }
    assert.equal((await post({ "x-forwarded-host": "evil.example:8443", origin: "https://evil.example:8443" })).status, 403);
    assert.equal((await post({ "x-forwarded-host": "evil.example:8443", origin: `http://${HOST}` })).status, 200, "ignored, not a new refusal");
  });

  test("a forwarded Host never admits a foreign real Host or applies beyond this loopback port", async () => {
    const forwarded = { "x-forwarded-host": "phone-box.tail9999.ts.net:8443", origin: "https://phone-box.tail9999.ts.net:8443" };
    for (const host of ["evil.example:4800", "localhost:5173", "127.0.0.1", "[::1]:4801", "other.ts.net:8443"]) {
      assert.equal((await post({ host, ...forwarded })).status, 403, host);
    }
    assert.equal((await post({ origin: forwarded.origin })).status, 403, "absent forwarded header changes nothing");
  });

  test("check 2: through the front door (Caddy rewrites Host to this host's name) passes, unconfigured", async () => {
    setAuthHosts(() => MESH);
    assert.equal((await post({ host: "box.tail1234.ts.net", origin: "https://door.example" })).status, 200);
    // exact origin, never host-only
    assert.equal((await post({ host: "box.tail1234.ts.net", origin: "https://door.example:8443" })).status, 403);
    assert.equal((await post({ host: "box.tail1234.ts.net", origin: "http://door.example" })).status, 403);
    // a peer's serve URL, and SOVA_ALLOWED_ORIGINS
    assert.equal((await post({ host: "box.tail1234.ts.net", origin: "https://peer.example:8443" })).status, 200);
    process.env.SOVA_ALLOWED_ORIGINS = "http://localhost:5173, https://x.example";
    assert.equal((await post({ host: "localhost:5173", origin: "http://localhost:5173" })).status, 200);
    // a forwarded header admits nothing
    assert.equal((await post({ host: "box.tail1234.ts.net", origin: "https://evil.example", "x-forwarded-host": "evil.example" })).status, 403);
  });

  test("check 3: the demo page on 127.0.0.1:8999 is refused even with a valid cookie", async () => {
    assert.equal((await post({ origin: "http://127.0.0.1:8999", "sec-fetch-site": "same-site" })).status, 403);
    assert.equal((await ask("/api/sessions", { headers: { ...cookie(), "sec-fetch-site": "same-site" } })).status, 403);
    // this process's own port on a loopback name is the app itself
    assert.equal((await post({ origin: "http://localhost:4800" })).status, 200);
    assert.equal((await post({ origin: "http://127.0.0.1:4801" })).status, 403);
  });

  test("check 4: a cross-site document navigation gets the shell and nothing else", async () => {
    const nav = { "sec-fetch-site": "cross-site", "sec-fetch-mode": "navigate", "sec-fetch-dest": "document" };
    const shell = await ask("/s/some-session", { headers: nav });
    assert.equal(shell.status, 200);
    assert.match(await shell.text(), /shell/);
    for (const path of ["/api/sessions", "/api/health", "/explain/abc", "/ext/x/"]) assert.equal((await ask(path, { headers: { ...cookie(), ...nav } })).status, 403, path);
    // not a navigation: a cross-site script or image load of the shell is refused too
    assert.equal((await ask("/", { headers: { "sec-fetch-site": "cross-site", "sec-fetch-mode": "no-cors" } })).status, 403);
  });

  test("open without the token: the static shell, the health check, the unlock route", async () => {
    const shell = await ask("/s/some-session");
    assert.equal(shell.status, 200);
    assert.equal(shell.headers.get(SERVER_HEADER), "sova");
    assert.equal((await ask("/api/health")).status, 200);
    assert.equal((await ask("/api/health", { method: "POST" })).status, 401);
    assert.equal((await ask("/explain/abc")).status, 401);
    assert.equal((await ask("/ext/x/")).status, 401);
    assert.equal((await ask("/api/sessions", { method: "HEAD" })).status, 401);
  });

  test("GET /api/auth/status is gated: 401 locked without the cookie, 200 with it", async () => {
    const locked = await ask("/api/auth/status");
    assert.equal(locked.status, 401);
    assert.equal(((await locked.json()) as { locked?: boolean }).locked, true);
    assert.equal((await ask("/api/auth/status", { headers: cookie() })).status, 200);
  });

  test("a peer-listener call is never asked", async () => {
    assert.equal((await ask("/api/sessions", { method: "POST", body: "{}" }, PEER)).status, 200);
  });

  test("an in-process call (app.request, no socket) is never asked", async () => {
    assert.equal((await app.request("/api/sessions", { method: "POST", body: "{}" })).status, 200);
  });

  test("SOVA_AUTH=off drops the token on a loopback bind only, and never the Host rule", async () => {
    process.env.SOVA_AUTH = "off";
    assert.equal(serverAuthEnabled(), false);
    assert.equal((await ask("/api/sessions")).status, 200);
    assert.equal((await ask("/api/sessions", { headers: { host: "evil.example" } })).status, 403);
    process.env.HOST = "0.0.0.0";
    assert.equal(serverAuthEnabled(), true);
    assert.equal((await ask("/api/sessions")).status, 401);
  });
});

describe("unlocking", () => {
  test("the right token sets the install's cookie, never echoing it in the body", async () => {
    const res = await ask("/api/auth/unlock", { method: "POST", headers: { "content-type": "application/json", origin: `http://${HOST}` }, body: JSON.stringify({ token: sovaToken() }) });
    assert.equal(res.status, 200);
    const set = res.headers.get("set-cookie") ?? "";
    assert.ok(set.startsWith(`${AUTH_COOKIE}=${sovaToken()};`));
    for (const attr of ["HttpOnly", "SameSite=Strict", "Path=/", "Max-Age=31536000"]) assert.ok(set.includes(attr), attr);
    assert.ok(!set.includes("Secure"));
    assert.ok(!(await res.text()).includes(sovaToken()));
  });

  test("Secure when the real Host is served over https, never from X-Forwarded-Proto", async () => {
    const unlockAt = (headers: Record<string, string>) => ask("/api/auth/unlock", { method: "POST", headers, body: JSON.stringify({ token: sovaToken() }) });
    const secure = async (headers: Record<string, string>) => ((await unlockAt(headers)).headers.get("set-cookie") ?? "").includes("; Secure");
    assert.equal(await secure({ "x-forwarded-proto": "https" }), false);
    setAuthHosts(() => ({ magicDns: "box.tail1234.ts.net", own: ["https://door.example/", "http://plain.example"] }));
    assert.equal(await secure({ host: "box.tail1234.ts.net" }), true); // tailscale serve
    assert.equal(await secure({ host: "door.example" }), true);
    assert.equal(await secure({ host: "box.tail1234.ts.net:4800" }), false); // reached directly over http
    assert.equal(await secure({ host: "plain.example" }), false);
  });

  test("a wrong or missing token: 401, no cookie", async () => {
    for (const body of [JSON.stringify({ token: "nope" }), "{}", "not json"]) {
      const res = await ask("/api/auth/unlock", { method: "POST", body });
      assert.equal(res.status, 401);
      assert.equal(res.headers.get("set-cookie"), null);
    }
  });

  test("another site can't unlock (or plant a token) in the person's browser", async () => {
    const res = await ask("/api/auth/unlock", { method: "POST", headers: { origin: "http://127.0.0.1:9999", "sec-fetch-site": "same-site" }, body: JSON.stringify({ token: sovaToken() }) });
    assert.equal(res.status, 403);
  });
});

describe("socket upgrades", () => {
  const upgrade = (headers: Record<string, string | undefined>, url = "/ws/chat?path=x") => ({ url, headers: { host: HOST, ...headers } }) as unknown as IncomingMessage;

  test("need the token", () => {
    assert.equal(upgradeAllowed(upgrade({})), false);
    assert.equal(upgradeAllowed(upgrade(cookie())), true);
    assert.equal(upgradeAllowed(upgrade({ "x-sova-token": sovaToken() })), true);
  });

  test("refuse another origin, a same-site port and a foreign Host, even with the token", () => {
    assert.equal(upgradeAllowed(upgrade({ ...cookie(), origin: `http://${HOST}` })), true);
    assert.equal(upgradeAllowed(upgrade({ ...cookie(), origin: "http://127.0.0.1:9999" })), false);
    assert.equal(upgradeAllowed(upgrade({ ...cookie(), origin: "https://evil.example" })), false);
    assert.equal(upgradeAllowed(upgrade({ ...cookie(), host: "evil.example" })), false);
  });

  test("the same origin set: the tailnet, the front door, and never the demo page", () => {
    setAuthHosts(() => ({ magicDns: "box.tail1234.ts.net", own: ["https://door.example"] }));
    assert.equal(upgradeAllowed(upgrade({ ...cookie(), host: "box.tail1234.ts.net:8443", origin: "https://box.tail1234.ts.net:8443" })), true);
    assert.equal(upgradeAllowed(upgrade({ ...cookie(), host: "box.tail1234.ts.net", origin: "https://door.example" })), true);
    assert.equal(upgradeAllowed(upgrade({ ...cookie(), origin: "http://127.0.0.1:8999" })), false);
    setAuthHosts(() => ({}));
    assert.equal(upgradeAllowed(upgrade({ ...cookie(), host: "box.tail1234.ts.net:8443", origin: "https://box.tail1234.ts.net:8443" })), true);
    assert.equal(upgradeAllowed(upgrade({ ...cookie(), host: "box.tail1234.ts.net:8443", origin: "https://other.ts.net:8443" })), false);
    // a navigation header never opens a socket
    assert.equal(upgradeAllowed(upgrade({ ...cookie(), origin: "https://evil.example", "sec-fetch-mode": "navigate" }, "/")), false);
  });

  test("forwarded Host on this loopback port follows the same origin and token rules for upgrades", () => {
    const forwarded = { "x-forwarded-host": "phone-box.tail9999.ts.net:8443", origin: "https://phone-box.tail9999.ts.net:8443" };
    for (const host of [HOST, "localhost:4800", "[::1]:4800"]) {
      assert.equal(upgradeAllowed(upgrade({ ...cookie(), host, ...forwarded })), true, host);
      assert.equal(upgradeAllowed(upgrade({ host, ...forwarded })), false, "no token");
    }
    for (const override of [{ origin: "https://evil.example" }, { "x-forwarded-host": "evil.example" }, { host: "evil.example" }, { host: "localhost:5173" }]) {
      assert.equal(upgradeAllowed(upgrade({ ...cookie(), ...forwarded, ...override })), false);
    }
  });

  test("an extension's and a peer's socket path are asked too", () => {
    assert.equal(upgradeAllowed(upgrade({}, "/ext/x/ws/live")), false);
    assert.equal(upgradeAllowed(upgrade({}, "/peer/p/ws/chat")), false);
    assert.equal(upgradeAllowed(upgrade({}, "/")), false);
  });
});
