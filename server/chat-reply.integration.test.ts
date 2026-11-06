// Run: pnpm test:int -- server/chat-reply.integration.test.ts
// A reply to an earlier message (§chat.composer/reply-text, §chat.transcript/reply-quote) on a whole
// hermetic server with the stand-in model: sent as the page's composer sends it (a steer frame),
// the session file holds exactly the composed text, the transcript reads the original's entry id
// back from it, and both hold across a server restart and in a fork.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, before, test } from "node:test";
import { composeReply, parseReply } from "../shared/reply-quote";
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
async function until<T>(what: string, fn: () => Promise<T | undefined | false>, ms = 60_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}
const items = async (path: string): Promise<any[]> => (await api("GET", `/api/transcript?path=${encodeURIComponent(path)}`)).body.items;
const entryOf = (rowId: string) => rowId.split(":")[0]!;

/** A chat socket, as the page opens one; `steer` sends what the composer sends. */
async function chat(path: string) {
  const ws = new WebSocket(`${s.base.replace("http", "ws")}/ws/chat?path=${encodeURIComponent(path)}&tail=rest&wire=2`, { headers: { "x-sova-token": s.token } } as never);
  const frames: { type: string }[] = [];
  ws.addEventListener("message", (e) => frames.push(JSON.parse(String(e.data))));
  await until("the socket's hello", async () => frames.some((f) => f.type === "hello"));
  let n = 0;
  return {
    steer: (text: string) => ws.send(JSON.stringify({ type: "steer", text, clientId: `reply-test-${++n}` })),
    close: () => ws.close(),
  };
}

test("a reply is stored as composed, and its quote's link survives a restart and a fork", { timeout: 240_000 }, async () => {
  const { path } = (await api("POST", "/api/sessions", { cwd: s.work })).body as { path: string };
  const c = await chat(path);
  c.steer("hello there");
  const first = await until("the first reply", async () => (await items(path)).find((i) => i.kind === "assistant-text" && i.text));
  const original = entryOf(first.id);

  const sent = composeReply({ entryId: original, role: "assistant", part: false, quote: first.text, trimmed: false }, "Why that file?");
  c.steer(sent);
  const mine = await until("the reply in the transcript", async () => (await items(path)).find((i) => i.kind === "user" && parseReply(i.text ?? "")));
  await until("the answer to it", async () => (await items(path)).filter((i) => i.kind === "assistant-text").length >= 2);
  c.close();

  // What the model read is the session file's user message: exactly the composed text, once.
  const raw = readFileSync(path, "utf8");
  const escaped = JSON.stringify(sent).slice(1, -1);
  assert.equal(raw.split(escaped).length - 1, 1, "the composed reply is stored verbatim, once");
  assert.equal(mine.text, sent);
  assert.deepEqual(parseReply(mine.text), { entryId: original, role: "assistant", part: false, quote: first.text, words: "Why that file?" });
  assert.ok((await items(path)).some((i) => entryOf(i.id) === original), "the quoted entry is on the branch");

  // A restart reads the same reply back, from the file alone.
  await s.restart();
  const again = await until("the transcript after the restart", async () => {
    const r = await api("GET", `/api/transcript?path=${encodeURIComponent(path)}`);
    return r.status === 200 ? (r.body.items as any[]) : undefined;
  });
  const back = again.find((i) => i.kind === "user" && parseReply(i.text ?? ""));
  assert.equal(parseReply(back.text)?.entryId, original);
  assert.ok(again.some((i) => entryOf(i.id) === original));

  // A fork through the last reply copies the messages with their ids: the quote still finds its original.
  const last = again.filter((i) => i.kind === "assistant-text").at(-1)!;
  const fork = await api("POST", "/api/sessions/fork", { path, entryId: entryOf(last.id) });
  assert.equal(fork.status, 201, JSON.stringify(fork.body));
  const forked = await items(fork.body.path);
  const inFork = forked.find((i) => i.kind === "user" && parseReply(i.text ?? ""));
  assert.equal(parseReply(inFork.text)?.entryId, original);
  assert.ok(forked.some((i) => entryOf(i.id) === original), "the fork keeps the original's entry id");
});
