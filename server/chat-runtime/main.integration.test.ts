// Run: pnpm test:int -- server/chat-runtime/main.integration.test.ts. The chat process for real: `bun
// server/chat-runtime/main.ts` spawned on a throwaway agent dir (no credentials: no model is called),
// dialed over its socket as the server would. It says hello while it boots and again when ready,
// opens its one chat, serves a browser, and exits on purpose with the cause it gave: a drain, SIGTERM,
// or the test hook that fails a start.
import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createConnection, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { CHAT_WIRE_PROTO, DEFAULT_RUNTIME_SETTINGS } from "../../shared/chat-runtime-wire";
import { awaitFrame, connectLink, Link } from "./link";

const root = join(import.meta.dirname, "..", "..");
const base = mkdtempSync(join(tmpdir(), "crm-"));
after(() => rmSync(base, { recursive: true, force: true }));
const kids: ChildProcess[] = [];
after(() => kids.forEach((k) => k.kill("SIGKILL")));

let n = 0;
function chatProcess(extra: Record<string, string> = {}) {
  const dir = join(base, `c${++n}`);
  const agentDir = join(dir, "agent");
  const cwd = join(dir, "cwd");
  const sessions = join(agentDir, "sessions", "--x--");
  mkdirSync(sessions, { recursive: true });
  mkdirSync(join(agentDir, "sessions", "live"), { recursive: true });
  mkdirSync(cwd, { recursive: true });
  const id = `01a0-mp${n}`;
  const path = join(sessions, `2026-10-12T00-00-00-000Z_${id}.jsonl`);
  writeFileSync(path, `${JSON.stringify({ type: "session", version: 3, id, timestamp: "2026-10-12T00:00:00.000Z", cwd })}\n`);
  const sock = join(dir, "s", "c.sock");
  let out = "";
  const child = spawn(process.execPath, [join(root, "server/chat-runtime/main.ts")], {
    cwd: root,
    env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, SOVA_CHAT_SOCK: sock, SOVA_CHAT_PATH: path, SOVA_CHAT_ID: id, SOVA_CHAT_UNIT: "u-test", SOVA_CHAT_BUILD: "b1", SOVA_PRICES_FETCH: "off", ...extra },
    stdio: ["ignore", "pipe", "pipe"],
  });
  kids.push(child);
  child.stdout!.on("data", (d) => (out += d));
  child.stderr!.on("data", (d) => (out += d));
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((r) => child.once("exit", (code, signal) => r({ code, signal })));
  return { child, sock, path, id, exited, out: () => out };
}

const dial = (sock: string, epoch: number) =>
  connectLink(sock, { epoch, build: "b1", settings: DEFAULT_RUNTIME_SETTINGS, since: null, retryForMs: 10_000, retryEveryMs: 50, log: () => {} });

test("boots, says ready, opens its chat, serves a browser, and drains on purpose", { timeout: 60_000 }, async () => {
  const p = chatProcess();
  const { link, hello } = await dial(p.sock, 1);
  assert.equal(hello.sessionId, p.id);
  assert.equal(hello.build, "b1");
  if (hello.state !== "ready") await awaitFrame(link, "hello", 30_000, (h) => h.state === "ready");
  // As the server does: the chat's stored reply timings (none here), which a wire-2 pane's hello waits for.
  link.on("ask", (f) => void (f.method === "reply.timings" && link.send({ t: "answer", id: f.id, ok: true, result: null })));
  const opened = awaitFrame(link, "opened", 30_000);
  link.send({ t: "open", id: "o1", path: p.path, force: true, link: null, served: [] });
  const o = await opened;
  assert.equal(o.ok, true, p.out());
  const sends: string[] = [];
  link.on("client.send", (f) => sends.push(f.json));
  link.send({ t: "client.attach", clientId: "k1", client: { clientId: "k1", wire: 2 } });
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(JSON.parse(sends[0]!).type, "hello");
  link.send({ t: "client.detach", clientId: "k1" });
  const exit = awaitFrame(link, "exit", 30_000);
  link.send({ t: "drain", id: "d1", reason: "idle", force: false });
  assert.deepEqual(await exit, { t: "exit", cause: "idle" });
  assert.deepEqual(await p.exited, { code: 0, signal: null });
  // Said in its log too, for a supervisor that heard no frame (the format is its parser's).
  assert.match(p.out(), new RegExp(`\\[chat-runtime\\] exit idle \\(pid ${p.child.pid}\\)`));
  // A healthy start's trail (§app.chat-processes/boot-log): one line for its start, one for its open.
  const trail = p.out().split("\n").filter((l) => /\[chat-runtime\] (ready in|opened in|still )/.test(l));
  assert.equal(trail.length, 2, p.out());
  assert.match(trail[0]!, /^\[chat-runtime\] ready in \d+\.\d\d s \(headless [\d.]+ s, chat code [\d.]+ s, model setup [\d.]+ s, extensions load [\d.]+ s, warm session [\d.]+ s, extensions start [\d.]+ s, extensions stop [\d.]+ s, host [\d.]+ s(, other [\d.]+ s)?; cpu [\d.]+ s\)$/);
  assert.match(trail[1]!, /^\[chat-runtime\] opened in \d+\.\d\d s \(open file [\d.]+ s, loadout [\d.]+ s, extensions load [\d.]+ s, session [\d.]+ s, extensions start [\d.]+ s, finish [\d.]+ s(, other [\d.]+ s)?; cpu [\d.]+ s\)$/);
});

