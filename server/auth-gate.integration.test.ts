// Run: node scripts/run-tests.mjs server/auth-gate.integration.test.ts
// The main listener's token gate (§app.access/gate, §app.access/token, §app.access/unlock) over a
// real socket: the server on an ephemeral port against a throwaway PI_CODING_AGENT_DIR (removed
// after), every request sent with node:http or ws so the Host, Origin and Sec-Fetch-Site headers
// are exactly what a browser would send: a browser on this machine, the WebSocket upgrade, and the
// token file across starts (a child process each). The gate's decisions in process are
// auth-gate.test.ts.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { request, type IncomingHttpHeaders } from "node:http";
import { connect } from "node:net";
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

describe("a browser on this machine (a real loopback socket, headers as it sends them)", () => {
  const NAV = { "Sec-Fetch-Site": "same-origin", "Sec-Fetch-Mode": "navigate" };

  test("a same-origin navigation with no proxy header is answered and handed the cookie, no token asked", async () => {
    const res = await get(PROTECTED, NAV);
    assert.equal(res.status, 200);
    const set = res.headers["set-cookie"];
    assert.ok(set?.[0], "the answer sets the cookie");
    assert.match(set[0], /^sova_token_[0-9a-f]{8}=[^;]+; HttpOnly; SameSite=Strict/);
    const handed = set[0].split(";")[0]!;
    assert.equal((await get(PROTECTED, { Cookie: handed })).status, 200, "the handed cookie carries the token");
  });

  test("a proxy header — the tailnet reaching this listener through loopback — still gets a 401 and no cookie", async () => {
    const proxies: Array<Record<string, string>> = [{ "X-Forwarded-Host": "box.tail1234.ts.net" }, { "Tailscale-User-Login": "someone@example.com" }];
    for (const proxy of proxies) {
      const res = await get(PROTECTED, { ...NAV, ...proxy });
      assert.equal(res.status, 401, JSON.stringify(proxy));
      assert.equal(res.headers["set-cookie"], undefined);
    }
    // Cross-site and same-site stay refused, and a caller with no fetch metadata still needs the token.
    assert.equal((await get(PROTECTED, { "Sec-Fetch-Site": "cross-site", "Sec-Fetch-Mode": "navigate" })).status, 403);
    assert.equal((await get(PROTECTED, { "Sec-Fetch-Site": "same-site", "Sec-Fetch-Mode": "navigate" })).status, 403);
    assert.equal((await get(PROTECTED)).status, 401);
  });

  test("a typed address or bookmark (Sec-Fetch-Site: none) navigates straight in, cookie on the document; the boot fetch rides it", async () => {
    const res = await get(PROTECTED, { "Sec-Fetch-Site": "none", "Sec-Fetch-Mode": "navigate", "Sec-Fetch-Dest": "document" });
    assert.equal(res.status, 200);
    const set = res.headers["set-cookie"];
    assert.ok(set?.[0], "the cookie is on the document response");
    const handed = set[0].split(";")[0]!;
    const boot = await get(PROTECTED, { Cookie: handed, "Sec-Fetch-Mode": "same-origin" });
    assert.equal(boot.status, 200);
  });

  test("a none request that is not a navigation still needs the token; a proxy header over a none navigation still refuses", async () => {
    assert.equal((await get(PROTECTED, { "Sec-Fetch-Site": "none", "Sec-Fetch-Mode": "same-origin" })).status, 401);
    const res = await get(PROTECTED, { "Sec-Fetch-Site": "none", "Sec-Fetch-Mode": "navigate", "X-Forwarded-Host": "box.tail1234.ts.net" });
    assert.equal(res.status, 401);
    assert.equal(res.headers["set-cookie"], undefined);
  });
});
/** One request line sent exactly as written (no client-side URL parsing), on its own connection:
    the status and body of the answer. */
function raw(method: string, target: string, headers: Record<string, string> = {}): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, "127.0.0.1");
    let text = "";
    socket.setTimeout(8000, () => socket.destroy(new Error(`no answer within 8 s: ${method} ${target}`)));
    socket.on("data", (c) => (text += c));
    socket.on("error", reject);
    socket.on("close", () => {
      const status = Number(/^HTTP\/1\.1 (\d{3})/.exec(text)?.[1]);
      resolve({ status, body: text.slice(text.indexOf("\r\n\r\n") + 4) });
    });
    const lines = Object.entries({ Host: self, ...headers, Connection: "close" }).map(([k, v]) => `${k}: ${v}`);
    socket.write(`${method} ${target} HTTP/1.1\r\n${lines.join("\r\n")}\r\n\r\n`);
  });
}

