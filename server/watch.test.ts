// /ws/watch on wire 2 (server/watch.ts SessionTail): an assistant reply's first row carries its
// measured timing (`reply`, server/reply-facts.ts) in the snapshot, its history and its appends, as on
// REST and /ws/chat; a reply written while watched gets it from a fresh ask; wire 1 never does.
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import type { ReplyTiming } from "../shared/harness-wire";
import type { TranscriptItem, WatchServerMessage } from "../shared/protocol";
import { replyTimingsOf, sessionIdOfPath, setReplyTimingsSource } from "./reply-facts";
import { scratchRoot } from "./test-scratch";
import { SessionTail } from "./watch";

const root = scratchRoot("watch-reply-");
after(() => rmSync(root, { recursive: true, force: true }));

const timing = (ms: number): ReplyTiming => ({ effort: "high", ttftMs: ms, thinkingMs: 0, replyMs: 3000, output: 640 });
const at = (n: number) => new Date(Date.UTC(2026, 9, 13, 10, 0, n)).toISOString();
const user = (id: string, parentId: string | null, n: number) =>
  ({ type: "message", id, parentId, timestamp: at(n), message: { role: "user", content: [{ type: "text", text: `question ${n}` }], timestamp: n } });
const reply = (id: string, parentId: string, n: number) => ({
  type: "message",
  id,
  parentId,
  timestamp: at(n),
  message: { role: "assistant", content: [{ type: "text", text: `answer ${n}` }], provider: "zai", model: "glm-5.3", usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 }, stopReason: "stop", timestamp: n },
});

/** A session of 100 exchanges: enough rows that a tail-first snapshot leaves the oldest to history. */
function session(name: string): { path: string; last: string } {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `2026-10-13T10-00-00-000Z_${name}.jsonl`);
  const lines: unknown[] = [{ type: "session", version: 3, id: name, timestamp: at(0), cwd: dir }];
  let parent: string | null = null;
  for (let i = 0; i < 100; i++) {
    lines.push(user(`u${i}`, parent, i * 2));
    lines.push(reply(`a${i}`, `u${i}`, i * 2 + 1));
    parent = `a${i}`;
  }
  writeFileSync(path, `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`);
  return { path, last: parent! };
}

const replyOf = (items: TranscriptItem[], entry: string) => items.find((it) => it.id === `${entry}:0`);

test("wire 2: a measured reply's row carries its timing in the snapshot, the history and an append", async () => {
  const { path, last } = session("s-wire2");
  const sid = sessionIdOfPath(path);
  // The store: the oldest reply and the newest measured at load; a99's successor only once written.
  const store: Record<string, ReplyTiming> = { a0: timing(100), a99: timing(199) };
  const asked: string[] = [];
  setReplyTimingsSource(async (s) => (asked.push(s), s === sid ? { v: String(Object.keys(store).length), timings: { ...store } } : null));
  try {
    const got: WatchServerMessage[] = [];
    const raw: { type: string; items: TranscriptItem[] }[] = [];
    const tail = new SessionTail(path, (m) => void got.push(JSON.parse(JSON.stringify(m))), undefined, undefined, (json) => void raw.push(JSON.parse(json)), undefined, 2, () =>
      replyTimingsOf(sid),
    );
    const t = tail as unknown as { snapshot(): Promise<void>; readNew(): Promise<void> };
    await t.snapshot();
    const snap = got[0] as Extract<WatchServerMessage, { type: "snapshot" }>;
    assert.equal(snap.type, "snapshot");
    assert.ok((snap.older ?? 0) > 0, "the snapshot is cut");
    assert.deepEqual(replyOf(snap.items, "a99")?.facts?.reply, timing(199), "snapshot");
    assert.equal(replyOf(snap.items, "a98")?.facts?.reply, undefined, "an unmeasured reply carries none");
    const history = raw.flatMap((m) => m.items);
    assert.deepEqual(replyOf(history, "a0")?.facts?.reply, timing(100), "history");
    assert.equal(asked.length, 1, "one ask for the snapshot");

    // A reply finishes while watched: its chat writes its timing as it writes the entry.
    store.a100 = timing(300);
    appendFileSync(path, `${JSON.stringify(user("u100", last, 200))}\n${JSON.stringify(reply("a100", "u100", 201))}\n`);
    await t.readNew();
    const ap = got.at(-1) as Extract<WatchServerMessage, { type: "append" }>;
    assert.equal(ap.type, "append");
    assert.deepEqual(replyOf(ap.items, "a100")?.facts?.reply, timing(300), "append");
    assert.equal(asked.length, 2, "asked again for the reply it had no timing for");

    // A user message alone asks nothing.
    appendFileSync(path, `${JSON.stringify(user("u101", "a100", 202))}\n`);
    await t.readNew();
    assert.equal(asked.length, 2);
    tail.close();
  } finally {
    setReplyTimingsSource(null);
  }
});

test("wire 1 carries no timing and asks nothing; a failed ask leaves the rows as they were", async () => {
  const { path } = session("s-wire1");
  let asks = 0;
  setReplyTimingsSource(async () => (asks++, { v: "1", timings: { a99: timing(1) } }));
  try {
    const got: WatchServerMessage[] = [];
    const tail = new SessionTail(path, (m) => void got.push(m), undefined, undefined, undefined, undefined, 1, () => replyTimingsOf(sessionIdOfPath(path)));
    await (tail as unknown as { snapshot(): Promise<void> }).snapshot();
    const snap = got[0] as Extract<WatchServerMessage, { type: "snapshot" }>;
    assert.equal(asks, 0);
    assert.equal("facts" in replyOf(snap.items, "a99")!, false);
    tail.close();

    setReplyTimingsSource(async () => {
      throw new Error("down");
    });
    const got2: WatchServerMessage[] = [];
    const tail2 = new SessionTail(path, (m) => void got2.push(m), undefined, undefined, undefined, undefined, 2, () => replyTimingsOf(sessionIdOfPath(path)));
    await (tail2 as unknown as { snapshot(): Promise<void> }).snapshot();
    const snap2 = got2[0] as Extract<WatchServerMessage, { type: "snapshot" }>;
    assert.equal(snap2.items.length > 0, true);
    assert.equal(replyOf(snap2.items, "a99")?.facts?.reply, undefined);
    tail2.close();
  } finally {
    setReplyTimingsSource(null);
  }
});
