// Run: node scripts/run-tests.mjs server/events.test.ts
// The event stream's hub (§app/events): cursor, ring, sleep and wake, sources, isolation from the
// session feed. Pure: fake sources, a real SessionFeed over an injected list, no sockets, no files.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { EventsServerFrame } from "../shared/events";
import type { SessionFeedMessage, SessionSummary } from "../shared/protocol";
import { cursorOf, type Entry, EventHub, type EventSources, type ListedRow } from "./events";
import { SessionFeed } from "./session-feed";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Fake sources that count their listeners and let a test fire them. */
function sources(over: Partial<EventSources> = {}) {
  const chat = new Set<(e: { chatId: string; type: string }) => void>();
  const attention = new Set<() => void>();
  let feedHolds = 0;
  let hosted = new Set<string>();
  const s: EventSources = {
    onChatEvent: (fn) => (chat.add(fn), () => chat.delete(fn)),
    onAttention: (fn) => (attention.add(fn), () => attention.delete(fn)),
    holdFeed: () => (feedHolds++, () => feedHolds--),
    isHosted: (p) => hosted.has(p),
    idOf: (p) => p.replace(/^.*\/|\.jsonl$/g, ""),
    ...over,
  };
  return {
    s,
    chat: (chatId: string, type: string) => chat.forEach((fn) => fn({ chatId, type })),
    attention: () => attention.forEach((fn) => fn()),
    listeners: () => chat.size + attention.size,
    feedHolds: () => feedHolds,
    host: (...paths: string[]) => (hosted = new Set(paths)),
  };
}

/** A subscriber that keeps what it got, parsed. */
function collector() {
  const got: EventsServerFrame[] = [];
  return { got, sub: { deliver: (e: Entry) => got.push(JSON.parse(e.json)) } };
}
const parse = (es: Entry[]) => es.map((e) => JSON.parse(e.json) as EventsServerFrame);
const seqs = (fs: EventsServerFrame[]) => fs.map((f) => (f.type === "event" ? f.seq : f.type === "gap" && f.reason !== "restarted" ? `gap:${f.reason}:${f.from}-${f.to}` : f.type === "gap" ? "gap:restarted" : f.type));
const row = (id: string, over: Partial<ListedRow> = {}): ListedRow => ({ id, path: `/s/${id}.jsonl`, title: id, archived: false, ...over });

function subscribed(hub: EventHub, cursor: { stream: string; since: number } | null = null) {
  const c = collector();
  const r = hub.subscribe(c.sub, cursor);
  if ("error" in r) throw new Error(r.error);
  return { ...c, ...r, helloFrame: JSON.parse(r.hello) as EventsServerFrame & { type: "hello" } };
}

