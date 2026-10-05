// Run: pnpm exec tsx --test server/tail-hello.test.ts. Newest rows first over the wire
// (server/tail-hello.ts): the cut itself, and both sockets end to end, with and without `?tail=1`.
// A throwaway PI_CODING_AGENT_DIR in the OS temp dir and an ephemeral loopback port; ~/.pi untouched.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import WebSocket from "ws";
import type { AlignDocInfo, TranscriptItem } from "../shared/protocol";

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

describe("tailStart", () => {
  test("an empty list, and a list shorter than the tail, are whole", () => {
    assert.equal(tailStart([], []), 0);
    const items = Array.from({ length: 10 }, (_, i) => row(`e${i}`));
    assert.equal(tailStart(items, sizesOf(items)), 0);
  });

  test("whole entries only: a cut never falls between a reply's blocks", () => {
    // 30 entries of 3 blocks each; a 60-row minimum lands on an entry start, never mid-entry.
    const items: TranscriptItem[] = [];
    for (let e = 0; e < 30; e++) for (let b = 0; b < 3; b++) items.push(row(`a${e}:${b}`, "assistant-text"));
    for (const min of [1, 2, 4, 59, 60, 61]) {
      const s = tailStart(items, sizesOf(items), min);
      assert.equal(s % 3, 0, `min ${min} cut at ${s}`);
      assert.ok(items.length - s >= Math.min(min, items.length), `min ${min}`);
    }
  });

  test("the size budget stops the walk back, but the newest entry is always in", () => {
    const big = "y".repeat(1000);
    const items = Array.from({ length: 100 }, (_, i) => row(`e${i}`, "user", big));
    const sizes = sizesOf(items);
    const s = tailStart(items, sizes, 60, 5 * sizes[99]!);
    assert.equal(items.length - s, 5);
    // A newest entry bigger than the whole budget is still the tail.
    assert.equal(tailStart(items, sizes, 60, 10), 99);
  });

  test("a tail never opens on a tool result: it starts at the next entry", () => {
    const items = [row("u1"), row("c1:0", "tool-call"), row("r1", "tool-result"), row("u2"), row("a2:0", "assistant-text")];
    // min 3 would start at c1's result (index 2): moved forward to u2.
    assert.equal(tailStart(items, sizesOf(items), 3), 3);
    // Nothing after the result: it takes its call too rather than an empty tail.
    const tailOnly = [row("u1"), row("c1:0", "tool-call"), row("r1", "tool-result")];
    assert.equal(tailStart(tailOnly, sizesOf(tailOnly), 1), 1);
  });

  test("a tail that opens inside a baton wrap-up starts at the wrap-up's start mark", () => {
    const start = row("w1", "info", "Wrap-up started", { batonMark: { kind: "wrapup", phase: "start" } } as Partial<TranscriptItem>);
    const items = [row("u0"), start, row("u1"), row("a1:0", "assistant-text"), row("a1:1", "assistant-text")];
    assert.equal(tailStart(items, sizesOf(items), 2), 1);
    // After an end mark, nothing is extended.
    const end = row("w2", "info", "Wrap-up: 0", { batonMark: { kind: "wrapup", phase: "end", applied: [], refused: [] } } as Partial<TranscriptItem>);
    const closed = [row("u0"), start, row("u1"), end, row("u2"), row("a2:0", "assistant-text")];
    assert.equal(tailStart(closed, sizesOf(closed), 2), 4);
  });

  test("v1 rows without entry ids (`line<i>`) are each their own entry", () => {
    const items = Array.from({ length: 80 }, (_, i) => row(`line${i}`));
    assert.equal(tailStart(items, sizesOf(items)), 20);
  });
});

describe("historyRanges", () => {
  test("newest first, contiguous, each within the budget unless it is one row", () => {
    const sizes = [5, 5, 50, 5, 5, 5, 5, 5];
    const ranges = historyRanges(sizes, 8, 12);
    assert.deepEqual(ranges, [[6, 8], [4, 6], [3, 4], [2, 3], [0, 2]]);
    assert.deepEqual(historyRanges(sizes, 0, 12), []);
  });
});

