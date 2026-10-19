// Run: pnpm test:int -- server/commands-served.integration.test.ts
// The command line against a running Sova (§app.served-commands): a throwaway server of its own
// (server/testing/hermetic-server.ts: the scripted stand-in model, a sentinel HOME), driven only
// through scripts/sova.mjs as a process.
// - list and describe print the served list, which equals the command line's own copy of the same
//   manifest at the same version, and is what they use (a command line with no copy still lists the
//   extensions); a server with no such route (404) or none at all gives the copy's output exactly.
// - watch reports a hosted turn from the stand-in model through the stream (`source: "hosted"`, a
//   cursor), which the list diff cannot; --since prints exactly the events after its cursor; a bad
//   cursor exits 3; a server without the stream (a proxy that refuses /ws/events) gets the old diff,
//   and --since there exits 1.
// - GET /api/commands answers within 20 ms at p95 with five extensions installed, asking none of
//   their backends (each records what reaches it and never answers); the main
//   listener's gate still asks for the token; the peer listener needs `full`; the share listener 404s.
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, request as httpRequest, type IncomingMessage, type Server } from "node:http";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, test } from "node:test";
import { startHermeticServer, type HermeticServer } from "./testing/hermetic-server";

const CLI = fileURLToPath(new URL("../scripts/sova.mjs", import.meta.url));
const scratch = mkdtempSync(join(tmpdir(), "sova-served-int-"));
const noCopy = join(scratch, "no-copy-agent");
mkdirSync(join(noCopy, "sova"), { recursive: true });
const WATCHED = "created,removed,renamed,tagged,archived,turn.started,turn.ended,gap";

let server: HermeticServer;
let manifest = "";
/** Every extension's backend: records what reaches it and never answers, so a probe would show and wait. */
const asked: string[] = [];
const backend = createServer((req) => void asked.push(`${req.method} ${req.url}`));

before(async () => {
  await new Promise<void>((r) => backend.listen(0, "127.0.0.1", r));
  server = await startHermeticServer();
  manifest = join(server.agentDir, "sova", "extensions.json");
  const dist = join(scratch, "dist");
  mkdirSync(dist, { recursive: true });
  const ext = (id: string, n: number) => ({
    id,
    dist,
    api: `http://127.0.0.1:${(backend.address() as { port: number }).port}`,
    commands: Array.from({ length: n }, (_, i) => ({ name: `act-${i}`, label: `Act ${i}`, params: { text: { type: "string", required: i === 0 } } })),
  });
  writeFileSync(manifest, JSON.stringify({ version: 1, extensions: [ext("alpha", 1), ext("beta", 2), ext("gamma", 3), ext("delta", 4), ext("eps", 5)] }));
});

after(async () => {
  backend.closeAllConnections();
  backend.close();
  const changed = await server?.stop();
  rmSync(scratch, { recursive: true, force: true });
  assert.deepEqual(changed ?? [], [], "the sentinel home changed");
});

/** The command line's environment: nothing of this process's SOVA_* or PI_*. */
const cliEnv = (extra: Record<string, string>) => ({ PATH: process.env.PATH ?? "", HOME: server.home, LANG: "C.UTF-8", SOVA_URL: server.base, SOVA_TOKEN: server.token, PI_CODING_AGENT_DIR: server.agentDir, ...extra });

function cli(args: string[], extra: Record<string, string> = {}): Promise<{ code: number; out: string; err: string }> {
  return new Promise((done) => {
    const p = spawn("node", [CLI, ...args], { env: cliEnv(extra), cwd: server.work });
    let out = "";
    let err = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    p.on("close", (code) => done({ code: code ?? -1, out, err }));
  });
}

