// Run: pnpm test:int -- server/extension-keys.integration.test.ts
// An extension backend with its own key, end to end (§app.extensions/backend-key): the whole server on
// an ephemeral port in a throwaway PI_CODING_AGENT_DIR, a stand-in backend, and `node scripts/sova.mjs`
// as a real process with the key as its SOVA_TOKEN. The key appears; the backend runs its own command
// and Sova's, hears a rename on /ws/events, and every call is recorded as the extension's; declared
// actions follow the manifest without a restart; a bad save changes no key; an uninstall or a deleted
// key file closes the sockets the key opened.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, test } from "node:test";
import { WebSocket } from "ws";

for (const k of Object.keys(process.env)) if (/_API_KEY$|_AUTH_TOKEN$/.test(k)) delete process.env[k];
const tmp = realpathSync(mkdtempSync(join(tmpdir(), "sova-ext-keys-int-")));
const agentDir = join(tmp, "agent");
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.SOVA_EXTENSIONS_FILE = join(tmp, "extensions.json");
process.env.PORT = "0";
delete process.env.SOVA_CALLER_KEY;
delete process.env.SOVA_TOKEN;
mkdirSync(join(agentDir, "sessions", "live"), { recursive: true });
const work = join(tmp, "work");
mkdirSync(work);
const dist = join(tmp, "dist");
mkdirSync(dist);
writeFileSync(join(dist, "index.html"), "<!doctype html><title>stub</title>");

const { server } = await import("./index");
const { sovaToken } = await import("./auth");
const { extensionKeys, SYNC_MS } = await import("./extension-keys");
const { canonicalPath } = await import("./paths");

let lastHeaders: IncomingHttpHeaders | null = null;
let lastUrl = "";
let backend: Server;
let api = "";
let base = "";
let host = "";

const writeManifest = (entries: object[]) => writeFileSync(process.env.SOVA_EXTENSIONS_FILE!, JSON.stringify({ version: 1, extensions: entries }));
const entry = (commands: object[] = [{ name: "ping", label: "Ping" }]) => ({ id: "x", dist, api, commands });
const keyFile = () => extensionKeys.fileOf("x");
const readKey = () => readFileSync(keyFile(), "utf8").trim();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function eventually<T>(fn: () => T | Promise<T>, ok: (v: T) => boolean, ms = SYNC_MS * 2 + 2000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (ok(v) || Date.now() > end) return v;
    await sleep(100);
  }
}

before(async () => {
  backend = createServer(async (req, res) => {
    for await (const _ of req) void _;
    if (req.url === "/api/health") return void res.writeHead(200, { "Content-Type": "application/json" }).end("{}");
    lastHeaders = req.headers;
    lastUrl = `${req.method} ${req.url}`;
    res.writeHead(200, { "Content-Type": "application/json" }).end('{"pong":true}');
  });
  await new Promise<void>((r) => backend.listen(0, "127.0.0.1", r));
  api = `http://127.0.0.1:${(backend.address() as { port: number }).port}`;
  writeManifest([entry()]);
  if (!server.listening) await new Promise((r) => server.once("listening", r));
  host = `127.0.0.1:${(server.address() as { port: number }).port}`;
  base = `http://${host}`;
});
after(async () => {
  server.close();
  backend.close();
  rmSync(tmp, { recursive: true, force: true });
});

const CLI = fileURLToPath(new URL("../scripts/sova.mjs", import.meta.url));
function cli(args: string[], token: string, extra: Record<string, string> = {}): Promise<{ code: number; out: string; err: string }> {
  return new Promise((done) => {
    const p = spawn("node", [CLI, ...args], { env: { PATH: process.env.PATH ?? "", HOME: tmp, PI_CODING_AGENT_DIR: join(tmp, "elsewhere"), SOVA_TOKEN: token, SOVA_URL: base, ...extra }, cwd: work });
    let out = "";
    let err = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    p.on("close", (code) => done({ code: code ?? -1, out, err }));
  });
}
const commandIds = async (key: string) => ((await (await fetch(`${base}/api/commands`, { headers: { "x-sova-token": key } })).json()) as { commands: { id: string }[] }).commands.map((c) => c.id);

