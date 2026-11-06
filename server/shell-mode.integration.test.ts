// Run: pnpm test:int -- server/shell-mode.integration.test.ts
// Shell mode end to end (§chat.shell-mode/card, /lifecycle, /who) on a whole hermetic server with the stand-in
// model (server/testing/hermetic-server.ts) and real chat processes: a command run while the model replies
// ends before the reply and a second client that attaches then sees its card in the hello (t18), and it is
// saved below the reply once the reply ends; a command still running shows with its output so far to a
// client that attaches; archiving a chat stops its running command and saves it as stopped by the close
// (t19); and a page's handed-over frames never run one. Every wait is on a frame or the file, never a sleep.
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { startHermeticServer, type HermeticServer } from "./testing/hermetic-server";

let s: HermeticServer;
before(async () => {
  s = await startHermeticServer();
});
after(async () => {
  await s?.stop();
});

const headers = () => ({ "x-sova-token": s.token, "content-type": "application/json" });
async function api(method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> {
  const r = await fetch(`${s.base}${path}`, { method, headers: headers(), ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const text = await r.text();
  try {
    return { status: r.status, body: JSON.parse(text) };
  } catch {
    return { status: r.status, body: text };
  }
}
/** Poll a condition (a frame, the file) until it holds. */
async function until<T>(what: string, fn: () => T | undefined | false | Promise<T | undefined | false>, ms = 30_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

interface Session { id: string; path: string }
const newSession = async (): Promise<Session> => (await api("POST", "/api/sessions", { cwd: s.work })).body;
/** The session file's entries. */
const entries = (ses: Session): any[] => readFileSync(ses.path, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const bashEntries = (ses: Session) => entries(ses).filter((e) => e.type === "message" && e.message?.role === "bashExecution");
/** A chat socket of the web app's own (wire 2): its frames, and a way to send. */
async function chatSocket(ses: Session) {
  const ws = new WebSocket(`${s.base.replace("http", "ws")}/ws/chat?path=${encodeURIComponent(ses.path)}&tail=rest&wire=2`, { headers: { "x-sova-token": s.token } } as never);
  const frames: any[] = [];
  ws.addEventListener("message", (e) => frames.push(JSON.parse(String(e.data))));
  const hello = await until("the socket's hello", () => frames.find((f) => f.type === "hello"));
  return { frames, hello, send: (m: unknown) => ws.send(JSON.stringify(m)), close: () => ws.close(), find: (what: string, pred: (f: any) => boolean) => until(what, () => frames.find(pred)) };
}

test("a command run mid-reply: a client that attaches after it ended sees its card, and it is saved below the reply (t18)", async () => {
  const ses = await newSession();
  const a = await chatSocket(ses);
  a.send({ type: "prompt", text: "[[slow]] tell me a long story", clientId: "p1" });
  await a.find("the reply streaming", (f) => f.type === "event" && f.event?.type === "part.delta");
  a.send({ type: "shell", command: "echo hi", clientId: "s1" });
  const start = await a.find("the command's start", (f) => f.type === "shell_start");
  assert.equal(start.clientId, "s1");
  assert.equal(start.run.command, "echo hi");
  assert.equal(start.run.underReply, true);
  const end = await a.find("the command's end", (f) => f.type === "shell_end" && f.id === start.run.id);
  assert.equal(end.output.trim(), "hi");
  assert.equal(end.exitCode, 0);
  assert.equal(end.underReply, true, "pi saves it after the reply");
  assert.equal(bashEntries(ses).length, 0, "not saved while the reply streams");

  const b = await chatSocket(ses);
  assert.equal(b.hello.isStreaming, true, "the reply is still going");
  assert.equal(b.hello.shell?.length, 1, "the second client's hello carries the run");
  assert.deepEqual(
    { id: b.hello.shell[0].id, command: b.hello.shell[0].command, state: b.hello.shell[0].state, output: b.hello.shell[0].output.trim(), exitCode: b.hello.shell[0].exitCode, underReply: b.hello.shell[0].underReply },
    { id: start.run.id, command: "echo hi", state: "ended", output: "hi", exitCode: 0, underReply: true },
  );

  a.send({ type: "abort" });
  for (const c of [a, b]) await c.find("the run saved", (f) => f.type === "shell_saved" && f.id === start.run.id);
  const saved = a.frames.find((f) => f.type === "shell_saved");
  const appended = a.frames.find((f) => f.type === "append" && f.items.some((i: any) => i.id === saved.entryId));
  assert.equal(appended.items.find((i: any) => i.id === saved.entryId).kind, "shell");
  const file = entries(ses).filter((e) => e.type === "message");
  const at = file.findIndex((e) => e.id === saved.entryId);
  assert.ok(at > 0 && file.slice(0, at).some((e) => e.message.role === "assistant"), "the record is below the reply");
  const rows = (await api("GET", `/api/transcript?path=${encodeURIComponent(ses.path)}&wire=2`)).body.items as any[];
  assert.deepEqual(rows.find((r) => r.id === saved.entryId)?.shell, { command: "echo hi", output: "hi\n", exitCode: 0 });
  const legacy = (await api("GET", `/api/transcript?path=${encodeURIComponent(ses.path)}`)).body.items as any[];
  assert.equal(legacy.find((r) => r.id === saved.entryId)?.kind, "info", "wire 1 keeps the plain row");
  const c = await chatSocket(ses);
  assert.equal(c.hello.shell, undefined, "saved: no longer a live run");
  for (const x of [a, b, c]) x.close();
});

test("a command still running shows to a client that attaches, with its output so far; one at a time", async () => {
  const ses = await newSession();
  const gate = join(s.work, `gate-${Date.now()}`);
  const a = await chatSocket(ses);
  a.send({ type: "shell", command: `printf start; while [ ! -f ${gate} ]; do sleep 0.05; done; printf end`, clientId: "s1" });
  const start = await a.find("the command's start", (f) => f.type === "shell_start");
  await a.find("its first output", (f) => f.type === "shell_output" && f.id === start.run.id);
  a.send({ type: "shell", command: "echo second", clientId: "s2" });
  const refused = await a.find("the second refused", (f) => f.type === "shell_refused" && f.clientId === "s2");
  assert.equal(refused.reason, "running");
  assert.equal(refused.message, "A command is already running in this chat.");
  const b = await chatSocket(ses);
  assert.deepEqual({ state: b.hello.shell?.[0]?.state, output: b.hello.shell?.[0]?.output }, { state: "running", output: "start" });
  writeFileSync(gate, "");
  const saved = await b.find("the run saved", (f) => f.type === "shell_saved" && f.id === start.run.id);
  const row = b.frames.find((f) => f.type === "append" && f.items.some((i: any) => i.id === saved.entryId)).items.find((i: any) => i.id === saved.entryId);
  assert.deepEqual(row.shell, { command: start.run.command, output: "startend", exitCode: 0 });
  assert.equal(bashEntries(ses).length, 1, "the refused one was never saved");
  a.close();
  b.close();
});

test("archiving a chat stops its running command and saves it as stopped when the chat closed (t19)", async () => {
  const ses = await newSession();
  const a = await chatSocket(ses);
  a.send({ type: "shell", command: "sleep 60", clientId: "s1" });
  await a.find("the command's start", (f) => f.type === "shell_start");
  const r = await api("POST", "/api/sessions/archive", { path: ses.path, archived: true });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const [entry] = await until("the stopped command's record", () => (bashEntries(ses).length ? bashEntries(ses) : false));
  assert.equal(entry.message.command, "sleep 60");
  assert.equal(entry.message.cancelled, true);
  const marker = await until("its close marker", () => entries(ses).find((e) => e.type === "custom" && e.customType === "sova-shell-closed"));
  assert.equal(marker.data.targetId, entry.id);
  await api("POST", "/api/sessions/archive", { path: ses.path, archived: false });
  const rows = (await api("GET", `/api/transcript?path=${encodeURIComponent(ses.path)}&wire=2`)).body.items as any[];
  assert.deepEqual(rows.find((x) => x.id === entry.id)?.shell, { command: "sleep 60", output: "", cancelled: true, cancelReason: "closed" });
  a.close();
});

test("a page's handed-over frames never run a command (POST /api/chat/frames)", async () => {
  const ses = await newSession();
  const marker = join(s.work, `ran-${Date.now()}`);
  const r = await api("POST", `/api/chat/frames?path=${encodeURIComponent(ses.path)}`, { frames: [{ type: "shell", command: `touch ${marker}`, clientId: "f1" }] });
  assert.equal(r.status, 202);
  assert.equal(r.body.accepted, 0);
  // A live socket's command afterwards runs: had the dropped one been queued, it would have run first.
  const a = await chatSocket(ses);
  a.send({ type: "shell", command: "echo after", clientId: "s1" });
  await a.find("the live command saved", (f) => f.type === "shell_saved");
  assert.equal(existsSync(marker), false);
  assert.deepEqual(bashEntries(ses).map((e) => e.message.command), ["echo after"]);
  a.close();
});
