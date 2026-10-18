// Run: pnpm test:int -- server/chat-runtime/link.integration.test.ts. The chat process's socket, both ends, over a
// real unix socket in a short temp dir: hello then control, one controller by epoch, pings, a broken
// stream, a peer that stops answering.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { CHAT_WIRE_PROTO, DEFAULT_RUNTIME_SETTINGS, encodeFrame, FrameDecoder } from "../../shared/chat-runtime-wire";
import { awaitFrame, connectLink, type ControlFrame, type Link, LinkRefused, serveLink } from "./link";

const dir = mkdtempSync(join(tmpdir(), "crl-"));
after(() => rmSync(dir, { recursive: true, force: true }));
let n = 0;
const quiet = () => {};

async function runtime(opts: { pingEveryMs?: number } = {}) {
  const sock = join(dir, `s${++n}`, "c.sock");
  const controls: { link: Link; control: ControlFrame }[] = [];
  const srv = await serveLink(sock, {
    hello: () => ({ build: "b1", pid: process.pid, startedAt: 1, unit: "u", sessionId: "sid", path: "/p.jsonl", state: "ready", seq: 0 }),
    onControl: (link, control) => controls.push({ link, control }),
    log: quiet,
    ...opts,
  });
  return { sock, srv, controls };
}
const dialAs = (sock: string, epoch: number, extra: { pingEveryMs?: number; pingsMissedMax?: number } = {}) =>
  connectLink(sock, { epoch, build: "b1", settings: DEFAULT_RUNTIME_SETTINGS, since: null, log: quiet, ...extra });
const until = async (cond: () => boolean, ms = 2_000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
};

test("hello, then control: the runtime has a controller and frames flow both ways", async () => {
  const { sock, srv, controls } = await runtime();
  assert.equal(statSync(sock).mode & 0o777, 0o600);
  assert.equal(statSync(join(sock, "..")).mode & 0o777, 0o700);
  const { link, hello } = await dialAs(sock, 10);
  assert.equal(hello.proto, CHAT_WIRE_PROTO);
  assert.equal(hello.epoch, 0, "no controller seen yet");
  assert.equal(hello.sessionId, "sid");
  await until(() => controls.length === 1);
  assert.equal(srv.epoch, 10);
  assert.equal(srv.controller, controls[0]!.link);
  const got = awaitFrame(link, "touched", 1_000);
  controls[0]!.link.send({ t: "touched" });
  assert.deepEqual(await got, { t: "touched" });
  const back = awaitFrame(controls[0]!.link, "push", 1_000);
  link.send({ t: "push", kind: "build", build: "b2" });
  assert.deepEqual(await back, { t: "push", kind: "build", build: "b2" });
  link.close();
  await srv.close();
});

test("frames that come before anyone listens for their type wait for the first listener", async () => {
  const { sock, srv, controls } = await runtime();
  const { link } = await dialAs(sock, 1);
  await until(() => controls.length === 1);
  // The runtime answers control with a state and a tool call in one breath; the server listens late.
  controls[0]!.link.send({ t: "touched" });
  controls[0]!.link.send({ t: "tool.abort", effectId: "e1" });
  controls[0]!.link.send({ t: "tool.abort", effectId: "e2" });
  await new Promise((r) => setTimeout(r, 50));
  const got: string[] = [];
  link.on("tool.abort", (f) => got.push(f.effectId));
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(got, ["e1", "e2"], "in order, once");
  link.on("tool.abort", (f) => got.push(`again:${f.effectId}`));
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(got, ["e1", "e2"], "handed over once, not to each later listener");
  assert.deepEqual(await awaitFrame(link, "touched", 500), { t: "touched" });
  link.close();
  await srv.close();
});

test("one controller by epoch: lower refused, equal refused while up, higher replaces", async () => {
  const { sock, srv, controls } = await runtime();
  const first = await dialAs(sock, 100);
  await until(() => controls.length === 1);

  const low = await dialAs(sock, 99);
  assert.equal(low.hello.epoch, 100, "hello says the highest epoch seen");
  await assert.rejects(awaitFrame(low.link, "state", 1_000), (e) => e instanceof LinkRefused && e.refusal.reason === "stale-epoch");

  const same = await dialAs(sock, 100);
  await assert.rejects(awaitFrame(same.link, "state", 1_000), (e) => e instanceof LinkRefused && e.refusal.reason === "busy-controller");
  assert.equal(controls.length, 1);

  const high = await dialAs(sock, 101);
  await until(() => controls.length === 2);
  assert.deepEqual(await controls[0]!.link.closed, { reason: "replaced" });
  assert.equal((await first.link.closed).reason, "closed", "the server's old link sees the close");
  assert.equal(srv.controller, controls[1]!.link);

  // The controller gone, the same epoch may come back (a reconnect of the same server).
  high.link.close();
  await until(() => srv.controller === null);
  const again = await dialAs(sock, 101);
  await until(() => controls.length === 3);
  again.link.close();
  await srv.close();
});

