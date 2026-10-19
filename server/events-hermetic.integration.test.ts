// Run: node scripts/run-tests.mjs server/events-hermetic.integration.test.ts
// Sova's event stream on a hermetic server (server/testing/hermetic-server.ts): the server as the
// service runs it (scripts/start-server.sh, Bun), chats in processes of their own, the scripted
// stand-in model as the default. One real turn gives exactly one hosted turn.started and one hosted
// turn.ended, the end within 1 s of the chat's settle frame; a rename is one observed session.renamed.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { WebSocket } from "ws";
import type { EventsServerFrame } from "../shared/events";
import { startHermeticServer, type HermeticServer } from "./testing/hermetic-server";

let s: HermeticServer;
before(async () => {
  s = await startHermeticServer();
});
after(async () => {
  const changed = await s?.stop();
  assert.deepEqual(changed ?? [], [], "the sentinel home is untouched");
});

const ws = (path: string) => new WebSocket(`${s.base.replace(/^http/, "ws")}${path}`, { headers: { "x-sova-token": s.token } });

/** Frames as they arrive, each with its arrival time; `until` waits for one matching. */
function collect(sock: WebSocket, name: (m: any) => string | null = () => null) {
  const got: { m: any; t: number }[] = [];
  sock.on("message", (d) => {
    const m = JSON.parse(String(d));
    got.push({ m: name(m) ? { ...m, type: name(m) } : m, t: Date.now() });
  });
  const until = async (pred: (m: any) => boolean, ms = 60_000) => {
    const end = Date.now() + ms;
    for (;;) {
      const hit = got.find((x) => pred(x.m));
      if (hit) return hit;
      if (Date.now() > end) throw new Error(`timed out; got ${JSON.stringify(got.map((x) => x.m))}\n${s.log().slice(-2000)}`);
      await new Promise((r) => setTimeout(r, 50));
    }
  };
  const opened = new Promise<void>((r, j) => (sock.once("open", () => r()), sock.once("error", j)));
  return { got, until, opened };
}

const isEvent = (name: string, path: string) => (f: EventsServerFrame) => f.type === "event" && f.name === name && "path" in f && f.path === path;

test("a real turn: turn.started then turn.ended, hosted, once each, the end within 1 s of the run settling; a rename is observed", async () => {
  const events = ws("/ws/events");
  const ev = collect(events);
  await ev.opened;
  await ev.until((f) => f.type === "hello");

  const res = await fetch(`${s.base}/api/sessions`, { method: "POST", headers: { "x-sova-token": s.token, "content-type": "application/json" }, body: JSON.stringify({ cwd: s.work }) });
  const body = await res.text();
  assert.equal(res.status, 201, body);
  const { path } = JSON.parse(body) as { path: string };

  // A wire-1 SDK event frame is named by its event's own type (agent_start, agent_settled, …).
  const chat = ws(`/ws/chat?path=${encodeURIComponent(path)}`);
  const c = collect(chat, (m) => (m.type === "event" && m.event?.type ? m.event.type : null));
  await c.opened;
  await c.until((m) => m.type === "hello");
  chat.send(JSON.stringify({ type: "prompt", text: "What is the package name?", clientId: "c1" }));
  const settled = await c.until((m) => m.type === "agent_settled");
  const started = await ev.until(isEvent("turn.started", path));
  const ended = await ev.until(isEvent("turn.ended", path));
  assert.equal(started.m.source, "hosted");
  assert.equal(ended.m.source, "hosted");
  assert.ok(started.m.seq < ended.m.seq);
  assert.ok(Math.abs(ended.t - settled.t) <= 1000, `turn.ended ${ended.t - settled.t} ms from the settle frame`);

  // The feed's reads are what observe it: rename only once one has listed the session.
  const created = await ev.until(isEvent("session.created", path), 20_000);
  assert.equal(created.m.source, "observed");
  const titled = await fetch(`${s.base}/api/sessions/title`, { method: "POST", headers: { "x-sova-token": s.token, "content-type": "application/json" }, body: JSON.stringify({ path, title: "Named by the test" }) });
  assert.equal(titled.status, 200, await titled.text());
  const renamed = await ev.until(isEvent("session.renamed", path), 20_000);
  assert.equal(renamed.m.source, "observed");
  assert.equal(renamed.m.title, "Named by the test");

  // A feed re-diff or two after the run: no observed turn for a chat Sova runs.
  await new Promise((r) => setTimeout(r, 6000));
  const turns = ev.got.filter((x) => x.m.type === "event" && String(x.m.name).startsWith("turn.") && x.m.path === path).map((x) => `${x.m.name}:${x.m.source}`);
  assert.deepEqual(turns, ["turn.started:hosted", "turn.ended:hosted"]);
  chat.close();
  events.close();
});
