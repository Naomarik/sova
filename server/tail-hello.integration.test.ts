// Run: pnpm exec tsx --test server/tail-hello.integration.test.ts. Newest rows first over the wire
// (server/tail-hello.ts): the cut itself, and both sockets end to end, with and without `?tail=1`.
// A throwaway PI_CODING_AGENT_DIR in the OS temp dir and an ephemeral loopback port; ~/.pi untouched.
// The hellos over real WebSockets; the tail and history rules in-process are tail-hello.test.ts.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import WebSocket from "ws";
import type { AlignDocInfo, TranscriptItem } from "../shared/protocol";
import { piSession } from "./harness/pi/testing/handle";
import { until as waitUntil } from "./test-wait";

const agentDir = realpathSync(mkdtempSync(join(tmpdir(), "sova-tail-hello-")));
process.env.PI_CODING_AGENT_DIR = agentDir;
const sessionsDir = join(agentDir, "sessions", "--tmp-tail--");
mkdirSync(sessionsDir, { recursive: true });
mkdirSync(join(agentDir, "sessions", "live"), { recursive: true });
const cwd = join(agentDir, "cwd");
mkdirSync(cwd, { recursive: true });

const { cutTail, historyRanges, pullFields, tailStart, TAIL_CHARS, HISTORY_CHUNK_CHARS } = await import("./tail-hello");
const { normalizeEntries } = await import("./transcript");
const { activeBranch, parseLines } = await import("./harness/pi/reader");
const { acquireChat, disposeAllChats } = await import("./chat-manager");
const { canonicalPath } = await import("./paths");
const { attachWebSockets } = await import("./ws");
const { AUTH_COOKIE, sovaToken } = await import("./auth");

/** Sockets still closing: their server side writes seen.json (server/seen.ts) on close. */
const closing: Promise<void>[] = [];
after(async () => {
  await Promise.all(closing);
  await new Promise((r) => setTimeout(r, 100)); // the server's own close handlers
  await disposeAllChats();
  rmSync(agentDir, { recursive: true, force: true });
});

const row = (id: string, kind: TranscriptItem["kind"] = "user", text = "x", extra: Partial<TranscriptItem> = {}): TranscriptItem => ({ id, kind, text, ...extra });
const sizesOf = (items: TranscriptItem[]) => items.map((it) => JSON.stringify(it).length);
/** The whole list back from a cut: history chunks arrive newest first, each prepended. */
const reassemble = (cut: ReturnType<typeof cutTail>) => cut.history.reduce<TranscriptItem[]>((list, part) => [...part.msg.items, ...list], cut.items);

// ---- Both sockets, end to end --------------------------------------------------------------

