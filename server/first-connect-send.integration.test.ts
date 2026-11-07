// Run: node scripts/run-tests.mjs --integration server/first-connect-send.integration.test.ts
// A message sent before a new chat's hello (§chat.transcript/send-while-starting): the whole server
// on an ephemeral port in a throwaway PI_CODING_AGENT_DIR (~/.pi is never read or written), a local
// stand-in model (server/stream-stub.ts) so a real turn runs in a real chat process, and raw
// WebSocket clients that write before the chat says hello, as a new session's tab does when Enter
// is pressed at once. The model switch and the steer go in order and the steer runs once (a second
// socket's repeat of its client id is acknowledged, never run); a Stop's removal of a steer still
// waiting for the chat to open takes it back, and it never runs later.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { WebSocket } from "ws";
import { startStreamStub, stubModelsJson } from "./stream-stub";

for (const k of Object.keys(process.env)) if (/_API_KEY$|_AUTH_TOKEN$/.test(k)) delete process.env[k];

const tmp = realpathSync(mkdtempSync(join(tmpdir(), "sova-first-send-int-")));
process.on("exit", () => rmSync(tmp, { recursive: true, force: true }));
const agentDir = join(tmp, "agent");
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.PORT = "0";
mkdirSync(join(agentDir, "sessions", "live"), { recursive: true });
const dist = join(tmp, "dist");
mkdirSync(dist);
writeFileSync(join(dist, "index.html"), "<!doctype html><title>stub</title>");
const stub = await startStreamStub({ payload: "letters", perDelta: 16, limit: 16, tool: "no_such_tool" });
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

let n = 0;
/** A new session's file: its header only, as New Session makes it. */
function newSession(): { path: string; file: string } {
  const cwd = join(tmp, "proj");
  mkdirSync(cwd, { recursive: true });
  const dir = join(agentDir, "sessions", "--proj--");
  mkdirSync(dir, { recursive: true });
  const id = `01a0dd00-0000-7000-8000-0000000003${String(++n).padStart(2, "0")}`;
  const file = join(dir, `2026-11-07T00-00-${String(n).padStart(2, "0")}-000Z_${id}.jsonl`);
  writeFileSync(file, `${JSON.stringify({ type: "session", version: 3, id, timestamp: "2026-11-07T00:00:00.000Z", cwd })}\n`);
  return { path: canonicalPath(file), file };
}

/** The user messages the session file holds, by text. */
function userTexts(file: string): string[] {
  const out: string[] = [];
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    const e = JSON.parse(line);
    if (e.type !== "message" || e.message?.role !== "user") continue;
    const c = e.message.content;
    out.push(typeof c === "string" ? c : c.map((p: { text?: string }) => p.text ?? "").join(""));
  }
  return out;
}

type Frame = { type: string; [k: string]: unknown };
/** A chat socket that writes `onOpen`'s frames the moment it opens, before the chat's hello, and keeps every frame it gets. */
function chatSocket(path: string, onOpen: Frame[]) {
  const ws = new WebSocket(`ws://${host}/ws/chat?path=${encodeURIComponent(path)}&force=1`, { headers: headers() });
  const frames: Frame[] = [];
  const waiters: (() => void)[] = [];
  ws.on("open", () => {
    for (const f of onOpen) ws.send(JSON.stringify(f));
  });
  ws.on("message", (d) => {
    const m = JSON.parse(String(d));
    frames.push(m.type === "event" && m.event?.type ? { ...m, type: m.event.type } : m);
    for (const w of waiters.splice(0)) w();
  });
  const until = async (pred: (f: Frame) => boolean, what: string, ms = 60_000): Promise<number> => {
    const end = Date.now() + ms;
    for (;;) {
      const i = frames.findIndex(pred);
      if (i !== -1) return i;
      if (Date.now() > end) throw new Error(`no ${what}; got ${frames.map((f) => (f.type === "error" ? JSON.stringify(f) : f.type)).join(",")}`);
      await new Promise<void>((r) => {
        waiters.push(r);
        setTimeout(r, 250);
      });
    }
  };
  const closed = () =>
    new Promise<void>((r) => {
      if (ws.readyState === WebSocket.CLOSED) return r();
      ws.once("close", () => r());
      ws.close();
    });
  return { ws, frames, until, closed };
}

const MODEL = { type: "set_model", ref: "stub/runaway" };

test("a new chat: a model switch and a steer written before its hello go in order, the steer runs once; a repeat of its id on another socket is acknowledged, not run", async () => {
  const s = newSession();
  const a = chatSocket(s.path, [MODEL, { type: "steer", text: "first words", clientId: "fc-1" }]);
  const hello = await a.until((f) => f.type === "hello", "hello");
  const model = await a.until((f) => f.type === "model", "model");
  const ack = await a.until((f) => f.type === "send_ack" && f.clientId === "fc-1", "send_ack");
  assert.ok(hello < model && model < ack, "the hello, then the switch, then the steer");
  await a.until((f) => f.type === "agent_settled", "agent_settled");
  await a.closed();
  const b = chatSocket(s.path, [{ type: "steer", text: "first words", clientId: "fc-1" }]);
  await b.until((f) => f.type === "send_ack" && f.clientId === "fc-1", "the repeat's send_ack");
  await b.closed();
  assert.deepEqual(userTexts(s.file), ["first words"], "one user message");
});

test("Stop before the hello: a removal of the steer still waiting for the chat takes it back before the hello, and it never runs", async () => {
  const s = newSession();
  const a = chatSocket(s.path, [MODEL, { type: "steer", text: "take me back", clientId: "st-1" }, { type: "queue_remove", id: "queue_remove-1", itemId: "st-1" }]);
  const removed = await a.until((f) => f.type === "queue_removed" && f.itemId === "st-1", "queue_removed");
  assert.equal(a.frames[removed]!.id, "queue_remove-1", "answered by the request's id");
  assert.equal(a.frames[removed]!.text, "take me back");
  const hello = await a.until((f) => f.type === "hello", "hello");
  assert.ok(removed < hello, "taken back while the chat was still opening");
  // Whatever the chat ran of this socket's held frames ran before this; the next send settles after it.
  a.ws.send(JSON.stringify({ type: "prompt", text: "then this", clientId: "st-2" }));
  await a.until((f) => f.type === "send_ack" && f.clientId === "st-2", "the next send's ack");
  await a.until((f) => f.type === "agent_settled", "agent_settled");
  assert.equal(
    a.frames.some((f) => f.type === "send_ack" && f.clientId === "st-1"),
    false,
    "the removed steer was never taken",
  );
  await a.closed();
  assert.deepEqual(userTexts(s.file), ["then this"]);
});