let n = 0;
function newSession(said: string): string {
  const cwd = join(tmp, "proj");
  mkdirSync(cwd, { recursive: true });
  const dir = join(agentDir, "sessions", "--proj--");
  mkdirSync(dir, { recursive: true });
  const id = `01a0dd00-0000-7000-8000-0000000003${String(++n).padStart(2, "0")}`;
  const file = join(dir, `2026-10-19T00-00-${String(n).padStart(2, "0")}-000Z_${id}.jsonl`);
  const lines = [
    { type: "session", version: 3, id, timestamp: "2026-10-19T00:00:00.000Z", cwd },
    { type: "message", id: "u-1", parentId: null, timestamp: "2026-10-19T00:00:01.000Z", message: { role: "user", content: [{ type: "text", text: said }], timestamp: 0 } },
  ];
  writeFileSync(file, lines.map((l) => `${JSON.stringify(l)}\n`).join(""));
  return canonicalPath(file);
}
function open(path: string, key: string): Promise<{ ws: WebSocket; frames: Array<{ type: string; name?: string; path?: string; title?: string }>; closed: Promise<void> }> {
  const ws = new WebSocket(`ws://${host}${path}`, { headers: { "x-sova-token": key } });
  const frames: Array<{ type: string; name?: string; path?: string; title?: string }> = [];
  ws.on("message", (d) => frames.push(JSON.parse(String(d))));
  const closed = new Promise<void>((r) => ws.once("close", () => r()));
  return new Promise((res, rej) => {
    ws.once("open", () => res({ ws, frames, closed }));
    ws.once("error", rej);
    ws.once("unexpected-response", (_q, r) => rej(new Error(`upgrade answered ${r.statusCode}`)));
  });
}

