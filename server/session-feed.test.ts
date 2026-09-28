// Run: npx tsx --test server/session-feed.test.ts
// Pure: an injected list, no sockets, no files.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { SessionFeedMessage, SessionSignals, SessionSummary } from "../shared/protocol";
import { diffMarks, listChanged, marksOf, rowSignature, SessionFeed } from "./session-feed";

const row = (id: string, over: Partial<SessionSummary> = {}): SessionSummary => ({
  id, path: `/s/${id}.jsonl`, cwd: "/w", title: id, createdAt: "", lastActiveAt: "", model: null, live: null, busy: false, origin: "web", archived: false, ...over,
});
const signals = (at: number): SessionSignals => ({ at, turnId: `t${at}`, provider: "jev", stuck: { score: 2, confidence: 0.9 }, kinds: ["looping"] });

describe("diffMarks", () => {
  test("new fields are sent, unchanged ones are not, cleared ones are null, a gone session clears what it had", () => {
    const first = diffMarks(new Map(), [row("a", { signals: signals(1) }), row("b", { tags: { topic: "docs" } }), row("c")]);
    assert.deepEqual(first.changes, [
      { id: "a", path: "/s/a.jsonl", signals: signals(1) },
      { id: "b", path: "/s/b.jsonl", tags: { topic: "docs" } },
    ]);
    const second = diffMarks(first.next, [row("a", { signals: signals(1), workerSignals: { stuck: 1 } }), row("b", { tags: { topic: "docs", status: "done" } })]);
    assert.deepEqual(second.changes, [
      { id: "a", path: "/s/a.jsonl", workerSignals: { stuck: 1 } },
      { id: "b", path: "/s/b.jsonl", tags: { topic: "docs", status: "done" } },
    ]);
    const third = diffMarks(second.next, [row("a", { workerSignals: { stuck: 1 } })]);
    assert.deepEqual(third.changes, [
      { id: "a", path: "/s/a.jsonl", signals: null },
      { id: "b", path: "/s/b.jsonl", tags: null },
    ]);
    assert.deepEqual(diffMarks(third.next, [row("a", { workerSignals: { stuck: 1 } })]).changes, []);
  });

  test("the turn-error mark is pushed like the decision marks: it appears, and clears with null", () => {
    const shown = diffMarks(new Map(), [row("a", { turnError: { message: "overloaded" } })]);
    assert.deepEqual(shown.changes, [{ id: "a", path: "/s/a.jsonl", turnError: { message: "overloaded" } }]);
    // Seen: the list stops carrying it, and the feed says so at once.
    assert.deepEqual(diffMarks(shown.next, [row("a")]).changes, [{ id: "a", path: "/s/a.jsonl", turnError: null }]);
  });

  test("a row without overlays has no marks", () => {
    assert.equal(marksOf(row("x")), null);
  });
});

describe("SessionFeed", () => {
  test("full snapshot on connect, deltas on nudge, nothing listed with no client", async () => {
    let list: SessionSummary[] = [row("a", { signals: signals(1) })];
    let listed = 0;
    const feed = new SessionFeed({ list: async () => (listed++, list), intervalMs: 60_000, debounceMs: 0 });
    feed.nudge();
    await feed.idle();
    assert.equal(listed, 0);

    const got: SessionFeedMessage[] = [];
    const remove = feed.add((m) => got.push(m));
    await feed.idle();
    assert.deepEqual(got, [{ type: "marks", full: true, sessions: [{ id: "a", path: "/s/a.jsonl", signals: signals(1) }] }]);

    list = [row("a")];
    feed.nudge(0);
    await new Promise((r) => setTimeout(r, 5));
    await feed.idle();
    assert.deepEqual(got[1], { type: "marks", sessions: [{ id: "a", path: "/s/a.jsonl", signals: null }] });

    // A second client: the first gets nothing new (no change), the second a full snapshot.
    const got2: SessionFeedMessage[] = [];
    const remove2 = feed.add((m) => got2.push(m));
    await feed.idle();
    assert.equal(got.length, 2);
    assert.deepEqual(got2, [{ type: "marks", full: true, sessions: [] }]);

    feed.publish({ type: "tags_backfill", progress: { running: true, done: 1, total: 3, failed: 0 } });
    assert.equal(got.length, 3);
    assert.equal(got2.length, 2);
    remove();
    remove2();
    assert.equal(feed.size, 0);
  });
});

