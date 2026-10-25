// Run: node scripts/run-tests.mjs server/events.integration.test.ts
// Sova's event stream end to end (§app/events): the whole server on an ephemeral port in a throwaway
// PI_CODING_AGENT_DIR (~/.pi is never read or written), a local stand-in model (server/stream-stub.ts,
// through pi's real openai-completions provider) so a real turn runs in a real chat process, and raw
// WebSocket clients. Also: the token gate, resume across a disconnect, a renamed session, the client
// frame cap, the peer gate and the share listener refusing the path.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { WebSocket } from "ws";
import type { EventsServerFrame } from "../shared/events";
import { startStreamStub, stubModelsJson } from "./stream-stub";

for (const k of Object.keys(process.env)) if (/_API_KEY$|_AUTH_TOKEN$/.test(k)) delete process.env[k];

const tmp = realpathSync(mkdtempSync(join(tmpdir(), "sova-events-int-")));
process.on("exit", () => rmSync(tmp, { recursive: true, force: true }));
const agentDir = join(tmp, "agent");
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.PORT = "0";
mkdirSync(join(agentDir, "sessions", "live"), { recursive: true });
const dist = join(tmp, "dist");
mkdirSync(dist);
writeFileSync(join(dist, "index.html"), "<!doctype html><title>stub</title>");
const stub = await startStreamStub({ payload: "letters", perDelta: 16, limit: 64, tool: "no_such_tool" });
writeFileSync(join(agentDir, "models.json"), JSON.stringify(stubModelsJson(stub.port)));

const { server } = await import("./index");
const { sovaToken, TOKEN_HEADER } = await import("./auth");
const { canonicalPath } = await import("./paths");

let host = "";
const headers = () => ({ [TOKEN_HEADER]: sovaToken() });

before(async () => {
  if (!server.listening) await new Promise((r) => server.once("listening", r));
  host = `127.0.0.1:${(server.address() as { port: number }).port}`;
});
after(async () => {
  server.close();
  await stub.close();
});

/** An events client that keeps every frame with the time it arrived. */
function eventsClient(query = "") {
  const ws = new WebSocket(`ws://${host}/ws/events${query}`, { headers: headers() });
  const frames: { f: EventsServerFrame; t: number }[] = [];
  const waiters: (() => void)[] = [];
  ws.on("message", (d) => {
    frames.push({ f: JSON.parse(String(d)), t: Date.now() });
    for (const w of waiters.splice(0)) w();
  });
  const until = async (pred: (f: EventsServerFrame) => boolean, ms = 20_000): Promise<{ f: EventsServerFrame; t: number }> => {
    const end = Date.now() + ms;
    for (;;) {
      const hit = frames.find((x) => pred(x.f));
      if (hit) return hit;
      if (Date.now() > end) throw new Error(`timed out; got ${JSON.stringify(frames.map((x) => x.f))}`);
      await new Promise<void>((r) => {
        waiters.push(r);
        setTimeout(r, 100);
      });
    }
  };
  const opened = new Promise<void>((res, rej) => {
    ws.once("open", () => res());
    ws.once("error", rej);
  });
  return { ws, frames, until, opened };
}

const isEvent = (name: string, path?: string) => (f: EventsServerFrame) => f.type === "event" && f.name === name && (!path || ("path" in f && f.path === path));

let n = 0;
/** A session file; `said` adds a user message (the list leaves out a session with none). */
function newSession(said?: string): { path: string; id: string } {
  const cwd = join(tmp, "proj");
  mkdirSync(cwd, { recursive: true });
  const dir = join(agentDir, "sessions", "--proj--");
  mkdirSync(dir, { recursive: true });
  const id = `01a0dd00-0000-7000-8000-0000000002${String(++n).padStart(2, "0")}`;
  const file = join(dir, `2026-10-18T00-00-${String(n).padStart(2, "0")}-000Z_${id}.jsonl`);
  const lines: unknown[] = [{ type: "session", version: 3, id, timestamp: "2026-10-18T00:00:00.000Z", cwd }];
  if (said) lines.push({ type: "message", id: "u-1", parentId: null, timestamp: "2026-10-18T00:00:01.000Z", message: { role: "user", content: [{ type: "text", text: said }], timestamp: 0 } });
  writeFileSync(file, lines.map((l) => `${JSON.stringify(l)}\n`).join(""));
  return { path: canonicalPath(file), id };
}

test("no token: the upgrade is refused, as /ws/watch's is", async () => {
  const ws = new WebSocket(`ws://${host}/ws/events`);
  const status = await new Promise<number>((res) => {
    ws.on("unexpected-response", (_req, r) => res(r.statusCode ?? 0));
    ws.on("open", () => res(101));
    ws.on("error", () => {});
  });
  assert.equal(status, 401);
});