/** A running `sova watch`: its parsed lines so far, and a wait for one. */
function watcher(args: string[], extra: Record<string, string> = {}) {
  const p: ChildProcess = spawn("node", [CLI, "watch", ...args], { env: cliEnv(extra), cwd: server.work });
  const lines: Record<string, unknown>[] = [];
  let buf = "";
  let err = "";
  p.stdout!.on("data", (d) => {
    buf += d;
    let i: number;
    while ((i = buf.indexOf("\n")) >= 0) {
      const l = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (l.trim()) lines.push(JSON.parse(l));
    }
  });
  p.stderr!.on("data", (d) => (err += d));
  const exited = new Promise<number>((r) => p.on("close", (c) => r(c ?? -1)));
  return {
    lines,
    exited,
    err: () => err,
    async until(pred: (l: Record<string, unknown>) => boolean, ms = 30_000): Promise<Record<string, unknown>> {
      const end = Date.now() + ms;
      for (;;) {
        const hit = lines.find(pred);
        if (hit) return hit;
        if (Date.now() > end) throw new Error(`no such line in ${ms} ms: ${JSON.stringify(lines)} (stderr: ${err})`);
        await new Promise((r) => setTimeout(r, 25));
      }
    },
    stop: () => p.kill(),
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const seqOf = (l: Record<string, unknown>) => Number(String(l.cursor).split(":")[1]);

/** A stand-in for a Sova with no /api/commands: every request answers 404, as an older server's /api does. */
async function notFoundServer(): Promise<{ base: string; seen: string[]; close: () => void }> {
  const seen: string[] = [];
  const s = createServer((req, res) => {
    seen.push(`${req.method} ${req.url}`);
    res.writeHead(404, { "content-type": "application/json" }).end(JSON.stringify({ error: "Not found" }));
  });
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  return { base: `http://127.0.0.1:${(s.address() as { port: number }).port}`, seen, close: () => s.close() };
}

/** The hermetic server as an older Sova would be: everything passes through but /ws/events, refused. */
async function noStreamProxy(): Promise<{ base: string; close: () => void }> {
  const target = new URL(server.base);
  const s: Server = createServer((req, res) => {
    const up = httpRequest({ host: target.hostname, port: target.port, method: req.method, path: req.url, headers: req.headers }, (r) => {
      res.writeHead(r.statusCode ?? 502, r.headers);
      r.pipe(res);
    });
    up.on("error", () => res.destroy());
    req.pipe(up);
  });
  s.on("upgrade", (req: IncomingMessage, socket, head) => {
    if ((req.url ?? "").startsWith("/ws/events")) {
      socket.destroy();
      return;
    }
    const up = connect(Number(target.port), target.hostname, () => {
      const lines = [`${req.method} ${req.url} HTTP/1.1`];
      for (let i = 0; i < req.rawHeaders.length; i += 2) lines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`);
      up.write(`${lines.join("\r\n")}\r\n\r\n`);
      if (head.length) up.write(head);
      up.pipe(socket);
      socket.pipe(up);
    });
    up.on("error", () => socket.destroy());
    socket.on("error", () => up.destroy());
  });
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  return { base: `http://127.0.0.1:${(s.address() as { port: number }).port}`, close: () => (s.closeAllConnections(), s.close()) };
}

// ---- list and describe ----------------------------------------------------------------------------

test("the served list equals the command line's own copy of the same manifest, in both formats", async () => {
  const served = await cli(["list", "--json"]);
  assert.equal(served.code, 0, served.err);
  // The copy alone: SOVA_EXTENSIONS_FILE names the manifest, so no request is made.
  const copy = await cli(["list", "--json"], { SOVA_EXTENSIONS_FILE: manifest, SOVA_URL: "http://127.0.0.1:9" });
  assert.equal(copy.code, 0, copy.err);
  assert.deepEqual(JSON.parse(served.out), JSON.parse(copy.out));
  assert.equal(JSON.parse(served.out).filter((e: { id: string }) => e.id.startsWith("ext.")).length, 15);
  const text = await cli(["list"]);
  const copyText = await cli(["list"], { SOVA_EXTENSIONS_FILE: manifest, SOVA_URL: "http://127.0.0.1:9" });
  assert.equal(text.out, copyText.out);
});

test("list and describe use the served list: with no copy of the manifest, the extensions still show", async () => {
  const list = await cli(["list"], { PI_CODING_AGENT_DIR: noCopy });
  assert.equal(list.code, 0, list.err);
  assert.match(list.out, /^ext\.eps\.act-4\s+changes\s+Act 4$/m);
  const d = await cli(["describe", "ext.gamma.act-0"], { PI_CODING_AGENT_DIR: noCopy });
  assert.equal(d.code, 0, d.err);
  assert.deepEqual(JSON.parse(d.out).params.text, { type: "string", description: "", in: "body", required: true });
  const missing = await cli(["describe", "ext.no.such"], { PI_CODING_AGENT_DIR: noCopy });
  assert.equal(missing.code, 3);
});

test("a server without the route, or none at all, gives exactly the copy's output", async () => {
  const stub = await notFoundServer();
  try {
    const copy = await cli(["list"], { SOVA_EXTENSIONS_FILE: manifest, SOVA_URL: "http://127.0.0.1:9" });
    const old = await cli(["list"], { SOVA_URL: stub.base });
    assert.equal(old.code, 0, old.err);
    assert.equal(old.out, copy.out);
    assert.equal(old.err, "");
    assert.deepEqual(stub.seen, ["GET /api/commands"], "it asked, then fell back");
    const none = await cli(["list"], { SOVA_URL: "http://127.0.0.1:9" });
    assert.equal(none.code, 0, none.err);
    assert.equal(none.out, copy.out);
    const d = await cli(["describe", "ext.beta.act-1"], { SOVA_URL: stub.base });
    const dCopy = await cli(["describe", "ext.beta.act-1"], { SOVA_EXTENSIONS_FILE: manifest, SOVA_URL: "http://127.0.0.1:9" });
    assert.equal(d.code, 0, d.err);
    assert.equal(d.out, dCopy.out);
  } finally {
    stub.close();
  }
});

test("a listener that accepts and never answers costs list about the half-second cap, well under the old 2 s", async () => {
  const sockets: import("node:net").Socket[] = [];
  const mute = createServer();
  mute.on("connection", (s) => void sockets.push(s));
  await new Promise<void>((r) => mute.listen(0, "127.0.0.1", r));
  try {
    const url = `http://127.0.0.1:${(mute.address() as { port: number }).port}`;
    // The copy alone (no request) is the process's own cost; the wait on top of it is the cap.
    const c0 = performance.now();
    const copy = await cli(["list"], { SOVA_EXTENSIONS_FILE: manifest, SOVA_URL: "http://127.0.0.1:9" });
    const copyMs = performance.now() - c0;
    const t0 = performance.now();
    const r = await cli(["list"], { SOVA_URL: url });
    const waited = performance.now() - t0 - copyMs;
    assert.equal(r.code, 0, r.err);
    assert.equal(r.out, copy.out);
    assert.ok(sockets.length > 0, "it asked the listener first");
    console.log(`[served] a mute listener cost list ${Math.round(waited)} ms over the copy`);
    assert.ok(waited < 1400, `${Math.round(waited)} ms over the copy`);
  } finally {
    for (const s of sockets) s.destroy();
    mute.close();
  }
});

// ---- watch --------------------------------------------------------------------------------------

let turnStarted: Record<string, unknown> | null = null;
let firstWatch: ReturnType<typeof watcher> | null = null;

test("watch reports a short hosted turn from the stand-in model through the stream", async () => {
  const w = watcher(["--events", WATCHED]);
  firstWatch = w;
  await sleep(1500); // the stream's hello
  const made = await cli(["run", "session.create", "--cwd", "."]);
  assert.equal(made.code, 0, made.err);
  const s = JSON.parse(made.out) as { id: string; path: string };
  const sent = await cli(["run", "session.send", "--session", s.path, "--text", "Read package.json and tell me the package name."]);
  assert.equal(sent.code, 0, sent.err);
  const started = await w.until((l) => l.event === "turn.started" && l.path === s.path);
  const ended = await w.until((l) => l.event === "turn.ended" && l.path === s.path);
  // Only the stream says where a turn came from and gives a cursor; the list diff never does.
  assert.equal(started.source, "hosted");
  assert.equal(ended.source, "hosted");
  assert.match(String(started.cursor), /^[a-z0-9]{8,32}:\d+$/);
  assert.ok(seqOf(ended) > seqOf(started));
  assert.equal(String(ended.cursor).split(":")[0], String(started.cursor).split(":")[0]);
  assert.equal(w.lines.filter((l) => l.event === "turn.started" && l.path === s.path).length, 1);
  console.log(`[served] hosted turn: ${Number(ended.at) - Number(started.at)} ms from turn.started to turn.ended`);
  turnStarted = started;
});

test("--since prints exactly the events after its cursor, then live ones", async () => {
  assert.ok(turnStarted && firstWatch, "the turn test ran first");
  const since = String(turnStarted.cursor);
  const back = watcher(["--since", since, "--events", WATCHED]);
  try {
    await back.until((l) => l.event === "turn.ended");
    await sleep(500);
    const upTo = Math.min(Math.max(...back.lines.map(seqOf)), Math.max(...firstWatch.lines.map(seqOf)));
    const missed = firstWatch.lines.filter((l) => seqOf(l) > seqOf(turnStarted!) && seqOf(l) <= upTo);
    const replayed = back.lines.filter((l) => seqOf(l) <= upTo);
    assert.ok(missed.length > 0);
    assert.deepEqual(replayed, missed);
    assert.ok(!back.lines.some((l) => l.event === "gap"), "nothing was lost");
  } finally {
    back.stop();
    firstWatch.stop();
  }
});

test("a cursor the stream refuses exits 3 with its reason; a malformed one before any request; another stream's gives a restart gap", async () => {
  const stream = String(turnStarted?.cursor ?? "abcdefgh12345678:0").split(":")[0];
  const ahead = watcher(["--since", `${stream}:999999`]);
  assert.equal(await ahead.exited, 3);
  assert.match(ahead.err(), /ahead/);
  const bad = await cli(["watch", "--since", "nope"]);
  assert.equal(bad.code, 3);
  assert.match(bad.err, /--since takes a cursor/);
  const other = watcher(["--since", "zzzzzzzz00000000:5", "--events", WATCHED]);
  try {
    const first = await other.until(() => true, 10_000);
    assert.deepEqual(first.event, "gap");
    assert.equal(first.reason, "restarted");
  } finally {
    other.stop();
  }
});

test("a server without the stream gets the old watch: the feed and the list diff, and --since can't be kept", async () => {
  const proxy = await noStreamProxy();
  try {
    const refused = watcher(["--since", "abcdefgh12345678:1"], { SOVA_URL: proxy.base });
    assert.equal(await refused.exited, 1);
    assert.match(refused.err(), /no event stream/);
    assert.deepEqual(refused.lines, []);

    const w = watcher(["--events", "renamed,feed"], { SOVA_URL: proxy.base });
    try {
      const s = JSON.parse((await cli(["run", "session.create", "--cwd", "."])).out) as { id: string; path: string };
      await cli(["run", "session.send", "--session", s.path, "--text", "Read package.json and tell me the package name."]);
      let n = 0;
      const deadline = Date.now() + 30_000;
      while (!w.lines.some((l) => l.event === "renamed" && l.id === s.id) && Date.now() < deadline) {
        await cli(["run", "session.title.set", "--session", s.id, "--title", `Old watch ${++n}`]);
        await sleep(1500);
      }
      const line = w.lines.find((l) => l.event === "renamed" && l.id === s.id);
      assert.ok(line, `no rename through the diff: ${JSON.stringify(w.lines.slice(-5))} (${w.err()})`);
      assert.equal(line.source, undefined, "the diff's line, not the stream's");
      assert.equal(line.cursor, undefined);
      assert.ok(w.lines.some((l) => l.event === "feed"), "the feed's own frames, as before");
    } finally {
      w.stop();
    }
  } finally {
    proxy.close();
  }
});

// ---- the route itself ---------------------------------------------------------------------------

test("GET /api/commands: p95 within 20 ms with five extensions; the token is still asked", async () => {
  const headers = { "x-sova-token": server.token };
  for (let i = 0; i < 20; i++) await (await fetch(`${server.base}/api/commands`, { headers })).arrayBuffer();
  const times: number[] = [];
  for (let i = 0; i < 200; i++) {
    const t0 = performance.now();
    const res = await fetch(`${server.base}/api/commands`, { headers });
    await res.arrayBuffer();
    times.push(performance.now() - t0);
    assert.equal(res.status, 200);
  }
  times.sort((a, b) => a - b);
  const p50 = times[100]!;
  const p95 = times[190]!;
  console.log(`[served] GET /api/commands, 5 extensions, 200 calls: p50 ${p50.toFixed(2)} ms, p95 ${p95.toFixed(2)} ms`);
  assert.ok(p95 <= 20, `p95 ${p95.toFixed(2)} ms`);
  const body = (await (await fetch(`${server.base}/api/commands`, { headers })).json()) as { server: { head: string | null } };
  const health = (await (await fetch(`${server.base}/api/health`, { headers })).json()) as { head: string | null };
  assert.equal(body.server.head, health.head);
  assert.equal((await fetch(`${server.base}/api/commands`)).status, 401);
  // Hundreds of answers, every command line above included, and no extension backend was asked.
  assert.deepEqual(asked, []);
});

test("the peer listener needs full control for it; the share listener has no such route", async () => {
  const { PeerGate } = await import("./mesh/listener");
  const peer = { id: "p", nodeId: "n1", name: "p", url: "http://x" } as never;
  const ask = async (allows: (p: unknown, need: string) => boolean) => {
    const gate = new PeerGate({ fetch: () => new Response(JSON.stringify({ reached: true }), { headers: { "content-type": "application/json" } }), upgrade: () => {}, allows: allows as never });
    const s = gate.server(() => peer);
    await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
    try {
      return (await fetch(`http://127.0.0.1:${(s.address() as { port: number }).port}/api/commands`)).status;
    } finally {
      s.close();
    }
  };
  // Every capability but full control (a `sessions` peer with admin added): refused.
  assert.equal(await ask((_p, need) => need !== "full"), 403);
  assert.equal(await ask(() => true), 200);

  const { createShareServer } = await import("./share/edge");
  const share = createShareServer({});
  await new Promise<void>((r) => share.listen(0, "127.0.0.1", r));
  try {
    assert.equal((await fetch(`http://127.0.0.1:${(share.address() as { port: number }).port}/api/commands`)).status, 404);
  } finally {
    share.close();
  }
});
