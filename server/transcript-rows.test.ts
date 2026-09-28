// Run: pnpm exec tsx --test server/transcript-rows.test.ts. Older rows on demand: `?tail=rest` on
// both sockets (the newest rows, a summary of the rest, nothing pushed) and GET /api/transcript's
// rows (server/transcript-rows.ts): chunks, ranges and the moved/missing answers, put back together
// against the whole branch. A throwaway PI_CODING_AGENT_DIR in the OS temp dir and an ephemeral
// loopback port; ~/.pi untouched.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import WebSocket from "ws";
import type { TranscriptItem, TranscriptRows } from "../shared/protocol";

const agentDir = realpathSync(mkdtempSync(join(tmpdir(), "sova-rows-")));
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.PORT = "0";
const sessionsDir = join(agentDir, "sessions", "--tmp-rows--");
mkdirSync(sessionsDir, { recursive: true });
mkdirSync(join(agentDir, "sessions", "live"), { recursive: true });
const cwd = join(agentDir, "cwd");
mkdirSync(cwd, { recursive: true });

const { app, server } = await import("./index");
const { chunkStart, rangeStart, tailStart } = await import("./tail-hello");
const { activeBranch, normalizeEntries, parseLines } = await import("./transcript");
const { summarize, isInput } = await import("../shared/row-counts");
const { acquireChat, disposeAllChats } = await import("./chat-manager");
const { canonicalPath } = await import("./paths");
if (!server.listening) await new Promise((r) => server.once("listening", r));
const wsBase = `ws://127.0.0.1:${(server.address() as AddressInfo).port}`;

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
/** 150 turns of ~8 KB, every 10th with a tool call and its result, and an /explain row early on. */
function bigSession(name: string, extra: (lines: unknown[]) => void = () => {}): string {
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

describe("GET /api/transcript rows", () => {
  const path = bigSession("rest1");
  const whole = wholeOf(path);

  test("without the new parameters: the whole branch and its context, as before", async () => {
    const r = await get(path, {});
    assert.equal(r.status, 200);
    assert.deepEqual(Object.keys(r.body), ["items", "context"]);
    assert.deepEqual(r.body.items, whole);
  });

  test("the tail, then chunks before the first row until older is 0, put back together are the whole branch", async () => {
    const { tail, chunks, list } = await fetchAll(path);
    assert.ok(tail.older > 0 && chunks.length > 1, `${chunks.length} chunks`);
    assert.deepEqual(list, whole);
    assert.ok("context" in tail);
    for (const c of chunks) {
      assert.ok(!("context" in c));
      assert.notEqual(c.items[0]!.kind, "tool-result", "a chunk never opens on a tool result");
      assert.ok(JSON.stringify(c.items).length <= 256 * 1024 + 9000, "about 256 KB");
    }
    // The tail is the hello's cut, exactly.
    const sizes = whole.map((it) => JSON.stringify(it).length);
    assert.equal(tail.older, tailStart(whole, sizes));
  });

  test("each answer sums up the rows before it: those counts plus the list's are the whole branch's", async () => {
    const { tail, chunks } = await fetchAll(path);
    for (const r of [tail, ...chunks]) {
      assert.deepEqual(r.olderSummary, summarize(whole.slice(0, r.older)));
      assert.equal(r.olderSummary.inputs.length + whole.slice(r.older).filter(isInput).length, whole.filter(isInput).length);
    }
    assert.deepEqual(chunks.at(-1)!.olderSummary, { inputs: [], messages: 0, replies: false });
  });

  test("a range down to the oldest input, in one request, reaches the top and concatenates", async () => {
    const tail = (await get(path, { tail: "1" })).body as TranscriptRows;
    const r = await get(path, { before: tail.items[0]!.id, from: "u0" });
    assert.equal(r.status, 200);
    assert.equal(r.body.older, 0);
    assert.deepEqual([...r.body.items, ...tail.items], whole);
  });

  test("a range to a tool result starts at its call; to an explanation by its id; a block id finds its entry", async () => {
    const tail = (await get(path, { tail: "1" })).body as TranscriptRows;
    const before = tail.items[0]!.id;
    const toResult = await get(path, { before, from: "r15" });
    assert.equal(toResult.body.items[0].id.split(":")[0], "c15");
    assert.deepEqual([...toResult.body.items, ...tail.items], whole.slice(toResult.body.older));
    const ex = await get(path, { before, explain: "X1" });
    assert.ok(ex.body.items.some((it: TranscriptItem) => it.report?.explain?.id === "X1"));
    assert.deepEqual([...ex.body.items, ...tail.items], whole.slice(ex.body.older));
    const block = await get(path, { before, from: "a2:7" });
    assert.equal(block.body.items[0].id.split(":")[0], "a2");
    // Already held: nothing to send.
    const held = await get(path, { before, from: tail.items.at(-1)!.id });
    assert.deepEqual(held.body.items, []);
    assert.equal(held.body.older, tail.older);
  });

  test("from alone: that row to the end (a view refreshing what it holds)", async () => {
    const r = await get(path, { from: whole[100]!.id });
    assert.deepEqual(r.body.items, whole.slice(r.body.older));
    assert.ok(r.body.older <= 100);
  });

  test("a target not on the branch is missing; a moved branch is 409", async () => {
    const missing = await get(path, { before: whole.at(-1)!.id, from: "nope" });
    assert.equal(missing.status, 404);
    assert.equal(missing.body.code, "missing");
    const noRow = await get(path, { before: "gone" });
    assert.equal(noRow.status, 409);
    assert.equal(noRow.body.code, "moved");
    // An unknown leaf (not written yet) is no proof of a move.
    assert.equal((await get(path, { before: whole.at(-1)!.id, leaf: "not-yet-written" })).status, 200);
  });

  test("a rewind: the old leaf, still in the file but off the branch, answers moved", async () => {
    const forked = bigSession("rest2", (lines) => {
      // A new branch off a100: the file's last entry is its leaf, so a149 is off the branch now.
      lines.push({ type: "message", id: "x1", parentId: "a100", timestamp: T, message: { role: "user", content: [{ type: "text", text: "again" }], timestamp: 0 } });
    });
    const r = await get(forked, { before: "u120", leaf: "a149" });
    assert.equal(r.status, 409);
    assert.equal(r.body.code, "moved");
    const ok = await get(forked, { before: "u90", leaf: "x1" });
    assert.equal(ok.status, 200);
    const ends = wholeOf(forked);
    assert.equal(ends.at(-1)!.id, "x1");
  });

  // The property on real sessions, as tail-hello's: chunks from the hello's cut up, and a range to
  // every 97th row, put back together are the whole branch.
  const copies = join(homedir(), ".cache", "sova-vscroll", "sessions");
  const files = existsSync(copies) ? readdirSync(copies).filter((f) => f.endsWith(".jsonl")) : [];
  test(`chunks and ranges concatenate on ${files.length} session copies`, { skip: files.length === 0 && "no session copies" }, () => {
    for (const f of files) {
      const items = normalizeEntries(activeBranch(parseLines(readFileSync(join(copies, f), "utf8"))));
      const sizes = items.map((it) => JSON.stringify(it).length);
      const seam = tailStart(items, sizes);
      let end = seam;
      let list = items.slice(seam);
      while (end > 0) {
        const s = chunkStart(items, sizes, end);
        assert.ok(s < end, f);
        list = [...items.slice(s, end), ...list];
        end = s;
      }
      assert.deepEqual(list, items, f);
      for (let t = 0; t < seam; t += 97) {
        const s = rangeStart(items, t);
        assert.ok(s <= t, f);
        if (s > 0) assert.notEqual(items[s]!.kind, "tool-result", f);
      }
    }
  });
});

// ---- The sockets --------------------------------------------------------------------------

async function frames(route: string, until: (got: string[]) => boolean, headers: Record<string, string> = {}, quietMs = 300, onFirst?: () => void): Promise<string[]> {
  const ws = new WebSocket(`${wsBase}${route}`, { headers });
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
    const branch = normalizeEntries(chat.session.sessionManager.getBranch());
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
