// Run: node scripts/run-tests.mjs server/extensions.integration.test.ts
// Extensions against a real backend: health checks, the HTTP proxy and the WS proxy. A throwaway
// PI_CODING_AGENT_DIR and SOVA_EXTENSIONS_FILE in the OS temp dir (~/.pi is never read or written),
// the server on an ephemeral port, and a throwaway loopback "extension backend" with a health route,
// an echo route and a WebSocket echo. The manifest, static UI and /design are extensions.test.ts.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, describe, test } from "node:test";
import { WebSocket, WebSocketServer } from "ws";
import type { ExtensionInfo } from "../shared/protocol";

const tmp = mkdtempSync(join(tmpdir(), "sova-ext-test-"));
process.env.PI_CODING_AGENT_DIR = join(tmp, "agent");
process.env.SOVA_EXTENSIONS_FILE = join(tmp, "extensions.json");
process.env.PORT = "0";
mkdirSync(join(tmp, "agent", "sessions", "live"), { recursive: true });

const dist = join(tmp, "dist");
mkdirSync(join(dist, "assets"), { recursive: true });
writeFileSync(join(dist, "index.html"), "<!doctype html><title>stub</title>");
writeFileSync(join(dist, "assets", "app.js"), "console.log('stub')");
writeFileSync(join(tmp, "secret.txt"), "outside dist");

const { app, server } = await import("./index");
const { clearHealthCache, extensionsFile, readExtensions, validateExtension } = await import("./extensions");
const { AUTH_COOKIE, sovaToken } = await import("./auth");

/** The fake backend: records nothing, answers everything from the request itself. */
let backend: Server;
let backendPort = 0;
/** A port nothing listens on (bound once, then released). */
let deadPort = 0;
let healthStatus = 200;
/** The close code each backend socket last saw from Sova's side. */
const backendCloses: number[] = [];
/** The headers of the last upgrade the backend accepted. */
let backendUpgrade: IncomingMessage["headers"] = {};

async function listen(s: Server): Promise<number> {
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  return (s.address() as { port: number }).port;
}

before(async () => {
  backend = createServer(async (req: IncomingMessage, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    const path = url.pathname.replace(/^\/pre/, "");
    if (path === "/api/health") {
      res.writeHead(healthStatus, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: healthStatus === 200 }));
      return;
    }
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    res.writeHead(path === "/api/teapot" ? 418 : 200, { "Content-Type": "application/json", "X-Echo": "yes" });
    res.end(JSON.stringify({ method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString() }));
  });
  const wss = new WebSocketServer({ server: backend });
  wss.on("connection", (ws, req) => {
    backendUpgrade = req.headers;
    ws.on("close", (code) => backendCloses.push(code));
    ws.send(`hello ${req.url} ${req.headers["x-sova-origin"] ?? ""}`);
    ws.on("message", (data, isBinary) => {
      const text = data.toString();
      if (!isBinary && text.startsWith("close:")) ws.close(Number(text.slice(6)), "bye");
      else ws.send(data, { binary: isBinary });
    });
  });
  backendPort = await listen(backend);
  const probe = createServer();
  deadPort = await listen(probe);
  await new Promise((r) => probe.close(r));
  if (!server.listening) await new Promise((r) => server.once("listening", r));
});

after(async () => {
  server.close();
  backend.closeAllConnections();
  await new Promise((r) => backend.close(r));
  rmSync(tmp, { recursive: true, force: true });
});

const sovaPort = () => (server.address() as { port: number }).port;

function writeManifest(extensions: unknown[], version: unknown = 1): void {
  writeFileSync(process.env.SOVA_EXTENSIONS_FILE!, JSON.stringify({ version, extensions }));
}

const stub = () => ({ id: "stub", title: "Stub", description: "A test double", icon: "branch", dist, api: `http://127.0.0.1:${backendPort}` });