test("a real turn in a chat Sova runs: turn.started then turn.ended, hosted, the end within 1 s of the run settling", async () => {
  const ev = eventsClient();
  await ev.opened;
  const hello = await ev.until((f) => f.type === "hello");
  assert.equal(hello.f.type, "hello");
  const s = newSession();
  const chat = new WebSocket(`ws://${host}/ws/chat?path=${encodeURIComponent(s.path)}&force=1`, { headers: headers() });
  // A wire-1 SDK event frame is named by its event's own type (agent_start, agent_settled, …).
  const chatFrames: { m: { type: string }; t: number }[] = [];
  chat.on("message", (d) => {
    const m = JSON.parse(String(d));
    chatFrames.push({ m: m.type === "event" && m.event?.type ? { ...m, type: m.event.type } : m, t: Date.now() });
  });
  await new Promise<void>((r, j) => (chat.once("open", () => r()), chat.once("error", j)));
  const until = async (type: string) => {
    const end = Date.now() + 60_000;
    for (;;) {
      const hit = chatFrames.find((x) => x.m.type === type);
      if (hit) return hit;
      if (Date.now() > end) throw new Error(`no ${type}; got ${chatFrames.map((x) => (x.m.type === "error" ? JSON.stringify(x.m) : x.m.type)).join(",")}`);
      await new Promise((r) => setTimeout(r, 50));
    }
  };
  await until("hello");
  chat.send(JSON.stringify({ type: "set_model", ref: "stub/runaway" }));
  await until("model");
  stub.reset({ payload: "letters", perDelta: 16, limit: 64, tool: "no_such_tool" });
  chat.send(JSON.stringify({ type: "prompt", text: "go", clientId: "c1" }));
  const settled = await until("agent_settled");
  const started = await ev.until(isEvent("turn.started", s.path));
  const ended = await ev.until(isEvent("turn.ended", s.path));
  assert.equal("source" in started.f && started.f.source, "hosted");
  assert.equal("source" in ended.f && ended.f.source, "hosted");
  assert.ok(started.f.type === "event" && ended.f.type === "event" && started.f.seq < ended.f.seq);
  assert.ok(Math.abs(ended.t - settled.t) <= 1000, `turn.ended ${ended.t - settled.t} ms from the settle frame`);
  await new Promise((r) => setTimeout(r, 6000)); // a feed re-diff or two: no observed duplicate
  const turns = ev.frames.filter((x) => x.f.type === "event" && x.f.name.startsWith("turn.") && "path" in x.f && x.f.path === s.path);
  assert.deepEqual(
    turns.map((x) => x.f.type === "event" && "source" in x.f && `${x.f.name}:${x.f.source}`),
    ["turn.started:hosted", "turn.ended:hosted"],
  );
  chat.close();
  ev.ws.close();
});

test("a title set: one session.renamed (observed); a resume after a disconnect gets exactly what it missed", async () => {
  const s = newSession("to be renamed");
  const ev = eventsClient();
  await ev.opened;
  const hello = (await ev.until((f) => f.type === "hello")).f as EventsServerFrame & { type: "hello" };
  // Let the feed's first read (the baseline) see the new session.
  await ev.until(isEvent("session.created", s.path)).catch(() => null);
  const res = await fetch(`http://${host}/api/sessions/title`, { method: "POST", headers: { ...headers(), "content-type": "application/json" }, body: JSON.stringify({ path: s.path, title: "Renamed once" }) });
  assert.equal(res.status, 200, await res.text());
  const renamed = await ev.until(isEvent("session.renamed", s.path));
  assert.ok(renamed.f.type === "event" && renamed.f.name === "session.renamed" && renamed.f.title === "Renamed once");
  const last = renamed.f.type === "event" ? renamed.f.seq : 0;
  ev.ws.close();
  await new Promise((r) => setTimeout(r, 200));

  // While no one listens (within the linger), a second rename.
  const res2 = await fetch(`http://${host}/api/sessions/title`, { method: "POST", headers: { ...headers(), "content-type": "application/json" }, body: JSON.stringify({ path: s.path, title: "Renamed twice" }) });
  assert.equal(res2.status, 200);
  await new Promise((r) => setTimeout(r, 6000)); // the feed's next read, held by the lingering hub
  const back = eventsClient(`?stream=${hello.stream}&since=${last}`);
  await back.opened;
  const again = await back.until(isEvent("session.renamed", s.path));
  assert.ok(again.f.type === "event" && again.f.name === "session.renamed" && again.f.title === "Renamed twice" && again.f.seq > last);
  assert.ok(!back.frames.some((x) => x.f.type === "gap"), "nothing missed");
  assert.ok(back.frames.every((x) => x.f.type !== "event" || x.f.seq > last), "nothing before the cursor");
  back.ws.close();
});

test("a client frame over the cap closes the socket 1009", async () => {
  const ev = eventsClient();
  await ev.opened;
  const code = new Promise<number>((r) => ev.ws.once("close", (c) => r(c)));
  ev.ws.send("x".repeat(64 * 1024));
  assert.equal(await code, 1009);
});