describe("cursor and resume", () => {
  test("a resume gets exactly the events after its seq, in order, and nothing else", () => {
    const f = sources();
    const hub = new EventHub(f.s);
    const a = subscribed(hub); // wake: marker at seq 1
    for (let i = 0; i < 5; i++) f.chat(`/s/c${i}.jsonl`, i % 2 ? "settled" : "started");
    assert.deepEqual(seqs(a.got), [2, 3, 4, 5, 6], "the wake's marker is for later resumes, not the subscriber that woke it");
    const b = subscribed(hub, { stream: hub.stream, since: 3 });
    assert.deepEqual(seqs(parse(b.replay)), [4, 5, 6]);
    assert.deepEqual(b.got, []);
    f.chat("/s/x.jsonl", "started");
    assert.deepEqual(seqs(b.got), [7]);
    hub.close();
  });

  test("hosted chat events: started → turn.started, settled → turn.ended, others ignored", () => {
    const f = sources();
    const hub = new EventHub(f.s, { now: () => 42 });
    const a = subscribed(hub);
    f.chat("/s/a.jsonl", "started");
    f.chat("/s/a.jsonl", "receiverIdle");
    f.chat("/s/a.jsonl", "closed");
    f.chat("/s/a.jsonl", "settled");
    assert.deepEqual(a.got, [
      { type: "event", seq: 2, at: 42, name: "turn.started", source: "hosted", id: "a", path: "/s/a.jsonl" },
      { type: "event", seq: 3, at: 42, name: "turn.ended", source: "hosted", id: "a", path: "/s/a.jsonl" },
    ]);
    hub.close();
  });

  test("the ring keeps at most ringMax events and ringBytes of them; an older cursor gets one evicted gap first", () => {
    const f = sources();
    const hub = new EventHub(f.s, { ringMax: 10 });
    subscribed(hub);
    for (let i = 0; i < 30; i++) f.chat("/s/a.jsonl", "started"); // seqs 2..31
    const r = subscribed(hub, { stream: hub.stream, since: 3 });
    assert.deepEqual(seqs(parse(r.replay)), ["gap:evicted:4-21", 22, 23, 24, 25, 26, 27, 28, 29, 30, 31]);
    assert.equal(r.helloFrame.oldest, 22);
    hub.close();

    // The byte cap: each turn event here is well over 60 bytes, so 1,000 bytes keep fewer than 17.
    const g = sources();
    const small = new EventHub(g.s, { ringBytes: 1000 });
    subscribed(small);
    for (let i = 0; i < 50; i++) g.chat("/s/a.jsonl", "started");
    const kept = subscribed(small, { stream: small.stream, since: 0 }).replay.slice(1);
    assert.ok(kept.length > 0 && kept.length < 17, `kept ${kept.length}`);
    assert.ok(kept.reduce((n, e) => n + e.bytes, 0) <= 1000);
    small.close();
  });

  test("a sleep and a wake: an old cursor gets every kept event in seq order, then the wake's marker", async () => {
    const f = sources();
    const hub = new EventHub(f.s, { lingerMs: 10 });
    const a = subscribed(hub); // seq 1 marker
    f.chat("/s/a.jsonl", "started"); // 2
    f.chat("/s/a.jsonl", "settled"); // 3
    f.chat("/s/a.jsonl", "started"); // 4
    f.chat("/s/a.jsonl", "settled"); // 5
    a.leave();
    f.chat("/s/b.jsonl", "started"); // 6..9 during the linger
    f.chat("/s/b.jsonl", "settled");
    f.chat("/s/b.jsonl", "started");
    f.chat("/s/b.jsonl", "settled");
    await wait(40);
    assert.equal(hub.running, false, "asleep after the linger");
    f.chat("/s/c.jsonl", "started"); // unheard: asleep
    const b = subscribed(hub, { stream: hub.stream, since: 5 }); // wake: marker 10
    assert.deepEqual(seqs(parse(b.replay)), [6, 7, 8, 9, "gap:unobserved:10-10"]);
    hub.close();
  });

  test("a reconnect within the linger resumes with nothing missed", async () => {
    const f = sources();
    const hub = new EventHub(f.s, { lingerMs: 1000 });
    const a = subscribed(hub);
    f.chat("/s/a.jsonl", "started"); // 2
    a.leave();
    f.chat("/s/a.jsonl", "settled"); // 3, heard: lingering
    const b = subscribed(hub, { stream: hub.stream, since: 2 });
    assert.deepEqual(seqs(parse(b.replay)), [3]);
    hub.close();
  });

  test("another stream's cursor gets gap restarted then every kept entry, even with a since far past this stream", () => {
    const f = sources();
    const hub = new EventHub(f.s);
    subscribed(hub);
    f.chat("/s/a.jsonl", "started");
    const other = hub.stream === "aaaaaaaaaaaaaaaa" ? "bbbbbbbbbbbbbbbb" : "aaaaaaaaaaaaaaaa";
    const r = subscribed(hub, { stream: other, since: 999999 });
    assert.deepEqual(seqs(parse(r.replay)), ["gap:restarted", "gap:unobserved:1-1", 2]);
    hub.close();
  });

  test("this stream's since past its newest seq is refused; the cursor's shape is checked first", () => {
    const hub = new EventHub(sources().s);
    const r = hub.subscribe(collector().sub, { stream: hub.stream, since: 5 });
    assert.deepEqual(r, { error: "since is ahead of this stream." });
    assert.equal(hub.running, false, "a refused cursor wakes nothing");
    const q = (s: string) => cursorOf(new URLSearchParams(s));
    assert.deepEqual(q(""), { cursor: null });
    assert.deepEqual(q("stream=abcdefgh12345678&since=7"), { cursor: { stream: "abcdefgh12345678", since: 7 } });
    for (const bad of ["since=7", "stream=abcdefgh12345678", "stream=abcdefgh12345678&since=-1", "stream=abcdefgh12345678&since=1.5", "stream=abcdefgh12345678&since=07", "stream=x&since=1", "stream=abcdefgh12345678&since=99999999999999999"])
      assert.ok("error" in q(bad), bad);
  });
});