describe("pullFields: the alignments open above the cut", () => {
  const doc = (id: string, rev: number, phase: AlignDocInfo["phase"] = "open"): AlignDocInfo => ({
    id, title: id, summary: "", findings: [], approach: [], rejected: [], questions: [], phase,
    next: { f: 1, a: 1, x: 1, q: 1 }, rev, createdAt: "", updatedAt: "",
  });
  const align = (id: string, d: AlignDocInfo) => row(id, "align", "", { align: { v: 1, doc: d, changes: [], line: "" } });

  test("each alignment's newest revision above the cut, last touched last; done and dropped ones absent; none below it", () => {
    const items = [
      row("u1"),
      align("a1", doc("al_1", 1)),
      align("a2", doc("al_2", 1)),
      align("a3", doc("al_3", 1)),
      align("a4", doc("al_1", 2)),
      align("a5", doc("al_3", 2, "dropped")),
      align("a6", doc("al_4", 1)),
      align("a7", doc("al_4", 2, "done")),
      row("u2"),
      align("a8", doc("al_5", 1)), // below the cut: the list's own
      row("u3"),
    ];
    const { olderSummary } = pullFields(items, 9, false);
    assert.deepEqual(olderSummary.aligns?.map((a) => [a.doc.id, a.doc.rev, a.rowId]), [["al_2", 1, "a2"], ["al_1", 2, "a4"]]);
    assert.deepEqual(olderSummary.inputs, ["u1", "u2"]);
  });

  test("no open alignment above the cut: no key at all, the summary as before", () => {
    assert.deepEqual(pullFields([row("u1"), row("a1:0", "assistant-text"), row("u2")], 2, false).olderSummary, { inputs: ["u1"], messages: 2, replies: true });
    const closed = pullFields([align("a1", doc("al_1", 1)), align("a2", doc("al_1", 2, "done")), row("u2")], 2, false).olderSummary;
    assert.equal("aligns" in closed, false);
  });
});