test("the peer listener's gate refuses /ws/events, even for a peer with every grant", async () => {
  const { PeerGate } = await import("./mesh/listener");
  const { upgradeSovaSocket } = await import("./ws");
  const gate = new PeerGate({ fetch: () => new Response("no"), upgrade: upgradeSovaSocket, allows: () => true });
  const peer = { id: "p", nodeId: "n1", name: "p", url: "http://x" } as never;
  const s: Server = gate.server(() => peer);
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  const port = (s.address() as { port: number }).port;
  try {
    for (const path of ["/ws/events", "/ws/events?stream=abcdefgh12345678&since=0"]) {
      const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`);
      const status = await new Promise<number>((res) => {
        ws.on("unexpected-response", (_req, r) => res(r.statusCode ?? 0));
        ws.on("open", () => res(101));
        ws.on("error", () => res(-1));
      });
      assert.equal(status, 404, path);
    }
  } finally {
    s.close();
  }
});

test("the share listener has no /ws/events", async () => {
  const { createShareServer } = await import("./share/edge");
  const s = createShareServer({});
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  const port = (s.address() as { port: number }).port;
  try {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/events`);
    const status = await new Promise<number>((res) => {
      ws.on("unexpected-response", (_req, r) => res(r.statusCode ?? 0));
      ws.on("open", () => res(101));
      ws.on("error", () => res(-1));
    });
    assert.equal(status, 404);
  } finally {
    s.close();
  }
});

test("a client that stops reading: the server's memory stays flat, and when it reads again a gap overflow names what it lost", async () => {
  const { spawn } = await import("node:child_process");
  const { eventHub } = await import("./events");
  const hub = eventHub()!;
  // Live memory after a full collection: the JS heap, and what lives outside it (Bun counts a big
  // string in both). RSS can't tell holding from churning: the loop below makes 60 MB of short-lived
  // JSON, and how much of it the allocator keeps paged in depends on when the collector ran, which
  // under load is anywhere from 10 to 40 MB with the queue capped. Live memory is what the cap bounds.
  // By design the server holds the ring (RING_BYTES, 1 MB), the socket's queue (QUEUE_BYTES, 256 KB)
  // and its in-flight sends (WRITABLE_BYTES, 64 KB): measured 2.4 MB counted both ways, at any load.
  // With the cap gone, or the queue bypassed, it holds every event: measured 97 MB. The bound is a
  // fixed figure between the two, never one computed from those constants (a mutation of the cap
  // would raise it too).
  const LIVE_BOUND = 8 * 1024 * 1024;
  const gc = (globalThis as { Bun?: { gc(force: boolean): void } }).Bun?.gc ?? (globalThis as { gc?: () => void }).gc;
  const live = () => {
    gc?.(true);
    const m = process.memoryUsage();
    return { live: m.heapUsed + m.external, rss: m.rss };
  };
  // The reader is a process of its own, stopped with SIGSTOP: only then does nothing drain the socket
  // (a paused socket in this process is still read into memory by the runtime).
  const reader = `
    const net = require("node:net");
    const s = net.connect(${Number(host.split(":")[1])}, "127.0.0.1", () => s.write(${JSON.stringify(
      `GET /ws/events HTTP/1.1\r\nHost: ${host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
        `Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n${TOKEN_HEADER}: ${sovaToken()}\r\n\r\n`,
    )}));
    let tail = "", ready = false;
    s.on("data", (d) => {
      const t = tail + d.toString("latin1");
      if (!ready && t.startsWith("HTTP/1.1 101")) { ready = true; console.log("ready"); }
      if (t.includes('"reason":"overflow"')) { console.log("overflow"); process.exit(0); }
      tail = t.slice(-64);
    });
  `;
  const child = spawn(process.execPath, ["-e", reader], { stdio: ["ignore", "pipe", "inherit"] });
  let out = "";
  child.stdout.on("data", (d) => (out += String(d)));
  const saw = async (word: string, ms: number) => {
    const end = Date.now() + ms;
    while (!out.includes(word) && Date.now() < end) await new Promise((r) => setTimeout(r, 50));
    return out.includes(word);
  };
  try {
    assert.ok(await saw("ready", 10_000), "the reader connected");
    child.kill("SIGSTOP");
    await new Promise((r) => setTimeout(r, 200));
    assert.ok(gc, "a forced collection is available (Bun.gc, or node --expose-gc)");
    const before = live();
    const big = "x".repeat(1024);
    // 60 MB of events at a reader that takes nothing: unbounded buffering would hold most of it.
    for (let i = 0; i < 60_000; i++) {
      hub.record({ name: "session.renamed", source: "observed", id: "z", path: "/z.jsonl", from: big, title: String(i) });
      if (i % 2000 === 0) await new Promise((r) => setTimeout(r, 5));
    }
    await new Promise((r) => setTimeout(r, 300));
    const now = live();
    const mb = (n: number) => `${(n / 1024 / 1024).toFixed(1)} MB`;
    const grown = now.live - before.live;
    console.log(`[events evidence] live memory grew ${mb(grown)} (rss ${mb(now.rss - before.rss)}) with a stopped reader`);
    assert.ok(grown < LIVE_BOUND, `live memory grew ${mb(grown)} with a stopped reader (bound ${mb(LIVE_BOUND)}): the server holds what the reader didn't take`);
    child.kill("SIGCONT");
    assert.ok(await saw("overflow", 15_000), "a gap overflow reached the reader");
  } finally {
    child.kill("SIGKILL");
  }
});
