// One chat's memory engine (§chat.memory/log, /tree, /turn, /recall, /preparing, /zoomable) with a fake
// summarizer: no model call, no process. Files only under a temp dir.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import type { HEntry } from "../../shared/harness";
import { readMemoryView } from "../../pi-config/extensions/claude-code/provider/memory-view.ts";
import { MemoryEngine, WAIT_MS, type EngineDeps } from "./engine";
import { inputStart, messagesBefore, messagesOf, PAGE, TOOL_CLIP } from "./log";
import { copyMemory, MemoryStore, memoryDir, removeMemory } from "./store";
import type { SummaryCall } from "./summarizer";

const root = mkdtempSync(join(tmpdir(), "sova-memory-engine-"));
after(() => rmSync(root, { recursive: true, force: true }));
let n = 0;

let id = 0;
const at = "2026-10-10T10:00:00.000Z";
const user = (text: string, eid = `u${++id}`): HEntry => ({ id: eid, parentId: null, at, kind: "user", blocks: [{ type: "text", text }] });
const reply = (text: string, eid = `a${++id}`): HEntry => ({ id: eid, parentId: null, at, kind: "assistant", blocks: [{ type: "thinking", thinking: "secret" }, { type: "text", text }] });
const call = (name: string, args: unknown, eid = `c${++id}`): HEntry => ({ id: eid, parentId: null, at, kind: "assistant", blocks: [{ type: "toolCall", id: `t${id}`, name, arguments: args }] });
const result = (tool: string, text: string, eid = `r${++id}`): HEntry => ({ id: eid, parentId: null, at, kind: "tool-result", tool, blocks: [{ type: "text", text }] });
const note = (text: string, display: boolean, eid = `n${++id}`): HEntry => ({ id: eid, parentId: null, kind: "note", noteType: "x", content: text, display, inMessage: true });

function engine(over: Partial<EngineDeps> = {}) {
  const calls: SummaryCall[] = [];
  const dir = join(root, `s${++n}`);
  const deps: EngineDeps = {
    summarize: async (c) => {
      calls.push(c);
      return { text: `summary of ${/message (\d+)|lines (\d+)\+(\d+)/.exec(c.prompt)?.[0] ?? "?"}. More detail here that is cut.`, model: "fake" };
    },
    waitMs: 2000,
    ...over,
  };
  return { e: new MemoryEngine(`s${n}`, new MemoryStore(dir), deps), calls, dir, deps };
}

const long = (tag: string) => `${tag} ${"word ".repeat(150)}`;

describe("the log", () => {
  test("kinds, no thoughts, hidden notes left out, long texts paged, tool output clipped", () => {
    const big = "x".repeat(TOOL_CLIP + 5000);
    const log = messagesOf([user("hi"), reply("hello"), call("bash", { command: "ls" }), result("bash", big), note("report", true), note("hidden", false), user("y".repeat(PAGE * 2 + 1))]);
    // The clipped output (30,000 characters) is still over a page: two messages, like any long text.
    assert.deepEqual(log.map((m) => m.kind), ["user", "sova", "tool", "echo", "echo", "work", "user", "user", "user"]);
    assert.doesNotMatch(log.map((m) => m.text).join(), /secret/);
    assert.equal(log[2]!.text, 'bash {"command":"ls"}');
    assert.ok(log[3]!.text.length + log[4]!.text.length < TOOL_CLIP + 100 && (log[3]!.text + log[4]!.text).includes("characters clipped"));
    assert.deepEqual(log.slice(6).map((m) => m.page), [{ index: 1, of: 3 }, { index: 2, of: 3 }, { index: 3, of: 3 }]);
    assert.deepEqual(log.map((m) => m.i), [0, 1, 2, 3, 4, 5, 6, 7, 8]);
  });

  test("a turn's input starts after the last reply or tool result", () => {
    const b = [user("a"), reply("b"), user("c"), note("worker done", true)];
    assert.equal(inputStart(b), 2);
    assert.equal(messagesBefore(b, inputStart(b)), 2);
    assert.equal(inputStart([user("only")]), 0);
  });
});