describe("a dynamic route spelled so that only the server's URL parsing finds it (raw request lines)", () => {
  // Dot segments and an absolute-form target are resolved before any gate reads the path; a
  // client like fetch would have resolved them itself, so they are sent as raw bytes here.
  const SPELLINGS = [
    "/x/../%61pi/auth/token",
    "/%2e%2e/%61pi/auth/token",
    "/%61pi/./auth/token",
    "/./%61pi/sessions/dir",
    "//x/..//%61pi/auth/token",
    "/x/%2e%2e/API/auth/token",
    `http://${self}/%61pi/auth/token`,
  ];

  test("no token: refused, never the answer", async () => {
    for (const target of SPELLINGS) {
      for (const method of ["GET", "HEAD"]) {
        const res = await raw(method, target);
        assert.ok(res.status === 401 || res.status === 400 || res.status === 403, `${method} ${target} answered ${res.status}`);
        assert.equal(res.body.includes(token), false, `${method} ${target} never carries the token`);
      }
    }
  });

  test("not vacuous: with the token the same spelling reaches the route", async () => {
    assert.equal((await raw("GET", "/x/../%61pi/sessions/dir", { "x-sova-token": token })).status, 200);
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

  test("a rewritten loopback Host admits only the matching forwarded origin and still needs the token on WS", async () => {
    const forwarded = { Host: self, "X-Forwarded-Host": "laptop.tail1234.ts.net:8443", Origin: "https://laptop.tail1234.ts.net:8443" };
    for (const forwardedHost of ["laptop.tail1234.ts.net:8443", "laptop.tail1234.ts.net"]) {
      const headers = { ...forwarded, "X-Forwarded-Host": forwardedHost };
      assert.equal(await upgrade(watch, { ...headers, Cookie: cookie(token) }), "open");
      assert.equal(await upgrade(watch, headers), 401);
      assert.equal(await upgrade(watch, { ...headers, Cookie: cookie(token), Origin: "https://other.ts.net:8443" }), 403);
      assert.equal(await upgrade(watch, { ...headers, Cookie: cookie(token), Origin: "http://laptop.tail1234.ts.net:8443" }), 403);
    }
    for (const extra of [{ Origin: "https://evil.example" }, { "X-Forwarded-Host": "evil.example:8443" }, { Host: "evil.example" }, { Host: "localhost:5173" }]) {
      assert.equal(await upgrade(watch, { ...forwarded, Cookie: cookie(token), ...extra }), 403);
    }
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
  test("a damaged token file starts the server: shell 200, data and WS 401 with recovery instructions, no rewrite", () => {
    const damaged = join(tmp, "damaged-agent");
    const file = join(damaged, "sova", "auth-token");
    mkdirSync(join(damaged, "sessions", "live"), { recursive: true });
    mkdirSync(join(damaged, "sova"));
    writeFileSync(file, "short\n");
    const before = statSync(file);
    // A separate process exercises index.ts's startup, not just the in-memory gate. No real
    // state is copied. A shell fixture is the fallback when this checkout has no frontend build.
    const code = `
      import assert from "node:assert/strict";
      import { WebSocket } from "ws";
      try {
        const { app, server } = await import("./server/index.ts");
        app.get("/", (c) => c.html("<!doctype html><title>shell fixture</title>"));
        if (!server.listening) await new Promise((r) => server.once("listening", r));
        const origin = "http://127.0.0.1:" + server.address().port;
        const problem = ${JSON.stringify(`${file} does not hold a Sova token: delete it and restart to mint a new one`)};
        const expected = { error: problem, locked: true, hint: problem };
        const shell = await fetch(origin + "/");
        assert.equal(shell.status, 200);
        assert.match(await shell.text(), /<!doctype html>/i);
        assert.equal((await fetch(origin + "/api/health")).status, 200);
        for (const headers of [{}, { "x-sova-token": "x".repeat(43) }]) {
          const data = await fetch(origin + "/api/settings", { headers });
          assert.equal(data.status, 401);
          assert.deepEqual(await data.json(), expected);
        }
        const unlock = await fetch(origin + "/api/auth/unlock", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token: "" }) });
        assert.equal(unlock.status, 401);
        assert.deepEqual(await unlock.json(), expected);
        assert.equal(unlock.headers.get("set-cookie"), null);
        const refused = await new Promise((resolve, reject) => {
          const ws = new WebSocket(origin.replace("http:", "ws:") + "/ws/watch?path=nope");
          ws.on("open", () => { ws.terminate(); reject(new Error("damaged token admitted WS")); });
          ws.on("unexpected-response", (_req, res) => {
            let body = "";
            res.on("data", (chunk) => body += chunk);
            res.on("end", () => { resolve({ status: res.statusCode, body }); ws.terminate(); });
          });
          ws.on("error", reject);
        });
        assert.equal(refused.status, 401);
        assert.deepEqual(JSON.parse(refused.body), expected);
        server.close();
        server.closeAllConnections();
        console.log("damaged-token startup: shell=200 data=401 unlock=401 ws=401");
        process.exit(0);
      } catch (err) { console.error(err); process.exit(1); }
    `;
    const { SOVA_TOKEN: _drop, ...base } = process.env;
    const run = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", code], {
      env: { ...base, PI_CODING_AGENT_DIR: damaged, PORT: "0", SOVA_AUTH: "", SOVA_USAGE_POLL: "off", SOVA_PRICES_FETCH: "off" },
      encoding: "utf8", timeout: 60_000,
    });
    assert.equal(run.status, 0, `${run.error ?? ""}\n${run.stderr}\n${run.stdout}`);
    assert.match(run.stdout, /damaged-token startup: shell=200 data=401 unlock=401 ws=401/);
    assert.equal(run.stderr.split("does not hold a Sova token").length - 1, 1, "logged once, not on every refusal");
    assert.equal(readFileSync(file, "utf8"), "short\n");
    assert.equal(statSync(file).ino, before.ino);
    assert.equal(statSync(file).mtimeMs, before.mtimeMs);
  });

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