describe("GET /api/extensions", () => {
  beforeEach(() => {
    clearHealthCache();
    healthStatus = 200;
  });

  test("lists each valid entry with its health, in manifest order", async () => {
    writeManifest([stub(), { ...stub(), id: "gone", title: "Gone", description: undefined, icon: undefined, api: `http://127.0.0.1:${deadPort}` }]);
    const res = await app.request("/api/extensions");
    assert.equal(res.status, 200);
    const list = (await res.json()) as ExtensionInfo[];
    assert.deepEqual(list[0], { id: "stub", title: "Stub", description: "A test double", icon: "branch", status: "ok" });
    assert.equal(list[1]!.id, "gone");
    assert.equal(list[1]!.status, "down");
    assert.equal(list[1]!.error, "connection refused");
    assert.ok(!("dist" in list[0]!) && !("api" in list[0]!), "the list never carries dist or api");
  });

  test("a non-2xx health answer is down, and the answer is cached", async () => {
    writeManifest([stub()]);
    healthStatus = 503;
    const first = (await (await app.request("/api/extensions")).json()) as ExtensionInfo[];
    assert.deepEqual([first[0]!.status, first[0]!.error], ["down", "health check answered HTTP 503"]);
    healthStatus = 200;
    const cached = (await (await app.request("/api/extensions")).json()) as ExtensionInfo[];
    assert.equal(cached[0]!.status, "down", "within 10 s the cached answer stands");
    clearHealthCache();
    const fresh = (await (await app.request("/api/extensions")).json()) as ExtensionInfo[];
    assert.equal(fresh[0]!.status, "ok");
  });

});

describe("HTTP proxy", () => {
  test("method, path, query, body and headers reach the backend; its answer comes back unchanged", async () => {
    writeManifest([stub()]);
    const res = await app.request("/ext/stub/api/echo/a%20b?x=1&y=2", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Custom": "kept", Host: "sova.test:5186" },
      body: JSON.stringify({ hello: "world" }),
    });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("x-echo"), "yes");
    const echo = (await res.json()) as { method: string; url: string; headers: Record<string, string>; body: string };
    assert.equal(echo.method, "POST");
    assert.equal(echo.url, "/api/echo/a%20b?x=1&y=2");
    assert.equal(echo.body, '{"hello":"world"}');
    assert.equal(echo.headers["x-custom"], "kept");
    assert.equal(echo.headers.host, `127.0.0.1:${backendPort}`);
    assert.equal(echo.headers["x-forwarded-host"], "sova.test:5186");
    assert.equal(echo.headers["x-sova-origin"], `http://127.0.0.1:${sovaPort()}`);
  });

  test("Sova's credential never reaches the backend; the extension's own cookie and Authorization do", async () => {
    writeManifest([stub()]);
    const res = await app.request("/ext/stub/api/echo", {
      headers: { Cookie: `ext_session=1; ${AUTH_COOKIE}=${sovaToken()}; sova_token_00000000=other-install`, "x-sova-token": sovaToken(), Authorization: "Bearer ext-own" },
    });
    const echo = (await res.json()) as { headers: Record<string, string> };
    assert.equal(echo.headers.cookie, "ext_session=1", "every install's Sova cookie is dropped, the rest kept");
    assert.equal(echo.headers["x-sova-token"], undefined);
    assert.equal(echo.headers.authorization, "Bearer ext-own");
    assert.equal(JSON.stringify(echo.headers).includes(sovaToken()), false);
    // Over the real socket, with Sova's token as a bearer: the bearer goes too, the other cookies stay in order.
    const real = await fetch(`http://127.0.0.1:${sovaPort()}/ext/stub/api/echo`, {
      headers: { Cookie: `a=1; ${AUTH_COOKIE}=${sovaToken()}; b=2`, "x-sova-token": sovaToken(), Authorization: `Bearer ${sovaToken()}` },
    });
    assert.equal(real.status, 200);
    const seen = ((await real.json()) as { headers: Record<string, string> }).headers;
    assert.equal(seen.cookie, "a=1; b=2");
    assert.equal(seen["x-sova-token"], undefined);
    assert.equal(seen.authorization, undefined);
  });

  test("a backend status passes through; an api prefix is kept", async () => {
    writeManifest([{ ...stub(), api: `http://127.0.0.1:${backendPort}/pre` }]);
    const res = await app.request("/ext/stub/api/teapot");
    assert.equal(res.status, 418);
    assert.equal(((await res.json()) as { url: string }).url, "/pre/api/teapot");
  });

  test("a backend that isn't there is a 502 naming the extension", async () => {
    writeManifest([{ ...stub(), api: `http://127.0.0.1:${deadPort}` }]);
    const res = await app.request("/ext/stub/api/rows");
    assert.equal(res.status, 502);
    assert.deepEqual(await res.json(), { error: "extension down", id: "stub" });
  });
});