describe("cutTail", () => {
  test("each history message's JSON is exactly JSON.stringify of its object; `left` counts down to 0", () => {
    const items = Array.from({ length: 400 }, (_, i) => row(`e${i}`, i % 2 ? "assistant-text" : "user", "z".repeat(2000 + (i % 7) * 300)));
    const cut = cutTail(items);
    assert.ok(cut.older > 0 && cut.history.length > 1);
    for (const part of cut.history) assert.equal(part.raw, JSON.stringify(part.msg));
    assert.deepEqual(cut.history.map((p) => p.msg.left), cut.history.map((p) => p.msg.left).sort((a, b) => b - a));
    assert.equal(cut.history.at(-1)!.msg.left, 0);
    assert.equal(cut.history.reduce((n, p) => n + p.msg.items.length, 0), cut.older);
    for (const p of cut.history) assert.ok(p.raw.length <= HISTORY_CHUNK_CHARS + 64 || p.msg.items.length === 1);
    assert.ok(JSON.stringify(cut.items).length <= TAIL_CHARS + 64);
    assert.deepEqual(reassemble(cut), items);
  });

  test("a short list is not cut: same array, no history", () => {
    const items = [row("u1"), row("a1:0", "assistant-text")];
    const cut = cutTail(items);
    assert.equal(cut.items, items);
    assert.equal(cut.older, 0);
    assert.deepEqual(cut.history, []);
  });

  // The property that can't pass by accident: the rows, put back together, are the rows a whole
  // hello carries, on every real session copy there is and on a synthetic branch whose
  // whole-branch rules (newest align doc, newest explain run, running model) straddle the seam.
  const copies = join(homedir(), ".cache", "sova-vscroll", "sessions");
  const files = existsSync(copies) ? readdirSync(copies).filter((f) => f.endsWith(".jsonl")) : [];
  test(`tail + history == normalizeEntries(branch) on ${files.length} session copies`, { skip: files.length === 0 && "no session copies" }, () => {
    for (const f of files) {
      const items = normalizeEntries(activeBranch(parseLines(readFileSync(join(copies, f), "utf8"))));
      const cut = cutTail(items);
      assert.deepEqual(reassemble(cut), items, f);
      assert.ok(cut.items.length > 0 || items.length === 0, f);
      if (cut.older > 0) assert.notEqual(cut.items[0]!.kind, "tool-result", f);
    }
  });

  test("synthetic branch: align docs, explain reruns and a model change across the seam", () => {
    const entries: any[] = [{ type: "model_change", id: "m0", parentId: null, provider: "p", modelId: "one" }];
    let parent = "m0";
    const push = (e: any) => {
      entries.push({ ...e, parentId: parent, timestamp: "2026-09-28T00:00:00.000Z" });
      parent = e.id;
    };
    const align = (title: string) => ({ version: 1, doc: { title, markdown: `# ${title}`, questions: [] } });
    const explain = (status?: string) => ({ id: "X", topic: "why", summary: status ? "" : "done", createdAt: "2026-09-28T00:00:00.000Z", ...(status ? { status } : {}) });
    push({ type: "custom", id: "al1", customType: "align-doc", data: align("old") });
    push({ type: "custom", id: "ex1", customType: "explain-doc", data: explain("running") });
    for (let i = 0; i < 200; i++) {
      push({ type: "message", id: `u${i}`, message: { role: "user", content: [{ type: "text", text: "q".repeat(3000) }] } });
      push({ type: "message", id: `a${i}`, message: { role: "assistant", content: [{ type: "text", text: "a".repeat(3000) }, { type: "text", text: "b" }], stopReason: "stop" } });
      if (i === 100) push({ type: "model_change", id: "m1", provider: "p", modelId: "two" });
    }
    push({ type: "custom", id: "al2", customType: "align-doc", data: align("new") });
    push({ type: "custom", id: "ex2", customType: "explain-doc", data: explain() });
    const items = normalizeEntries(entries);
    // The rules did straddle the seam: one align row (the newest), one explain row (the settled
    // run), and rows on both sides of the model change.
    assert.deepEqual(items.filter((i) => i.kind === "report").map((i) => i.id), ["al2", "ex2"]);
    assert.ok(items.some((i) => i.model === "p/one") && items.some((i) => i.model === "p/two"));
    const cut = cutTail(items);
    assert.ok(cut.older > 0);
    assert.deepEqual(reassemble(cut), items);
  });
});

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
    const got = await frames(`/ws/chat?${q}`, (g) => types(g).includes("mode"));
    await new Promise((r) => setTimeout(r, 100)); // nothing else is on its way
    assert.deepEqual(types(got), ["hello", "commands", "queue", "mode"]);
    const hello = JSON.parse(got[0]!);
    assert.deepEqual(Object.keys(hello), ["type", "items", "isStreaming", "isCompacting", "model", "thinking", "context"]);
    assert.deepEqual(hello.items, whole);
    // Byte for byte what the per-client stringify always sent for that object.
    assert.equal(got[0], JSON.stringify(hello));
  });

  test("with ?tail=1: a cut hello first, the state after it, then the history, newest first", async () => {
    const got = await frames(`/ws/chat?${q}&tail=1`, (g) => g.length > 0 && JSON.parse(g.at(-1)!).left === 0);
    const t = types(got);
    const firstHistory = t.indexOf("history");
    assert.deepEqual(t.slice(0, firstHistory), ["hello", "commands", "queue", "mode"]);
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
    for (let i = 0; i < 100 && !tail.some((m) => m.type === "rewound" || m.type === "rewind_refused"); i++) await new Promise((r) => setTimeout(r, 20));
    const tt = tail.map((m) => m.type);
    assert.equal(tt[0], "hello");
    assert.ok(tail[0].older > 0);
    const ack = tt.indexOf("rewound");
    assert.ok(ack > 0, tt.join(","));
    assert.ok(tt.slice(ack + 1).length > 0 && tt.slice(ack + 1).every((x) => x === "history"), tt.join(","));
    assert.ok(!tt.slice(0, ack).includes("history"));
    const branch = normalizeEntries(chat.session.sessionManager.getBranch());
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
