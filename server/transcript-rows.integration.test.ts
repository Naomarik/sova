// Run: node scripts/run-tests.mjs server/transcript-rows.integration.test.ts. Older rows on demand
// over the real sockets: `?tail=rest` on /ws/chat and /ws/watch (the newest rows, a summary of the
// rest, nothing pushed), and a rewind with live clients. The REST rows are transcript-rows.test.ts.
// A throwaway PI_CODING_AGENT_DIR in the OS temp dir and an ephemeral loopback port; ~/.pi untouched.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import WebSocket from "ws";
import type { TranscriptItem, TranscriptRows } from "../shared/protocol";
import { piSession } from "./harness/pi/testing/handle";


const agentDir = realpathSync(mkdtempSync(join(tmpdir(), "sova-rows-")));
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.PORT = "0";
const sessionsDir = join(agentDir, "sessions", "--tmp-rows--");
mkdirSync(sessionsDir, { recursive: true });
mkdirSync(join(agentDir, "sessions", "live"), { recursive: true });
const cwd = join(agentDir, "cwd");
mkdirSync(cwd, { recursive: true });

const { app, server } = await import("./index");
const { normalizeEntries } = await import("./transcript");
const { activeBranch, parseLines } = await import("./harness/pi/reader");
const { summarize } = await import("../shared/row-counts");
const { acquireChat, disposeAllChats } = await import("./chat-manager");
const { canonicalPath } = await import("./paths");
if (!server.listening) await new Promise((r) => server.once("listening", r));
const wsBase = `ws://127.0.0.1:${(server.address() as AddressInfo).port}`;
const { AUTH_COOKIE, sovaToken } = await import("./auth");
// The sockets below pass the main listener's gate as a browser's would: with the cookie.
const AUTH = { Cookie: `${AUTH_COOKIE}=${sovaToken()}` };

const closing: Promise<void>[] = [];
after(async () => {
  await Promise.all(closing);
  await new Promise((r) => setTimeout(r, 100));
  await disposeAllChats();
  server.close();
  server.closeAllConnections?.();
  rmSync(agentDir, { recursive: true, force: true });
});

const T = "2026-09-28T00:00:00.000Z";
const header = (id: string) => ({ type: "session", version: 3, id, timestamp: T, cwd });
/** 150 turns of ~8 KB, every 10th with a tool call and its result, and an /explain row early on;
    `turn` may add entries at the end of a turn. */