describe("the engine", () => {
  test("short messages are their own lines; long ones and long joins are summarized; merges follow", async () => {
    const { e, calls } = engine();
    const branch = [user("hi"), reply("hello"), user(long("first")), reply(long("second"))];
    e.sync(branch);
    await e.idle();
    assert.equal(e.get(0, 0)?.text, "user: hi");
    assert.equal(e.get(1, 0)?.text, "user: hi\nsova: hello", "two short lines join without a call");
    assert.match(e.get(0, 2)!.text, /^summary of message 2\./);
    assert.ok(e.get(1, 1) && e.get(2, 0), "merges are built as soon as both halves are");
    assert.equal(calls.filter((c) => c.prompt.includes("compress message")).length, 2);
    assert.ok(calls.every((c) => c.system.startsWith("You write the memory")), "the compaction guide is the system prompt");
    assert.ok(calls.every((c) => c.sessionId === e.sessionId));
  });

  test("a turn's view: every message before the turn, the turn's own message after it, split for the cache", async () => {
    const { e } = engine();
    const history = [user("hi"), reply("hello"), user("port is 4810"), reply("noted")];
    const turn = await e.turnView([...history, user("what port?")], 128);
    assert.ok(turn);
    assert.equal(turn.messages, 4, "the new message is not in the view");
    const parts = readMemoryView(turn.content);
    assert.ok(parts, "the declared memory-view shape");
    assert.match(parts.guide, /^# Memory\n/);
    assert.match(parts.prefix, /0\+1\|user: hi\n1\+1\|sova: hello\n2\+1\|user: port is 4810\n3\+1\|sova: noted\n<\/chat>$/);
    assert.equal(parts.tail, undefined);
    assert.equal(turn.rebased, true);
    // The next turn: the prefix is kept, the new lines are the tail.
    const next = await e.turnView([...history, user("what port?"), reply("4810"), user("thanks")], 128);
    const p2 = readMemoryView(next!.content)!;
    assert.equal(p2.prefix, parts.prefix, "the stable prefix is kept across turns");
    assert.match(p2.tail!, /4\+1\|user: what port\?\n5\+1\|sova: 4810\n<\/chat>$/);
    assert.equal(next!.rebased, false);
  });

  test("the prefix is saved: a new engine on the same files keeps it", async () => {
    const { e, dir, deps } = engine();
    const h = [user("a"), reply("b"), user("c")];
    const t1 = await e.turnView(h, 128);
    const again = new MemoryEngine(e.sessionId, new MemoryStore(dir), deps);
    const t2 = await again.turnView([...h, reply("d"), user("e")], 128);
    assert.equal(readMemoryView(t2!.content)!.prefix, readMemoryView(t1!.content)!.prefix);
    assert.equal(t2!.rebased, false);
  });

  test("the turn waits for the newest summaries, at most the wait, then goes on with placeholders", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { e } = engine({ summarize: async () => (await gate, { text: "late", model: "f" }), waitMs: 50 });
    const t = await e.turnView([user("hi"), reply(long("big reply")), user("next")], 128);
    assert.equal(t!.pending, 1);
    assert.match(readMemoryView(t!.content)!.tail ?? readMemoryView(t!.content)!.prefix, /1\+1\|\(not summarized yet: zoom it\)/);
    release();
    await e.idle();
  });

  test("a rewind drops every summary from the first changed message on, and the view with it", async () => {
    const { e, dir, deps } = engine();
    const base = [user("m0", "e0"), reply("m1", "e1"), user("m2", "e2"), reply("m3", "e3"), user("m4", "e4"), reply("m5", "e5")];
    await e.turnView([...base, user("go", "e6")], 128);
    await e.idle();
    assert.ok(e.get(2, 0) && e.get(0, 5));
    // A rewind to after e2, then a different message: messages 3.. differ.
    e.sync([...base.slice(0, 3), user("other", "x3")]);
    assert.ok(e.get(0, 2) && e.get(1, 0), "what still matches stays");
    await e.idle();
    assert.equal(e.get(0, 3)?.text, "user: other");
    assert.equal(e.get(2, 0)?.text, "user: m0\nsova: m1\nuser: m2\nuser: other", "a merge covering a changed message is built again");
    assert.equal(e.get(0, 4), undefined, "messages past the branch are gone");
    // The files agree: a new engine reads the same tree.
    const reread = new MemoryEngine(e.sessionId, new MemoryStore(dir), deps);
    reread.sync([...base.slice(0, 3), user("other", "x3")]);
    assert.equal(reread.get(0, 3)?.text, "user: other");
    assert.equal(reread.get(0, 4), undefined);
  });

  test("a fork copies its source's memory and keeps what matches its own branch", async () => {
    const { e, deps } = engine();
    const base = [user("m0", "f0"), reply("m1", "f1"), user("m2", "f2")];
    e.sync(base);
    await e.idle();
    copyMemory(e.sessionId, "fork-1", root);
    const fork = new MemoryEngine("fork-1", new MemoryStore(memoryDir("fork-1", root)), deps);
    fork.sync([...base.slice(0, 2), user("fork's own", "g2")]);
    assert.equal(fork.get(0, 1)?.text, "sova: m1");
    await fork.idle();
    assert.equal(fork.get(0, 2)?.text, "user: fork's own", "the source's message 2 was dropped and the fork's own built");
    removeMemory("fork-1", root);
    assert.equal(existsSync(memoryDir("fork-1", root)), false, "deleting the chat removes its memory");
  });

  test("zoom opens a line into its two halves, and a message whole; date gives its time", async () => {
    const { e } = engine();
    const b = [user("m0"), reply("m1"), user("m2"), reply("m3")];
    e.sync(b);
    await e.idle();
    assert.equal(e.zoom(0, 4), "0+2|user: m0 sova: m1\n2+2|user: m2 sova: m3");
    assert.equal(e.zoom(2, 1), "2|user: m2");
    assert.equal(e.date(3), at);
    assert.throws(() => e.zoom(1, 2), /power of 2 and id a multiple/);
    assert.throws(() => e.zoom(8, 1), /no message 8/);
    assert.deepEqual(e.open(0, 2), { lines: [{ id: 0, n: 1, text: "user: m0", entryId: b[0]!.id, lastEntryId: b[0]!.id }, { id: 1, n: 1, text: "sova: m1", entryId: b[1]!.id, lastEntryId: b[1]!.id }] });
  });

  test("turned on in a chat with history: preparing, turns go out without memory until the leaves are built", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const statuses: string[] = [];
    const { e } = engine({ summarize: async () => (await gate, { text: "s", model: "f" }), onStatus: (s) => statuses.push(s.state === "preparing" ? `preparing ${s.done}/${s.total}` : s.state) });
    const history = Array.from({ length: 40 }, (_, k) => (k % 2 ? reply(long(`r${k}`)) : user(long(`u${k}`))));
    e.sync(history);
    e.startPreparing();
    assert.match(statuses.at(-1)!, /^preparing 0\/40$/);
    assert.equal(await e.turnView([...history, user("next")], 128), undefined, "still preparing: no view");
    release();
    await e.idle();
    assert.equal(e.status().state, "ready");
    assert.ok(await e.turnView([...history, user("next")], 128));
  });

  test("the turn's wait is 20 s unless the deps say otherwise", () => {
    assert.equal(WAIT_MS, 20_000);
  });

  test("preparing counts up: n of m messages, then ready", async () => {
    const statuses: string[] = [];
    const { e } = engine({ onStatus: (s) => statuses.push(s.state === "preparing" ? `${s.done}/${s.total}` : s.state) });
    const history = Array.from({ length: 40 }, (_, k) => (k % 2 ? reply(long(`r${k}`)) : user(long(`u${k}`))));
    e.sync(history);
    e.startPreparing();
    await e.idle();
    const counts = statuses.filter((s) => s.includes("/")).map((s) => Number(s.split("/")[0]));
    assert.equal(statuses.find((s) => s.includes("/")), "0/40");
    assert.ok(counts.length > 2 && counts.every((c, k) => k === 0 || c >= counts[k - 1]!), `counts up: ${counts.join(" ")}`);
    assert.equal(statuses.at(-1), "ready");
  });

  test("a summarizer that can't run pauses the queue and says why", async () => {
    const { e } = engine({ summarize: async () => { throw new Error("no login"); } });
    e.sync([user(long("a")), user(long("b")), user(long("c")), user(long("d")), user(long("e"))]);
    await e.idle();
    const s = e.status();
    assert.equal(s.state, "ready");
    assert.match(s.problem ?? "", /no login/);
  });

  test("zoomable: a compaction's summary is the view of the compacted messages, merged to the size", async () => {
    const { e } = engine();
    const b = Array.from({ length: 64 }, (_, k) => (k % 2 ? reply(`r${k} ${"q".repeat(200)}`) : user(`u${k} ${"q".repeat(200)}`)));
    e.sync(b);
    await e.idle();
    const out = await e.compactionSummary(b, 48, 4);
    assert.ok(out);
    assert.equal(out.messages, 48);
    assert.match(out.summary, /^# Memory of the earlier conversation/);
    assert.match(out.summary, /zoom\(id, n\)/);
    assert.ok(Buffer.byteLength(out.summary) < 2 * 4 * 1024 + 2000);
    assert.equal(out.lines.reduce((s, [l]) => s + 2 ** l, 0), 48, "the lines cover exactly the compacted messages");
    assert.equal(await e.compactionSummary(b, 0, 4), undefined, "nothing compacted");
  });
});
