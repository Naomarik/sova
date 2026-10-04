// Run: npx tsx --test server/auth.test.ts
// The gate (server/auth.ts) on a small Hono app wired as server/index.ts wires it, driven through
// app.fetch with the env a real socket gets ({ incoming }), the peer listener's ({ meshPeer }) or
// none (app.request). Uses a throwaway PI_CODING_AGENT_DIR; ~/.pi is never read or written.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import { isIP } from "node:net";
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

const { AUTH_COOKIE, SERVER_HEADER, authGate, initAuthToken, serverAuthEnabled, setAuthHosts, setAuthPort, sovaToken, tokenFile, unlock, upgradeAllowed, pair, revealToken, setLinkForTest } = await import("./auth");
const { mintCode, consumeCode } = await import("./auth-devices");
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
app.post("/api/auth/pair", pair);
app.get("/api/auth/token", revealToken);
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

  // Android (Termux) refuses hard links with EACCES: the mint falls back to an exclusive create.
  function withLinkRefused(before: (dest: string) => void, run: (dir: string) => void) {
    const dir = mkdtempSync(join(tmpdir(), "sova-auth-eacces-"));
    let calls = 0;
    setLinkForTest((_src, dest) => {
      calls++;
      before(dest);
      throw Object.assign(new Error(`EACCES: permission denied, link -> '${dest}'`), { code: "EACCES" });
    });
    try {
      process.env.PI_CODING_AGENT_DIR = dir;
      run(dir);
      assert.equal(calls, 1);
    } finally {
      setLinkForTest(null);
      rmSync(dir, { recursive: true, force: true });
    }
  }

  test("where hard links are refused with EACCES, the token is still minted once at 0600 and kept", () => {
    withLinkRefused(() => {}, (dir) => {
      const file = join(dir, "sova", "auth-token");
      const minted = sovaToken();
      assert.match(minted, /^[A-Za-z0-9_-]{43}$/);
      assert.equal(readFileSync(file, "utf8"), `${minted}\n`);
      assert.equal(statSync(file).mode & 0o777, 0o600);
      assert.deepEqual(readdirSync(join(dir, "sova")), ["auth-token"], "no temp file left behind");
      assert.equal(sovaToken(), minted);
      process.env.PI_CODING_AGENT_DIR = agentDir; // another install, then back: a re-read, not a re-mint
      sovaToken();
      process.env.PI_CODING_AGENT_DIR = dir;
      assert.equal(sovaToken(), minted);
      assert.equal(readFileSync(file, "utf8"), `${minted}\n`);
    });
  });

  test("where hard links are refused with EACCES, a rival start's token that landed first wins and is never overwritten", () => {
    const rival = "r".repeat(43);
    withLinkRefused((dest) => writeFileSync(dest, `${rival}\n`, { mode: 0o600, flag: "wx" }), (dir) => {
      const file = join(dir, "sova", "auth-token");
      assert.equal(sovaToken(), rival);
      assert.equal(readFileSync(file, "utf8"), `${rival}\n`);
      assert.deepEqual(readdirSync(join(dir, "sova")), ["auth-token"], "no temp file left behind");
      assert.equal(sovaToken(), rival);
    });
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

describe("a browser on this machine", () => {
  // What its socket and fetch metadata look like: loopback with no proxy header (isDirectLocal),
  // this process's own port in Host, and the browser's own navigation. The raw headers ride in
  // env.incoming, exactly as the real server's IncomingMessage carries them.
  const NAV = { "sec-fetch-site": "same-origin", "sec-fetch-mode": "navigate" };
  const local = (raw: Record<string, string> = {}) => ({ incoming: { socket: { remoteAddress: "127.0.0.1" }, headers: raw } });

  test("a same-origin navigation with no proxy header is answered and handed the cookie: the shell and a data route alike", async () => {
    for (const path of ["/", "/api/sessions"]) {
      const res = await ask(path, { headers: NAV }, local(NAV));
      assert.equal(res.status, 200, path);
      const set = res.headers.get("set-cookie") ?? "";
      assert.match(set, /^sova_token_[0-9a-f]{8}=[^;]+; HttpOnly; SameSite=Strict; Path=\//);
      assert.equal(res.headers.get("cache-control"), "no-store");
      // The cookie it was handed carries the install's token: it passes on the next request.
      const handed = set.split(";")[0]!;
      assert.equal((await ask("/api/sessions", { headers: { cookie: handed } })).status, 200);
      assert.equal(handed.startsWith(`${AUTH_COOKIE}=`), true);
      await res.text();
    }
  });

  test("a typed address or bookmark (Sec-Fetch-Site: none) navigates straight in: the document gets the cookie, the next fetch rides it", async () => {
    const TYPED = { "sec-fetch-site": "none", "sec-fetch-mode": "navigate", "sec-fetch-dest": "document" };
    const res = await ask("/", { headers: TYPED }, local(TYPED));
    assert.equal(res.status, 200);
    const set = res.headers.get("set-cookie");
    assert.match(set ?? "", /^sova_token_[0-9a-f]{8}=[^;]+; HttpOnly; SameSite=Strict/, "the cookie is on the document response");
    // The page's boot fetch — a same-origin, non-navigation request — passes on that cookie.
    const boot = await ask("/api/sessions", { headers: { "sec-fetch-mode": "same-origin", cookie: set!.split(";")[0]! } }, local());
    assert.equal(boot.status, 200);
    await res.text();
  });

  test("Sec-Fetch-Site: none that is NOT a navigation (Sec-Fetch-Mode: same-origin) still needs the token", async () => {
    const headers = { "sec-fetch-site": "none", "sec-fetch-mode": "same-origin" };
    const res = await ask("/api/sessions", { headers }, local(headers));
    assert.equal(res.status, 401);
    assert.equal(res.headers.get("set-cookie"), null);
  });

  test("a proxy header over a typed-address navigation still refuses: none + navigate through tailscale serve needs the token", async () => {
    const headers = { "sec-fetch-site": "none", "sec-fetch-mode": "navigate", "x-forwarded-host": "box.tail1234.ts.net" };
    const res = await ask("/api/sessions", { headers }, local(headers));
    assert.equal(res.status, 401);
    assert.equal(res.headers.get("set-cookie"), null);
  });

  test("a request carrying proxy headers — how the tailnet reaches this listener through loopback — still needs the token", async () => {
    const proxies: Array<Record<string, string>> = [{ "x-forwarded-host": "box.tail1234.ts.net" }, { "x-forwarded-proto": "https" }, { forwarded: "host=box.tail1234.ts.net" }, { "x-real-ip": "100.64.0.7" }, { via: "1.1 tail" }, { "tailscale-user-login": "someone@example.com" }];
    for (const proxy of proxies) {
      const headers = { ...NAV, ...proxy };
      const res = await ask("/api/sessions", { headers }, local(headers));
      assert.equal(res.status, 401, JSON.stringify(proxy));
      assert.equal(res.headers.get("set-cookie"), null);
    }
  });

  test("cross-site and same-site navigations stay 403, a foreign Host stays 403, and they never mint a cookie", async () => {
    for (const [headers, status] of [
      [{ ...NAV, "sec-fetch-site": "cross-site" }, 403],
      [{ ...NAV, "sec-fetch-site": "same-site" }, 403],
      [{ host: "evil.example", ...NAV }, 403],
    ] as Array<[Record<string, string>, number]>) {
      const res = await ask("/api/sessions", { headers }, local(headers));
      assert.equal(res.status, status);
      assert.equal(res.headers.get("set-cookie"), null);
    }
    // Same-site here means a page on another port of this host, cookie or not.
    assert.equal((await ask("/api/sessions", { headers: { ...NAV, "sec-fetch-site": "same-site", ...cookie() } }, local())).status, 403);
  });

  test("not this process's own port, no fetch metadata at all, or a socket upgrade: still the token", async () => {
    // Another port of this host answers only a caller that has the token.
    const otherPort = { host: "127.0.0.1:9999", ...NAV };
    const res = await ask("/api/sessions", { headers: otherPort }, local(otherPort));
    assert.equal(res.status, 401);
    assert.equal(res.headers.get("set-cookie"), null);
    // curl, a script, a local process: loopback with no Sec-Fetch headers at all.
    assert.equal((await ask("/api/sessions", {}, local())).status, 401);
    assert.equal((await ask("/api/sessions", {}, local())).headers.get("set-cookie"), null);
    // A WebSocket upgrade is never silently admitted (verdict is shared, silentLocal is not).
    const upgradeReq = (headers: Record<string, string>) => ({ url: "/ws/chat?path=x", headers: { host: HOST, ...headers } }) as unknown as IncomingMessage;
    assert.equal(upgradeAllowed(upgradeReq(NAV)), false);
    assert.equal(upgradeAllowed(upgradeReq({ "sec-fetch-site": "same-origin", "sec-fetch-mode": "websocket" })), false);
  });

  test("SOVA_AUTH=off with a proxy header behaves as before: answered, and no cookie invented", async () => {
    process.env.SOVA_AUTH = "off";
    try {
      const proxied = { ...NAV, "x-forwarded-host": "box.tail1234.ts.net" };
      const res = await ask("/api/sessions", { headers: proxied }, local(proxied));
      assert.equal(res.status, 200);
      assert.equal(res.headers.get("set-cookie"), null);
      // And the direct navigation now answers without the token as before; the cookie it sets is a nicety, not a gate.
      assert.equal((await ask("/api/sessions")).status, 200);
    } finally {
      delete process.env.SOVA_AUTH;
    }
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

describe("bringing a device in", () => {
  const store = () => join(process.env.PI_CODING_AGENT_DIR!, "sova", "auth-codes.json");
  const mint = (headers: Record<string, string> = cookie(), env: object = SOCKET) => ask("/api/auth/pair", { method: "POST", headers }, env);
  const exchange = (code: string) => ask("/api/auth/unlock", { method: "POST", body: JSON.stringify({ code }) });

  test("minting requires the token and refuses peer-listener and relayed calls", async () => {
    assert.equal((await mint({})).status, 401);
    assert.equal((await mint(cookie(), PEER)).status, 403);
    assert.equal((await mint({ ...cookie(), "x-sova-relayed": "1" })).status, 403);
    assert.equal((await mint({ "x-sova-token": sovaToken() })).status, 200);
  });

  test("minted codes are fresh, private at 0600, five-minute and never logged", async (t) => {
    const logs = ["log", "info", "warn", "error", "debug"].map((name) => t.mock.method(console, name as "log", () => {}));
    const before = Date.now();
    const first = await mint();
    assert.equal(first.status, 200);
    assert.equal(first.headers.get("cache-control"), "no-store");
    const a = await first.json() as { code: string; links: Array<{ label: string; url: string }>; expiresAt: string };
    const b = await (await mint()).json() as typeof a;
    assert.deepEqual(Object.keys(a).sort(), ["code", "expiresAt", "links"]);
    assert.match(a.code, /^[A-Za-z0-9_-]{43}$/);
    assert.notEqual(a.code, b.code, "a later response must never return the earlier code");
    assert.deepEqual(a.links, [{ label: "This machine only", url: `http://localhost:4800/#c=${a.code}` }]);
    assert.ok(Date.parse(a.expiresAt) >= before + 300_000);
    assert.ok(Date.parse(a.expiresAt) <= Date.now() + 300_000);
    assert.equal(statSync(store()).mode & 0o777, 0o600);
    const rows = JSON.parse(readFileSync(store(), "utf8")) as Array<{ code: string; at: string; expiresAt: string }>;
    const row = rows.find((r) => r.code === a.code)!;
    assert.equal(row.expiresAt, a.expiresAt, "the answer keeps the minted code's exact expiry");
    assert.equal(Date.parse(row.expiresAt) - Date.parse(row.at), 300_000);
    for (const log of logs) assert.equal(log.mock.callCount(), 0);
  });

  type PairAnswer = { code: string; expiresAt: string; links: Array<{ label: string; url: string }> };

  test("mesh off: pairing offers only the request's own origin, with loopback labelled honestly", async () => {
    for (const [host, env, origin, label] of [
      [HOST, SOCKET, "http://localhost:4800", "This machine only"],
      ["localhost:5173", SOCKET, "http://localhost:5173", "This machine only"],
      ["[::1]:4800", SOCKET, "http://localhost:4800", "This machine only"],
      ["phone.example.ts.net", SOCKET, "https://phone.example.ts.net", "This address"],
      [HOST, { incoming: { socket: { encrypted: true } } }, "https://localhost:4800", "This machine only"],
    ] as const) {
      const res = await mint({ ...cookie(), host, "x-forwarded-proto": "https", "x-forwarded-host": "ignored.ts.net" }, env);
      assert.equal(res.status, 200);
      const body = await res.json() as PairAnswer;
      assert.deepEqual(body.links, [{ label, url: `${origin}/#c=${body.code}` }]);
    }
  });

  test("a known HTTPS serve URL comes first, keeps its port and shares the code with loopback", async () => {
    setAuthHosts(() => ({ magicDns: "box.example.ts.net", own: ["https://box.example.ts.net:9443/", "https://door.example"] }));
    const body = await (await mint()).json() as PairAnswer;
    assert.deepEqual(body.links, [
      { label: "Phone · Tailscale", url: `https://box.example.ts.net:9443/#c=${body.code}` },
      { label: "This machine only", url: `http://localhost:4800/#c=${body.code}` },
    ]);
    assert.ok(!JSON.stringify(body.links).includes("door.example"), "the front door is not this host's serve URL");
  });

  test("MagicDNS alone supplies the default HTTPS serve port, never the HTTP URL or front door", async () => {
    for (const serve of [null, "http://box.example.ts.net:4800", "not a URL"]) {
      setAuthHosts(() => ({ magicDns: "box.example.ts.net.", own: [serve, "https://door.example"] }));
      const body = await (await mint()).json() as PairAnswer;
      assert.deepEqual(body.links, [
        { label: "Phone · Tailscale", url: `https://box.example.ts.net:8443/#c=${body.code}` },
        { label: "This machine only", url: `http://localhost:4800/#c=${body.code}` },
      ]);
    }
  });

  test("pairing deduplicates the serve and request origins while retaining HTTPS and its actual port", async () => {
    const host = "box.example.ts.net:9443";
    setAuthHosts(() => ({ own: [`https://${host}/`] }));
    const body = await (await mint({ ...cookie(), host, origin: `https://${host}` })).json() as PairAnswer;
    assert.deepEqual(body.links, [{ label: "Phone · Tailscale", url: `https://${host}/#c=${body.code}` }]);
    setAuthHosts(() => ({}));
    const direct = await (await mint({ ...cookie(), host, origin: `https://${host}` })).json() as PairAnswer;
    assert.deepEqual(direct.links, [{ label: "This address", url: `https://${host}/#c=${direct.code}` }]);
  });

  test("an IP literal never appears in a pairing link, from the request, serve URL or MagicDNS", async () => {
    for (const ip of ["127.0.0.1", "[::1]", "192.0.2.1", "[2001:db8::1]", "0x7f000001"]) {
      process.env.SOVA_ALLOWED_HOSTS = ip;
      setAuthHosts(() => ({ magicDns: ip, own: [`https://${ip}:9443/`] }));
      const res = await mint({ ...cookie(), host: `${ip}:4800` });
      assert.equal(res.status, 200);
      const body = await res.json() as PairAnswer;
      const loopback = ["127.0.0.1", "[::1]", "0x7f000001"].includes(ip);
      assert.deepEqual(body.links, loopback ? [{ label: "This machine only", url: `http://localhost:4800/#c=${body.code}` }] : []);
      for (const link of body.links) assert.equal(isIP(new URL(link.url).hostname.replace(/^\[|\]$/g, "")), 0);
    }
    setAuthHosts(() => ({ magicDns: "box.example.ts.net", own: ["https://192.0.2.1:9443"] }));
    const fallback = await (await mint()).json() as PairAnswer;
    assert.equal(fallback.links[0]?.url, `https://box.example.ts.net:8443/#c=${fallback.code}`);
  });

  test("a minted code unlocks exactly once, sets the same cookie and echoes neither credential", async () => {
    const { code } = await (await mint()).json() as { code: string };
    const res = await exchange(code);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true });
    const set = res.headers.get("set-cookie")!;
    assert.ok(set.startsWith(`${AUTH_COOKIE}=${sovaToken()};`));
    for (const attr of ["HttpOnly", "SameSite=Strict", "Path=/", "Max-Age=31536000"]) assert.ok(set.includes(attr));
    assert.equal(res.headers.get("cache-control"), "no-store");
    assert.equal((JSON.parse(readFileSync(store(), "utf8")) as Array<{ code: string }>).some((r) => r.code === code), false);
    const spent = await exchange(code);
    const bad = await exchange("bad-code");
    assert.equal(spent.status, 401);
    assert.deepEqual(await spent.json(), await bad.json());
    assert.equal(spent.headers.get("set-cookie"), null);
  });

  test("expired codes are refused at five minutes and pruned on the next write", async (t) => {
    const now = Date.now();
    const clock = t.mock.method(Date, "now", () => now);
    const row = mintCode();
    clock.mock.mockImplementation(() => now + 300_000);
    const expired = await exchange(row.code);
    assert.equal(expired.status, 401);
    assert.equal(expired.headers.get("set-cookie"), null);
    mintCode();
    assert.equal(readFileSync(store(), "utf8").includes(row.code), false);
  });

  test("the store is re-read, and missing, unreadable or partly malformed stores authorize nothing", () => {
    const row = mintCode();
    rmSync(store());
    assert.equal(consumeCode(row.code), false);
    mkdirSync(store()); // unreadable as a file even when tests run as root
    assert.equal(consumeCode(row.code), false);
    rmSync(store(), { recursive: true });
    for (const contents of ["not json", JSON.stringify([row, { code: "broken" }]), JSON.stringify([row, row])]) {
      writeFileSync(store(), contents);
      assert.equal(consumeCode(row.code), false);
    }
  });

  test("token recovery requires the cookie, refuses peers and relays, is no-store and never logged", async (t) => {
    const logs = ["log", "info", "warn", "error", "debug"].map((name) => t.mock.method(console, name as "log", () => {}));
    assert.equal((await ask("/api/auth/token")).status, 401);
    for (const [headers, env] of [[cookie(), PEER], [{ ...cookie(), "x-sova-relayed": "1" }, SOCKET]] as const) {
      const res = await ask("/api/auth/token", { headers }, env);
      assert.equal(res.status, 403);
      assert.ok(!(await res.text()).includes(sovaToken()));
    }
    const res = await ask("/api/auth/token", { headers: cookie() });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { token: sovaToken() });
    assert.equal(res.headers.get("cache-control"), "no-store");
    for (const log of logs) assert.equal(log.mock.callCount(), 0);
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