function bigSession(name: string, extra: (lines: unknown[]) => void = () => {}, turn: (i: number, push: (e: Record<string, unknown>) => void) => void = () => {}): string {
  const path = canonicalPath(join(sessionsDir, `2026-09-28T00-00-00-000Z_${name}.jsonl`));
  const lines: unknown[] = [header(name)];
  let parent: string | null = null;
  const push = (e: Record<string, unknown>) => {
    lines.push({ ...e, parentId: parent, timestamp: T });
    parent = e.id as string;
  };
  for (let i = 0; i < 150; i++) {
    push({ type: "message", id: `u${i}`, message: { role: "user", content: [{ type: "text", text: `ask ${i} ${"q".repeat(4000)}` }], timestamp: 0 } });
    if (i === 3) push({ type: "custom", id: "ex1", customType: "explain-doc", data: { id: "X1", topic: "why", summary: "done", createdAt: T } });
    if (i % 10 === 5) {
      push({ type: "message", id: `c${i}`, message: { role: "assistant", content: [{ type: "toolCall", id: `t${i}`, name: "bash", arguments: { command: "ls" } }], stopReason: "toolUse", timestamp: 0 } });
      push({ type: "message", id: `r${i}`, message: { role: "toolResult", toolCallId: `t${i}`, toolName: "bash", content: [{ type: "text", text: "out ".repeat(500) }], isError: false, timestamp: 0 } });
    }
    push({
      type: "message",
      id: `a${i}`,
      message: { role: "assistant", content: [{ type: "text", text: `answer ${i} ${"a".repeat(4000)}` }], provider: "anthropic", model: "m", api: "anthropic-messages", stopReason: "stop", timestamp: 0 },
    });
    turn(i, push);
  }
  extra(lines);
  writeFileSync(path, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  return path;
}
const wholeOf = (path: string) => normalizeEntries(activeBranch(parseLines(readFileSync(path, "utf8"))));

async function get(path: string, params: Record<string, string>): Promise<{ status: number; body: any }> {
  const qs = new URLSearchParams({ path, ...params }).toString();
  const res = await app.request(`/api/transcript?${qs}`);
  return { status: res.status, body: await res.json() };
}

/** Everything the REST rows give, a tail and then chunks up to the top. */
async function fetchAll(path: string): Promise<{ tail: TranscriptRows; chunks: TranscriptRows[]; list: TranscriptItem[] }> {
  const tail = (await get(path, { tail: "1" })).body as TranscriptRows;
  let list = tail.items;
  let older = tail.older;
  const chunks: TranscriptRows[] = [];
  while (older > 0) {
    const r = (await get(path, { before: list[0]!.id })).body as TranscriptRows;
    assert.equal(r.older + r.items.length, older, "each chunk ends right above the list");
    chunks.push(r);
    list = [...r.items, ...list];
    older = r.older;
  }
  return { tail, chunks, list };
}

// ---- The sockets --------------------------------------------------------------------------

async function frames(route: string, until: (got: string[]) => boolean, headers: Record<string, string> = {}, quietMs = 300, onFirst?: () => void): Promise<string[]> {
  const ws = new WebSocket(`${wsBase}${route}`, { headers: { ...AUTH, ...headers } });
  const got: string[] = [];
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out; got ${got.map((g) => JSON.parse(g).type).join(",")}`)), 15_000);
    ws.on("message", (data) => {
      got.push(data.toString());
      if (got.length === 1) onFirst?.();
      if (until(got)) {
        clearTimeout(timer);
        resolve();
      }
    });
    ws.on("error", reject);
  });
  await new Promise((r) => setTimeout(r, quietMs)); // anything else on its way
  closing.push(new Promise((r) => ws.once("close", () => r())));
  ws.close();
  return got;
}
const types = (got: string[]) => got.map((g) => JSON.parse(g).type as string);

describe("/ws/chat?tail=rest", () => {
  const path = bigSession("chat1");
  const q = `path=${encodeURIComponent(path)}&force=1`;
  const whole = wholeOf(path);

  test("the newest rows, a summary of the rest, prefetch for a direct local client, and no history", async () => {
    const got = await frames(`/ws/chat?${q}&tail=rest`, (g) => types(g).includes("mode"));
    assert.ok(!types(got).includes("history"), types(got).join(","));
    const hello = JSON.parse(got[0]!);
    assert.equal(hello.type, "hello");
    assert.ok(hello.older > 0);
    assert.deepEqual(hello.items, whole.slice(hello.older));
    assert.deepEqual(hello.olderSummary, summarize(whole.slice(0, hello.older)));
    assert.equal(hello.prefetch, true);
  });

  test("through a proxy (X-Forwarded-Host): no prefetch", async () => {
    const got = await frames(`/ws/chat?${q}&tail=rest`, (g) => types(g).includes("mode"), { "X-Forwarded-Host": "example.test" });
    const hello = JSON.parse(got[0]!);
    assert.ok(hello.older > 0 && hello.olderSummary);
    assert.equal("prefetch" in hello, false);
  });

  test("the runtime's hello and the file's rows concatenate to the legacy hello", async () => {
    const legacy = JSON.parse((await frames(`/ws/chat?${q}`, (g) => g.length >= 1, {}, 50))[0]!);
    const hello = JSON.parse((await frames(`/ws/chat?${q}&tail=rest`, (g) => g.length >= 1, {}, 50))[0]!);
    let list: TranscriptItem[] = hello.items;
    let older: number = hello.older;
    while (older > 0) {
      const r = (await get(path, { before: list[0]!.id, leaf: list.at(-1)!.id.split(":")[0]! })).body as TranscriptRows;
      list = [...r.items, ...list];
      older = r.older;
    }
    assert.deepEqual(list, legacy.items);
  });
});

describe("chat: a rewind with a pull client, a push client and a whole client", () => {
  test("the pull client gets a cut hello with its summary and nothing after its ack; the push client its history", async () => {
    const path = bigSession("chat2");
    const chat = await acquireChat(path, true);
    const pull: any[] = [];
    const push: any[] = [];
    const legacy: any[] = [];
    const p = { send: (m: any) => void pull.push(m), tail: true, pull: { prefetch: false } };
    chat.attach(p);
    chat.attach({ send: (m: any) => void push.push(m), tail: true });
    chat.attach({ send: (m: any) => void legacy.push(m) });
    assert.equal(pull.filter((m) => m.type === "history").length, 0);
    assert.ok(push.at(-1).type === "history" && push.at(-1).left === 0);
    for (const l of [pull, push, legacy]) l.length = 0;
    chat.handle(p, { type: "rewind", id: "r1", entryId: "u140" });
    for (let i = 0; i < 100 && !pull.some((m) => m.type === "rewound" || m.type === "rewind_refused"); i++) await new Promise((r) => setTimeout(r, 20));
    const branch = normalizeEntries(piSession(chat).sessionManager.getBranch());
    const ph = pull.find((m) => m.type === "hello");
    assert.ok(ph.older > 0);
    assert.deepEqual(ph.items, branch.slice(ph.older));
    assert.deepEqual(ph.olderSummary, summarize(branch.slice(0, ph.older)));
    assert.equal(ph.prefetch, undefined);
    assert.equal(pull.filter((m) => m.type === "history").length, 0);
    assert.ok(pull.some((m) => m.type === "rewound"));
    const hh = push.find((m) => m.type === "hello");
    assert.equal(hh.olderSummary, undefined, "a push client's hello is as before");
    assert.deepEqual(push.filter((m) => m.type === "history").reduce((l: TranscriptItem[], c: any) => [...c.items, ...l], hh.items), branch);
    const lh = legacy.find((m) => m.type === "hello");
    assert.deepEqual(lh.items, branch);
    assert.equal(lh.older, undefined);
  });
});

describe("/ws/watch?tail=rest", () => {
  test("a cut snapshot with its summary, no history, and an append comes straight after it", async () => {
    const path = bigSession("watch1");
    const whole = wholeOf(path);
    const got = await frames(`/ws/watch?path=${encodeURIComponent(path)}&tail=rest`, (g) => types(g).includes("append"), {}, 100, () => {
      const extra = { type: "message", id: "late", parentId: "a149", timestamp: T, message: { role: "user", content: [{ type: "text", text: "late" }], timestamp: 0 } };
      writeFileSync(path, readFileSync(path, "utf8") + JSON.stringify(extra) + "\n");
    });
    assert.deepEqual(types(got), ["snapshot", "append"]);
    const snap = JSON.parse(got[0]!);
    assert.ok(snap.older > 0);
    assert.deepEqual(snap.items, whole.slice(snap.older));
    assert.deepEqual(snap.olderSummary, summarize(whole.slice(0, snap.older)));
    assert.equal(snap.prefetch, true);
  });
});