describe("D3: list_changed, for what the marks can't carry", () => {
  test("rowSignature/listChanged: a new or removed path, a live, running or activity change; not a marks-only change", () => {
    const base = [row("a"), row("b")];
    const map = (l: SessionSummary[]) => new Map(l.map((s) => [s.path, rowSignature(s)]));
    assert.equal(listChanged(map(base), map(base)), false);
    assert.equal(listChanged(map(base), map([...base, row("c")])), true);
    assert.equal(listChanged(map(base), map([row("a")])), true);
    assert.equal(listChanged(map(base), map([row("a", { live: { pid: 7, status: "idle" } }), row("b")])), true);
    assert.equal(listChanged(map(base), map([row("a", { busy: true }), row("b")])), true);
    assert.equal(listChanged(map(base), map([row("a", { activity: { state: "working" } }), row("b")])), true);
    assert.equal(listChanged(map(base), map([row("a", { lastActiveAt: "later" }), row("b")])), true);
    // A baton row changes in the org's registry/roster, not its file: an approved referral, a new holder.
    const held = { holder: "Tony", state: "open" as const };
    const waiting = { ...held, proposals: [{ personId: "p_b", name: "Bob", role: "IT", by: "Tony", since: 1 }] };
    assert.equal(listChanged(map([row("a", { baton: waiting }), row("b")]), map([row("a", { baton: held }), row("b")])), true);
    assert.equal(listChanged(map([row("a", { baton: held }), row("b")]), map([row("a", { baton: { ...held } }), row("b")])), false);
    assert.equal(listChanged(map(base), map([row("a", { signals: signals(1), tags: { topic: "docs" } }), row("b")])), false);
    // An org session's project archived (projects.json, not its file): it leaves the Organizations region.
    const org = { orgId: "o1", orgName: "Acme", projectId: "p1", projectName: "Ledger", kind: "gathering" as const };
    assert.equal(listChanged(map([row("a", { org }), row("b")]), map([row("a", { org: { ...org, projectArchived: true } }), row("b")])), true);
  });

  test("a session that appears after connect is announced once; nothing on the connect itself", async () => {
    let list: SessionSummary[] = [row("a")];
    const feed = new SessionFeed({ list: async () => list, intervalMs: 60_000, debounceMs: 0 });
    const got: SessionFeedMessage[] = [];
    const remove = feed.add((m) => got.push(m));
    await feed.idle();
    assert.deepEqual(got.map((m) => m.type), ["marks"]);
    list = [row("a"), row("tui-new")];
    feed.nudge(0);
    await new Promise((r) => setTimeout(r, 5));
    await feed.idle();
    assert.deepEqual(got.slice(1), [{ type: "list_changed" }]);
    feed.nudge(0);
    await new Promise((r) => setTimeout(r, 5));
    await feed.idle();
    assert.equal(got.length, 2); // unchanged: no second nudge
    remove();
  });

  test("a list change also drops the attention digest's memo, so Needs you re-reads it fresh (a Get Link, a share-page reply)", async () => {
    const { onAttentionChanged } = await import("./attention-memo");
    let drops = 0;
    onAttentionChanged(() => drops++);
    let list: SessionSummary[] = [row("a")];
    const feed = new SessionFeed({ list: async () => list, intervalMs: 60_000, debounceMs: 0 });
    const remove = feed.add(() => {});
    await feed.idle();
    assert.equal(drops, 0, "the baseline changes nothing");
    list = [{ ...row("a"), baton: { holder: "p_1", state: "open" } as never }];
    feed.nudge(0);
    await new Promise((r) => setTimeout(r, 5));
    await feed.idle();
    assert.equal(drops, 1);
    feed.nudge(0);
    await new Promise((r) => setTimeout(r, 5));
    await feed.idle();
    assert.equal(drops, 1, "unchanged: the memo stays");
    remove();
  });
});