test("the key appears for the backend, runs its command and Sova's, hears a rename, and is recorded as the extension", async () => {
  const key = await eventually(() => (existsSync(keyFile()) ? readKey() : ""), (k) => !!k);
  assert.match(key, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(key, sovaToken());

  // Its own action, through the proxy: the backend gets the call, never the key.
  // `run` finds an extension's command in the manifest itself, as a backend on this machine has it.
  const run = await cli(["run", "ext.x.ping"], key, { SOVA_EXTENSIONS_FILE: process.env.SOVA_EXTENSIONS_FILE! });
  assert.equal(run.code, 0, run.err);
  assert.equal(lastUrl, "POST /api/commands/ping");
  assert.equal(lastHeaders?.["x-sova-token"], undefined);
  assert.ok(!JSON.stringify(lastHeaders).includes(key));

  // Sova's own, and the events: the operator renames, the backend hears it.
  const path = newSession("for the backend to watch");
  const ev = await open("/ws/events", key);
  await sleep(300);
  const r = await fetch(`${base}/api/sessions/title`, { method: "POST", headers: { "x-sova-token": sovaToken(), "content-type": "application/json" }, body: JSON.stringify({ path, title: "Renamed for x" }) });
  assert.equal(r.status, 200, await r.text());
  const heard = await eventually(() => ev.frames.find((f) => f.type === "event" && f.name === "session.renamed" && f.path === path), (f) => !!f, 20_000);
  assert.equal(heard?.title, "Renamed for x");
  ev.ws.close();
  const list = await cli(["run", "session.list"], key);
  assert.equal(list.code, 0, list.err);

  // The record: every one of those is the extension's.
  const audit = await cli(["run", "audit.list", "--caller", "ext:x", "--limit", "100"], key);
  assert.equal(audit.code, 0, audit.err);
  const rows = (JSON.parse(audit.out) as { rows: Array<{ caller: string; command?: string; route: string; status: number }> }).rows;
  assert.ok(rows.some((x) => x.command === "ext.x.ping" && x.status === 200), audit.out);
  assert.ok(rows.some((x) => x.route === "/ws/events" && x.status === 101), audit.out);
  assert.ok(rows.some((x) => x.command === "session.list"), audit.out);
  assert.ok(rows.every((x) => x.caller === "ext:x"));
  assert.ok(!audit.out.includes(key));
});

test("declared actions follow the manifest without a restart, in GET /api/commands and sova list", async () => {
  const key = readKey();
  writeManifest([entry([{ name: "ping", label: "Ping" }, { name: "pong", label: "Pong" }])]);
  assert.ok((await commandIds(key)).includes("ext.x.pong"));
  const listed = await cli(["list", "--json"], key);
  assert.equal(listed.code, 0, listed.err);
  assert.ok((JSON.parse(listed.out) as { id: string }[]).some((c) => c.id === "ext.x.pong"));
  writeManifest([entry([{ name: "ping", label: "Ping" }])]);
  assert.ok(!(await commandIds(key)).includes("ext.x.pong"));
  const gone = await cli(["list", "--json"], key);
  assert.ok(!(JSON.parse(gone.out) as { id: string }[]).some((c) => c.id === "ext.x.pong"));
  assert.equal(readKey(), key, "an edit that keeps the entry keeps its key");
});

test("a bad save refuses the key while it lasts, closes nothing, and changes no key", async () => {
  const key = readKey();
  const ev = await open("/ws/events", key);
  writeFileSync(process.env.SOVA_EXTENSIONS_FILE!, '{"version": 1, "extensions": [');
  assert.equal((await fetch(`${base}/api/commands`, { headers: { "x-sova-token": key } })).status, 401);
  await sleep(SYNC_MS * 2 + 500); // two syncs over the bad file
  assert.equal(ev.ws.readyState, WebSocket.OPEN, "the backend's socket stays open");
  writeManifest([entry()]);
  assert.equal(readKey(), key);
  assert.equal((await fetch(`${base}/api/commands`, { headers: { "x-sova-token": key } })).status, 200);
  ev.ws.close();
});

test("an uninstall, or a deleted key file, closes every socket the key opened within three syncs", async () => {
  const key = readKey();
  const path = newSession("a chat the key holds");
  const ev = await open("/ws/events", key);
  const chat = await open(`/ws/chat?path=${encodeURIComponent(path)}&force=1`, key);
  const t0 = Date.now();
  writeManifest([]);
  // Gone from two syncs in a row: the first may come up to one interval after the edit.
  await Promise.race([Promise.all([ev.closed, chat.closed]), sleep(SYNC_MS * 3 + 1000).then(() => assert.fail("not closed within three syncs"))]);
  assert.ok(Date.now() - t0 <= SYNC_MS * 3 + 1000);
  assert.equal(existsSync(keyFile()), false, "the key file went with the entry");

  // Installed again: a new key, never the old one. Deleting its file rotates it and closes its sockets.
  writeManifest([entry()]);
  const fresh = await eventually(() => (existsSync(keyFile()) ? readKey() : ""), (k) => !!k);
  assert.notEqual(fresh, key);
  assert.equal((await fetch(`${base}/api/commands`, { headers: { "x-sova-token": key } })).status, 401);
  const ev2 = await open("/ws/events", fresh);
  rmSync(keyFile());
  assert.equal((await fetch(`${base}/api/commands`, { headers: { "x-sova-token": fresh } })).status, 401, "refused at once");
  await Promise.race([ev2.closed, sleep(SYNC_MS * 2 + 1000).then(() => assert.fail("rotation left the socket open"))]);
  const rotated = await eventually(() => (existsSync(keyFile()) ? readKey() : ""), (k) => !!k);
  assert.notEqual(rotated, fresh);
  assert.equal((await fetch(`${base}/api/commands`, { headers: { "x-sova-token": rotated } })).status, 200);
});