const header = (id: string) => ({ type: "session", version: 3, id, timestamp: "2026-09-28T00:00:00.000Z", cwd });
/** A branch long enough to be cut into a tail and several history chunks (~1.2 MB of rows). */
function bigSession(name: string): string {
  const path = canonicalPath(join(sessionsDir, `2026-09-28T00-00-00-000Z_${name}.jsonl`));
  const lines: unknown[] = [header(name)];
  let parent: string | null = null;
  for (let i = 0; i < 150; i++) {
    lines.push({ type: "message", id: `u${i}`, parentId: parent, timestamp: "2026-09-28T00:00:00.000Z", message: { role: "user", content: [{ type: "text", text: `ask ${i} ${"q".repeat(4000)}` }], timestamp: 0 } });
    lines.push({
      type: "message",
      id: `a${i}`,
      parentId: `u${i}`,
      timestamp: "2026-09-28T00:00:01.000Z",
      message: { role: "assistant", content: [{ type: "text", text: `answer ${i} ${"a".repeat(4000)}` }], provider: "anthropic", model: "m", api: "anthropic-messages", stopReason: "stop", timestamp: 0 },
    });
    parent = `a${i}`;
  }
  writeFileSync(path, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  return path;
}

const server = createServer();
attachWebSockets(server);
// Not awaited at the top level: the runner starts on the first tick, and hooks registered by then
// would run before the suites below exist.
const listening = new Promise<string>((r) => server.listen(0, "127.0.0.1", () => r(`ws://127.0.0.1:${(server.address() as AddressInfo).port}`)));
after(() => server.close());

/** Every frame a socket gets, raw, until `done` says so. */
async function frames(route: string, done: (got: string[]) => boolean, onOpen?: (ws: WebSocket, got: string[]) => void): Promise<string[]> {
  // attachWebSockets is the main listener's gate too: the upgrade carries the cookie, as a browser's would.
  const ws = new WebSocket(`${await listening}${route}`, { headers: { Cookie: `${AUTH_COOKIE}=${sovaToken()}` } });
  const got: string[] = [];
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out; got ${got.map((g) => JSON.parse(g).type).join(",")}`)), 15_000);
    ws.on("message", (data) => {
      got.push(data.toString());
      if (onOpen && got.length === 1) onOpen(ws, got);
      if (done(got)) {
        clearTimeout(timer);
        resolve();
      }
    });
    ws.on("error", reject);
  });
  closing.push(new Promise((r) => ws.once("close", () => r())));
  ws.close();
  return got;
}
const types = (got: string[]) => got.map((g) => JSON.parse(g).type as string);

describe("/ws/chat", () => {
  const path = bigSession("chat1");
  const q = `path=${encodeURIComponent(path)}&force=1`;
  const whole = normalizeEntries(activeBranch(parseLines(readFileSync(path, "utf8"))));

  test("without ?tail=1: today's messages, a whole hello, no history", async () => {
    const got = await frames(`/ws/chat?${q}`, (g) => types(g).includes("claude_login"));
    await new Promise((r) => setTimeout(r, 100)); // nothing else is on its way
    assert.deepEqual(types(got), ["hello", "commands", "queue", "mode", "claude_login"]);
    const hello = JSON.parse(got[0]!);
    assert.deepEqual(Object.keys(hello), ["type", "items", "isStreaming", "isCompacting", "model", "thinking", "context", "alignReview"]);
    assert.deepEqual(hello.items, whole);
    // Byte for byte what the per-client stringify always sent for that object.
    assert.equal(got[0], JSON.stringify(hello));
  });

  test("with ?tail=1: a cut hello first, the state after it, then the history, newest first", async () => {
    const got = await frames(`/ws/chat?${q}&tail=1`, (g) => g.length > 0 && JSON.parse(g.at(-1)!).left === 0);
    const t = types(got);
    const firstHistory = t.indexOf("history");
    assert.deepEqual(t.slice(0, firstHistory), ["hello", "commands", "queue", "mode", "claude_login"]);
    assert.ok(t.slice(firstHistory).every((x) => x === "history"));
    const hello = JSON.parse(got[0]!);
    assert.ok(hello.older > 0 && hello.items.length < whole.length);
    // Rows carry their entry (`raw`), so this session's ~8 KB rows fill the size budget before 60.
    assert.ok(JSON.stringify(hello.items).length <= TAIL_CHARS);
    const chunks = got.slice(firstHistory).map((g) => JSON.parse(g));
    assert.ok(chunks.length > 1, "several chunks");
    const list = chunks.reduce((l: TranscriptItem[], c) => [...c.items, ...l], hello.items);
    assert.deepEqual(list, whole);
    assert.equal(chunks.reduce((n, c) => n + c.items.length, 0), hello.older);
  });
});

describe("chat: a rewind with a tail client and a whole client", () => {
  test("the whole client gets a whole hello and no history; the tail client's history comes after the requester's ack", async () => {
    const path = bigSession("chat2");
    const chat = await acquireChat(path, true);
    const tail: any[] = [];
    const legacy: any[] = [];
    const t = { send: (m: any) => void tail.push(m), tail: true };
    chat.attach(t);
    chat.attach({ send: (m) => void legacy.push(m) });
    assert.equal(legacy.filter((m) => m.type === "history").length, 0);
    assert.ok(tail.at(-1).type === "history" && tail.at(-1).left === 0);
    tail.length = 0;
    legacy.length = 0;
    chat.handle(t, { type: "rewind", id: "r1", entryId: "u140" });
    await waitUntil(() => tail.some((m) => m.type === "rewound" || m.type === "rewind_refused"));
    const tt = tail.map((m) => m.type);
    assert.equal(tt[0], "hello");
    assert.ok(tail[0].older > 0);
    const ack = tt.indexOf("rewound");
    assert.ok(ack > 0, tt.join(","));
    assert.ok(tt.slice(ack + 1).length > 0 && tt.slice(ack + 1).every((x) => x === "history"), tt.join(","));
    assert.ok(!tt.slice(0, ack).includes("history"));
    const branch = normalizeEntries(piSession(chat).sessionManager.getBranch());
    const list = tail.filter((m) => m.type === "history").reduce((l: TranscriptItem[], c) => [...c.items, ...l], tail[0].items);
    assert.deepEqual(list, branch);
    assert.deepEqual(legacy.map((m) => m.type).filter((x) => x === "history"), []);
    const lh = legacy.find((m) => m.type === "hello");
    assert.equal(lh.older, undefined);
    assert.deepEqual(lh.items, branch);
  });
});

describe("/ws/watch", () => {
  const path = bigSession("watch1");
  const q = `path=${encodeURIComponent(path)}`;
  const whole = normalizeEntries(activeBranch(parseLines(readFileSync(path, "utf8"))));

  test("without ?tail=1: one whole snapshot, byte for byte as before", async () => {
    const got = await frames(`/ws/watch?${q}`, (g) => g.length >= 1);
    await new Promise((r) => setTimeout(r, 100));
    assert.deepEqual(types(got), ["snapshot"]);
    const snap = JSON.parse(got[0]!);
    assert.deepEqual(snap.items, whole);
    const { type, items, ...rest } = snap;
    assert.equal(rest.older, undefined);
    // The key order the snapshot always had: type, items, then usage and context when present.
    assert.equal(got[0], JSON.stringify({ type, items, ...rest }));
  });

  test("with ?tail=1: a cut snapshot, then its history before any append", async () => {
    const got = await frames(`/ws/watch?${q}&tail=1`, (g) => types(g).includes("append"), (ws, g) => {
      // Written as soon as the snapshot lands: its append must still come after every chunk.
      const extra = { type: "message", id: "late", parentId: "a149", timestamp: "2026-09-28T00:00:02.000Z", message: { role: "user", content: [{ type: "text", text: "late" }], timestamp: 0 } };
      writeFileSync(path, readFileSync(path, "utf8") + JSON.stringify(extra) + "\n");
      void ws;
      void g;
    });
    const t = types(got);
    assert.equal(t[0], "snapshot");
    assert.equal(t.at(-1), "append");
    assert.ok(t.slice(1, -1).every((x) => x === "history") && t.length > 3, t.join(","));
    const snap = JSON.parse(got[0]!);
    const chunks = got.slice(1, -1).map((g) => JSON.parse(g));
    assert.equal(chunks.at(-1).left, 0);
    assert.deepEqual(chunks.reduce((l: TranscriptItem[], c) => [...c.items, ...l], snap.items), whole);
  });
});