describe("WS proxy", () => {
  // The upgrade passes the main listener's gate as a browser's would: with the cookie.
  const open = (path: string, protocols?: string[]) =>
    new WebSocket(`ws://127.0.0.1:${sovaPort()}${path}`, protocols, { headers: { Cookie: `${AUTH_COOKIE}=${sovaToken()}` } });
  const next = (ws: WebSocket) =>
    new Promise<[string, boolean]>((r) => ws.once("message", (d: Buffer, isBinary: boolean) => r([d.toString(), isBinary])));

  test("frames pass both ways, text and binary; the path, query and origin reach the backend", async () => {
    writeManifest([stub()]);
    const ws = open("/ext/stub/ws/jobs/7?since=3");
    const hello = await next(ws);
    assert.deepEqual(hello, [`hello /ws/jobs/7?since=3 http://127.0.0.1:${sovaPort()}`, false]);
    ws.send("ping");
    assert.deepEqual(await next(ws), ["ping", false]);
    ws.send(Buffer.from("bin"), { binary: true });
    assert.deepEqual(await next(ws), ["bin", true]);
    ws.close(4002, "done");
    await new Promise((r) => ws.once("close", r));
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(backendCloses.at(-1), 4002, "the browser's close code reaches the backend");
  });

  test("Sova's credential never reaches the backend's socket", async () => {
    writeManifest([stub()]);
    const ws = new WebSocket(`ws://127.0.0.1:${sovaPort()}/ext/stub/ws/x`, {
      headers: { Cookie: `ext_session=1; ${AUTH_COOKIE}=${sovaToken()}`, "x-sova-token": sovaToken() },
    });
    await next(ws);
    ws.close();
    assert.equal(backendUpgrade.cookie?.includes(AUTH_COOKIE) ?? false, false);
    assert.equal(backendUpgrade["x-sova-token"], undefined);
    assert.equal(JSON.stringify(backendUpgrade).includes(sovaToken()), false);
  });

  test("the backend's close code and reason reach the browser", async () => {
    writeManifest([{ ...stub(), api: `http://127.0.0.1:${backendPort}/pre` }]);
    const ws = open("/ext/stub/ws/x");
    assert.match((await next(ws))[0], /^hello \/pre\/ws\/x /);
    ws.send("close:4001");
    const [code, reason] = await new Promise<[number, string]>((r) => ws.once("close", (c, why) => r([c, why.toString()])));
    assert.deepEqual([code, reason], [4001, "bye"]);
  });

  async function refused(path: string): Promise<[number, string]> {
    const ws = open(path);
    return new Promise((resolve, reject) => {
      ws.once("open", () => reject(new Error("upgraded")));
      ws.once("error", () => {});
      ws.once("unexpected-response", (_req, res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => resolve([res.statusCode ?? 0, Buffer.concat(chunks).toString()]));
      });
    });
  }

  test("a backend that isn't there refuses the upgrade with a 502; an unknown id with a 404", async () => {
    writeManifest([{ ...stub(), api: `http://127.0.0.1:${deadPort}` }]);
    assert.deepEqual(await refused("/ext/stub/ws/x"), [502, JSON.stringify({ error: "extension down", id: "stub" })]);
    assert.deepEqual(await refused("/ext/nope/ws/x"), [404, JSON.stringify({ error: "Unknown extension" })]);
  });
});