describe("nothing runs while no one listens", () => {
  test("zero subscribers: no listener, no feed hold, zero list reads, while chat events, attention notes and nudges happen", async () => {
    const f = sources();
    let reads = 0;
    let hub: EventHub;
    const feed = new SessionFeed({ list: async () => (reads++, hub.seeList([] as SessionSummary[])), intervalMs: 5, debounceMs: 1, minGapMs: 0 });
    hub = new EventHub({ ...f.s, holdFeed: () => feed.add(() => {}) }, { lingerMs: 10 });
    f.chat("/s/a.jsonl", "started");
    f.attention();
    feed.nudge(0);
    await wait(30);
    assert.equal(reads, 0);
    assert.equal(f.listeners(), 0);
    assert.equal(hub.running, false);

    const a = subscribed(hub);
    assert.equal(f.listeners(), 2, "awake: the chat and attention listeners");
    await wait(30);
    assert.ok(reads >= 2, `the feed's loop reads while one subscriber listens (${reads})`);
    a.leave();
    await wait(40);
    assert.equal(hub.running, false);
    assert.equal(f.listeners(), 0);
    const after = reads;
    await wait(40);
    assert.equal(reads, after, "reads stop once the linger ends");
    feed.stop();
  });
});

describe("observed events", () => {
  test("two reads give created, removed, renamed, tagged, archived; the first read after a wake is the baseline", () => {
    const f = sources();
    const hub = new EventHub(f.s, { now: () => 1 });
    const a = subscribed(hub);
    hub.seeList([row("a"), row("b"), row("c")]);
    assert.equal(a.got.length, 0, "baseline only");
    hub.seeList([row("a", { title: "A" }), row("b", { tags: { user: ["x"] } }), row("d"), row("c", { archived: true })]);
    const at = (id: string) => ({ id, path: `/s/${id}.jsonl`, source: "observed" });
    assert.deepEqual(a.got, [
      { type: "event", seq: 2, at: 1, name: "session.renamed", ...at("a"), from: "a", title: "A" },
      { type: "event", seq: 3, at: 1, name: "session.tagged", ...at("b"), tags: { user: ["x"] } },
      { type: "event", seq: 4, at: 1, name: "session.created", ...at("d"), title: "d" },
      { type: "event", seq: 5, at: 1, name: "session.archived", ...at("c"), archived: true },
    ]);
    hub.seeList([row("a", { title: "A" })]);
    assert.deepEqual(a.got.slice(4).map((e) => e.type === "event" && [e.name, "id" in e && e.id]), [
      ["session.removed", "b"],
      ["session.removed", "d"],
      ["session.removed", "c"],
    ]);
    hub.close();
  });

  test("a terminal session's live record: working or a dialog is a turn, observed; idle, error or none ends it", () => {
    const f = sources();
    const hub = new EventHub(f.s);
    const a = subscribed(hub);
    hub.seeList([row("t", { activity: { state: "idle" } })]);
    hub.seeList([row("t", { activity: { state: "working" } })]);
    hub.seeList([row("t", { activity: { state: "needs-input" } })]);
    hub.seeList([row("t", { activity: { state: "error" } })]);
    hub.seeList([row("t", { activity: { state: "working" } })]);
    hub.seeList([row("t")]);
    assert.deepEqual(
      a.got.map((e) => e.type === "event" && "source" in e && [e.name, e.source]),
      [
        ["turn.started", "observed"],
        ["turn.ended", "observed"],
        ["turn.started", "observed"],
        ["turn.ended", "observed"],
      ],
    );
    hub.close();
  });

  test("one settled run of a chat Sova runs gives exactly one turn.ended (hosted), whatever the list shows", () => {
    const f = sources();
    const hub = new EventHub(f.s);
    const a = subscribed(hub);
    f.host("/s/h.jsonl");
    hub.seeList([row("h", { activity: { state: "idle" } })]);
    f.chat("/s/h.jsonl", "started");
    hub.seeList([row("h", { activity: { state: "working" } })]);
    f.chat("/s/h.jsonl", "settled");
    hub.seeList([row("h", { activity: { state: "idle" } })]);
    const turns = a.got.filter((e) => e.type === "event" && e.name.startsWith("turn."));
    assert.deepEqual(
      turns.map((e) => e.type === "event" && "source" in e && [e.name, e.source]),
      [
        ["turn.started", "hosted"],
        ["turn.ended", "hosted"],
      ],
    );
    hub.close();
  });

  test("attention notes in a burst give one attention.changed", async () => {
    const f = sources();
    const hub = new EventHub(f.s, { attentionMs: 10 });
    const a = subscribed(hub);
    for (let i = 0; i < 5; i++) f.attention();
    await wait(40);
    assert.deepEqual(a.got.map((e) => e.type === "event" && e.name), ["attention.changed"]);
    hub.close();
  });
});

