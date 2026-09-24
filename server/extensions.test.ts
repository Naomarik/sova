// Run: pnpm exec tsx --test server/extensions.test.ts
// A throwaway PI_CODING_AGENT_DIR and SOVA_EXTENSIONS_FILE in the OS temp dir (~/.pi is never read
// or written), the server on an ephemeral port, and a throwaway loopback "extension backend" with
// a health route, an echo route and a WebSocket echo.
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

/** The fake backend: records nothing, answers everything from the request itself. */
let backend: Server;
let backendPort = 0;
/** A port nothing listens on (bound once, then released). */
let deadPort = 0;
let healthStatus = 200;
/** The close code each backend socket last saw from Sova's side. */
const backendCloses: number[] = [];

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

describe("manifest", () => {
  test("the location is overridable, and defaults under the state root", () => {
    assert.equal(extensionsFile(), process.env.SOVA_EXTENSIONS_FILE);
    const saved = process.env.SOVA_EXTENSIONS_FILE;
    delete process.env.SOVA_EXTENSIONS_FILE;
    try {
      assert.equal(extensionsFile(), join(tmp, "agent", "sova", "extensions.json"));
    } finally {
      process.env.SOVA_EXTENSIONS_FILE = saved;
    }
  });

  test("a valid entry keeps its fields; unknown keys are ignored", () => {
    const v = validateExtension({ ...stub(), extra: 1 });
    assert.ok("entry" in v);
    assert.deepEqual(v.entry, { ...stub() });
    const prefixed = validateExtension({ ...stub(), api: "https://localhost:8443/pre/fix" });
    assert.ok("entry" in prefixed);
  });

  test("a bad id, a relative dist or a non-loopback api drops the entry", () => {
    const bad: Record<string, unknown>[] = [
      { id: "a/b" },
      { id: "" },
      { id: ".." },
      { id: 7 },
      { dist: "relative/dist" },
      { dist: undefined },
      { api: "http://example.com:80" },
      { api: "http://10.0.0.1:4840" },
      { api: "http://127.0.0.1.nip.io:4840" },
      { api: "http://127.0.0.1" }, // no port
      { api: "http://127.0.0.1:4840/" }, // trailing slash
      { api: "ftp://127.0.0.1:4840" },
      { api: "http://u:p@127.0.0.1:4840" },
      { api: "http://127.0.0.1:4840?x=1" },
      { api: 4840 },
    ];
    for (const patch of bad) {
      const v = validateExtension({ ...stub(), ...patch });
      assert.ok("error" in v, JSON.stringify(patch));
    }
    assert.ok("error" in validateExtension(null));
    assert.ok("error" in validateExtension([stub()]));
  });

  test("a missing title falls back to the id; an icon that isn't a plain name is dropped", () => {
    const v = validateExtension({ ...stub(), title: undefined, icon: "x);background:url(evil" });
    assert.ok("entry" in v);
    assert.equal(v.entry.title, "stub");
    assert.equal(v.entry.icon, undefined);
  });

  test("a missing, malformed or wrong-version file lists nothing; a later duplicate id is dropped", () => {
    rmSync(process.env.SOVA_EXTENSIONS_FILE!, { force: true });
    assert.deepEqual(readExtensions(), []);
    writeFileSync(process.env.SOVA_EXTENSIONS_FILE!, "{not json");
    assert.deepEqual(readExtensions(), []);
    writeManifest([stub()], 2);
    assert.deepEqual(readExtensions(), []);
    writeManifest([stub(), { ...stub(), title: "Second" }, { ...stub(), id: "bad id" }, { ...stub(), id: "other" }]);
    assert.deepEqual(
      readExtensions().map((e) => [e.id, e.title]),
      [
        ["stub", "Stub"],
        ["other", "Stub"],
      ],
    );
  });
});

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

  test("no manifest: an empty list", async () => {
    rmSync(process.env.SOVA_EXTENSIONS_FILE!, { force: true });
    assert.deepEqual(await (await app.request("/api/extensions")).json(), []);
  });
});

describe("static UI", () => {
  beforeEach(() => writeManifest([stub()]));

  test("index.html at /ext/<id>/, uncached; assets as files", async () => {
    const html = await app.request("/ext/stub/");
    assert.equal(html.status, 200);
    assert.match(html.headers.get("content-type") ?? "", /^text\/html/);
    assert.equal(html.headers.get("cache-control"), "no-cache");
    assert.match(await html.text(), /<title>stub<\/title>/);
    const js = await app.request("/ext/stub/assets/app.js");
    assert.equal(js.status, 200);
    assert.match(js.headers.get("content-type") ?? "", /javascript/);
    assert.equal(await js.text(), "console.log('stub')");
  });

  test("a dotless path is a client route (index.html); a missing file is a 404, not the shell", async () => {
    const route = await app.request("/ext/stub/rows/42");
    assert.equal(route.status, 200);
    assert.match(await route.text(), /<title>stub<\/title>/);
    const missing = await app.request("/ext/stub/assets/missing.js");
    assert.equal(missing.status, 404);
    assert.doesNotMatch(await missing.text(), /<title>/);
  });

  test("nothing outside dist is reachable", async () => {
    for (const p of ["/ext/stub/..%2fsecret.txt", "/ext/stub/%2e%2e/secret.txt", "/ext/stub/assets/..%2f..%2fsecret.txt"]) {
      const res = await app.request(p);
      assert.equal(res.status, 404, p);
      assert.notEqual(await res.text(), "outside dist", p);
    }
  });

  test("/ext/<id> redirects to the slash form; an unknown id is a 404 on every surface", async () => {
    const res = await app.request("/ext/stub");
    assert.equal(res.status, 302);
    assert.equal(res.headers.get("location"), "/ext/stub/");
    const page = await app.request("/ext/nope/");
    assert.equal(page.status, 404);
    assert.equal(await page.text(), "Unknown extension");
    for (const p of ["/ext/nope/api/x", "/ext/nope/ws/x"]) {
      const r = await app.request(p);
      assert.equal(r.status, 404, p);
      assert.deepEqual(await r.json(), { error: "Unknown extension" });
    }
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
  const open = (path: string, protocols?: string[]) => new WebSocket(`ws://127.0.0.1:${sovaPort()}${path}`, protocols);
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

describe("/design", () => {
  test("tokens.css and base.css are served as CSS, uncached; nothing else is", async () => {
    for (const name of ["tokens.css", "base.css"]) {
      const res = await app.request(`/design/${name}`);
      assert.equal(res.status, 200, name);
      assert.match(res.headers.get("content-type") ?? "", /^text\/css/);
      assert.equal(res.headers.get("cache-control"), "no-cache");
      assert.ok((await res.text()).length > 100);
    }
    assert.equal((await app.request("/design/align-viewer.css")).status, 404);
    assert.equal((await app.request("/design/../package.json")).status, 404);
  });
});