test("a server whose protocol is too far off still controls the kernel frames", async () => {
  const { sock, srv, controls } = await runtime();
  const raw = createConnection(sock);
  await new Promise((r) => raw.once("connect", r));
  raw.write(encodeFrame({ t: "control", proto: CHAT_WIRE_PROTO + 5, epoch: 7, serverPid: 1, serverStartedAt: 1, build: "x", since: null, settings: DEFAULT_RUNTIME_SETTINGS }));
  await until(() => controls.length === 1);
  assert.equal(controls[0]!.link.compatible, false);
  raw.destroy();
  await srv.close();
});

test("a broken stream closes the link", async () => {
  const { sock, srv, controls } = await runtime();
  const { link } = await dialAs(sock, 1);
  await until(() => controls.length === 1);
  // Write raw garbage with a valid length: not JSON.
  const bytes = new TextEncoder().encode("{oops");
  const frame = new Uint8Array(4 + bytes.length);
  new DataView(frame.buffer).setUint32(0, bytes.length);
  frame.set(bytes, 4);
  (link as unknown as { socket: { write(b: Uint8Array): void } }).socket.write(frame);
  const end = await controls[0]!.link.closed;
  assert.equal(end.reason, "protocol");
  await link.closed;
  await srv.close();
});

test("pings are answered; a peer that stops answering is lost", async () => {
  const { sock, srv, controls } = await runtime({ pingEveryMs: 20 });
  // A live server answers pings: the runtime's link stays.
  const live = await dialAs(sock, 1, { pingEveryMs: 20 });
  await until(() => controls.length === 1);
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(controls[0]!.link.isOpen, true);
  assert.equal(live.link.isOpen, true);
  live.link.close();

  // A server that takes control and then never reads again.
  const raw = createConnection(sock);
  await new Promise((r) => raw.once("connect", r));
  const dec = new FrameDecoder();
  raw.on("data", (c) => dec.push(c)); // reads, never answers
  raw.write(encodeFrame({ t: "control", proto: CHAT_WIRE_PROTO, epoch: 2, serverPid: 1, serverStartedAt: 1, build: "x", since: null, settings: DEFAULT_RUNTIME_SETTINGS }));
  await until(() => controls.length === 2);
  assert.deepEqual(await controls[1]!.link.closed, { reason: "lost" });
  raw.destroy();
  await srv.close();
});

test("a connection that never takes control is closed", async () => {
  const sock = join(dir, `s${++n}`, "c.sock");
  const srv = await serveLink(sock, {
    hello: () => ({ build: "b", pid: 1, startedAt: 1, unit: "u", sessionId: "s", path: "/p", state: "booting", seq: 0 }),
    onControl: () => assert.fail("no control was sent"),
    controlWithinMs: 30,
    log: quiet,
  });
  const raw = createConnection(sock);
  const closed = new Promise((r) => raw.once("close", r));
  raw.on("data", () => {});
  await closed;
  await srv.close();
});

test("dialing waits for a socket that isn't there yet, when asked to", async () => {
  const sock = join(dir, `s${++n}`, "c.sock");
  await assert.rejects(dialAs(sock, 3), "no retry asked: the dial fails at once");
  const dialing = connectLink(sock, { epoch: 4, build: "b", settings: DEFAULT_RUNTIME_SETTINGS, since: null, retryForMs: 2_000, retryEveryMs: 10, log: quiet });
  await new Promise((r) => setTimeout(r, 50));
  const srv = await serveLink(sock, {
    hello: () => ({ build: "b", pid: 1, startedAt: 1, unit: "u", sessionId: "s", path: "/p", state: "booting", seq: 0 }),
    onControl: () => {},
    log: quiet,
  });
  const ok = await dialing;
  assert.equal(ok.hello.state, "booting");
  ok.link.close();
  await srv.close();
});

test("a chat busy loading its code says hello late: the dial's budget waits for it, a dial with none doesn't", async () => {
  const sock = join(dir, `s${++n}`, "c.sock");
  const { mkdirSync } = await import("node:fs");
  const { createServer } = await import("node:net");
  mkdirSync(join(dir, `s${n}`), { recursive: true });
  // Accepts at once, says hello 300 ms later (as a chat whose event loop is busy loading its code does).
  const hello = encodeFrame({ t: "hello", proto: CHAT_WIRE_PROTO, minProto: CHAT_WIRE_PROTO - 1, epoch: 0, build: "b", pid: 1, startedAt: 1, unit: "u", sessionId: "s", path: "/p", state: "booting", seq: 0 });
  const conns: import("node:net").Socket[] = [];
  const late = createServer((s) => {
    conns.push(s);
    s.on("error", () => {});
    setTimeout(() => s.writable && s.write(hello), 300);
  });
  await new Promise<void>((r) => late.listen(sock, r));
  await assert.rejects(connectLink(sock, { epoch: 1, build: "b", settings: DEFAULT_RUNTIME_SETTINGS, since: null, helloWithinMs: 50, log: quiet }), /didn't say hello in time/);
  const ok = await connectLink(sock, { epoch: 1, build: "b", settings: DEFAULT_RUNTIME_SETTINGS, since: null, helloWithinMs: 50, retryForMs: 2_000, log: quiet });
  assert.equal(ok.hello.state, "booting");
  ok.link.close();
  for (const c of conns) c.destroy();
  await new Promise<void>((r) => late.close(() => r()));
});