describe("isolation", () => {
  test("a hub whose diff throws never stops the session feed: its client still gets marks and list_changed", async () => {
    const f = sources({
      isHosted: () => {
        throw new Error("boom");
      },
    });
    const logs: string[] = [];
    const hub = new EventHub(f.s, { log: (l) => logs.push(l) });
    let list: SessionSummary[] = [];
    const base = (id: string, over: Partial<SessionSummary> = {}): SessionSummary => ({ id, path: `/s/${id}.jsonl`, cwd: "/w", title: id, createdAt: "", lastActiveAt: "", model: null, live: null, busy: false, origin: "web", archived: false, ...over });
    const feed = new SessionFeed({ list: async () => hub.seeList(list), intervalMs: 60_000, debounceMs: 1, minGapMs: 0 });
    const got: SessionFeedMessage[] = [];
    subscribed(hub);
    const off = feed.add((m) => got.push(m));
    await feed.idle();
    list = [base("a", { tags: { topic: "docs" } as SessionSummary["tags"], activity: { state: "working" } })]; // isHosted is asked, and throws
    feed.nudge(0);
    await wait(10);
    await feed.idle();
    assert.ok(logs.some((l) => l.includes("boom")), "the hub's failure is logged");
    assert.deepEqual(
      got.map((m) => m.type),
      ["marks", "marks", "list_changed"],
    );
    off();
    feed.stop();
    hub.close();
  });

  test("a subscriber or a source that throws is contained", () => {
    const f = sources({ idOf: () => { throw new Error("idOf"); } });
    const hub = new EventHub(f.s, { log: () => {} });
    const ok = subscribed(hub);
    hub.subscribe({ deliver: () => { throw new Error("sub"); } }, null);
    f.chat("/s/a.jsonl", "started"); // idOf throws inside the listener: nothing recorded, nothing thrown
    hub.record({ name: "attention.changed" });
    assert.deepEqual(seqs(ok.got), [2]);
    hub.close();
  });
});