test("a server whose control comes after the chat got ready still hears it is ready", { timeout: 60_000 }, async () => {
  // The race a loaded machine hits: the connection's hello said booting, the chat finished booting, and
  // only then the server's control came. The server waits for a hello that says ready; it must get one.
  const p = chatProcess();
  let socket: Socket | null = null;
  for (let i = 0; i < 200 && !socket; i++) {
    socket = await new Promise<Socket | null>((r) => {
      const s = createConnection(p.sock);
      s.once("connect", () => r(s));
      s.once("error", () => r(null));
    });
    if (!socket) await new Promise((r) => setTimeout(r, 50));
  }
  assert.ok(socket, p.out());
  const link = new Link(socket, { log: () => {} });
  const first = await awaitFrame(link, "hello", 10_000);
  assert.equal(first.state, "booting", "dialed as soon as it listens, before its code is loaded");
  // Control is held back until the chat says (in its log) that it is ready; it closes a link with no
  // control after 10 s.
  for (let i = 0; i < 180 && !/\[chat-runtime\] ready in/.test(p.out()); i++) await new Promise((r) => setTimeout(r, 50));
  assert.match(p.out(), /\[chat-runtime\] ready in/);
  const ready = awaitFrame(link, "hello", 10_000, (h) => h.state === "ready");
  link.send({ t: "control", proto: CHAT_WIRE_PROTO, epoch: 1, serverPid: process.pid, serverStartedAt: Date.now(), build: "b1", since: null, settings: DEFAULT_RUNTIME_SETTINGS });
  assert.equal((await ready).state, "ready");
  // And it opens as usual on that link.
  const opened = awaitFrame(link, "opened", 30_000);
  link.send({ t: "open", id: "o1", path: p.path, force: true, link: null, served: [] });
  assert.equal((await opened).ok, true, p.out());
  p.child.kill("SIGTERM");
  await p.exited;
});

test("SIGTERM closes it as the operator's stop", { timeout: 60_000 }, async () => {
  const p = chatProcess();
  const { link, hello } = await dial(p.sock, 1);
  if (hello.state !== "ready") await awaitFrame(link, "hello", 30_000, (h) => h.state === "ready");
  const opened = awaitFrame(link, "opened", 30_000);
  link.send({ t: "open", id: "o1", path: p.path, force: true, link: null, served: [] });
  assert.equal((await opened).ok, true, p.out());
  const sends: string[] = [];
  link.on("client.send", (f) => sends.push(f.json));
  link.send({ t: "client.attach", clientId: "k1", client: { clientId: "k1" } });
  await new Promise((r) => setTimeout(r, 300));
  const exit = awaitFrame(link, "exit", 30_000);
  p.child.kill("SIGTERM");
  assert.deepEqual(await exit, { t: "exit", cause: "operator" });
  const exits: string[] = [];
  link.on("exit", (f) => exits.push(f.cause));
  // The pane reconnects quietly, as after a reload.
  assert.deepEqual(JSON.parse(sends.at(-1)!), { type: "error", code: "reloaded", message: "Reconnecting. Your draft is kept." });
  assert.deepEqual(await p.exited, { code: 0, signal: null });
  assert.deepEqual(exits, [], "one exit frame, not two");
  assert.match(p.out(), new RegExp(`\\[chat-runtime\\] exit operator \\(pid ${p.child.pid}\\)`));
});

test("a start that hangs: a beat names its step, the server hears it, and SIGTERM leaves the step and its child programs", { timeout: 60_000 }, async () => {
  const p = chatProcess({ SOVA_CHAT_TEST_HANG_BOOT: "b1", SOVA_CHAT_TEST_BEAT_MS: "200" });
  const { link, hello } = await dial(p.sock, 1);
  const steps: string[] = [];
  link.on("boot", (f) => steps.push(`${f.phase}/${f.step}`));
  assert.equal(hello.state, "booting");
  for (let i = 0; i < 100 && !/still starting: test hang/.test(p.out()); i++) await new Promise((r) => setTimeout(r, 50));
  assert.match(p.out(), /\[chat-runtime\] still starting: test hang for \d+\.\d s \(\d+\.\d s since start, cpu \d+\.\d s\)/);
  assert.ok(steps.includes("starting/test hang"), `heard: ${steps.join(", ")}`);
  p.child.kill("SIGTERM");
  assert.deepEqual(await p.exited, { code: 0, signal: null });
  const out = p.out();
  assert.match(out, /\[chat-runtime\] SIGTERM while starting: stuck in test hang for \d+\.\d s \(\d+\.\d s since start, cpu \d+\.\d s\)(; child programs: sleep pid \d+ up \d+ s)?/);
  if (process.platform === "linux") assert.match(out, /; child programs: sleep pid \d+ up \d+ s/);
  // The exit line the supervisor reads is still its parser's, and says how long the stop took.
  assert.match(out, new RegExp(`\\[chat-runtime\\] exit operator \\(pid ${p.child.pid}\\) \\d+\\.\\d\\d s after SIGTERM`));
  assert.doesNotMatch(out, /ready in/);
});

test("the failed-start test hook exits before it listens", { timeout: 30_000 }, async () => {
  const p = chatProcess({ SOVA_CHAT_TEST_FAIL_BOOT: "b1" });
  assert.equal((await p.exited).code, 3);
});
