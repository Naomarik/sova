// The session feed's rows frames (rows=1 sockets) beside the old list_changed sockets. Pure: an
// injected list, no sockets, no files.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { SessionFeedMessage, SessionSummary } from "../shared/protocol";
import { ListRows } from "../src/lib/list-rows";
import { rowNeedsYou } from "../src/lib/signals";
import { rowsDigest } from "../src/lib/summary-diff";
import { diffRows, ROWS_MAX_BYTES, ROWS_MAX_ROWS, SessionFeed } from "./session-feed";

const row = (id: string, over: Partial<SessionSummary> = {}): SessionSummary => ({
  id, path: `/s/${id}.jsonl`, cwd: "/w", title: id, createdAt: "", lastActiveAt: "2026-01-01T00:00:00.000Z", model: null, live: null, busy: false, origin: "web", archived: false, ...over,
});
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const types = (ms: SessionFeedMessage[]) => ms.map((m) => m.type);

function harness(initial: SessionSummary[], intervalMs = 60_000) {
  let list = initial;
  // Fresh objects per build, as listSessions builds them.
  const feed = new SessionFeed({ list: async () => list.map(clone), intervalMs, debounceMs: 0, minGapMs: 0 });
  return {
    feed,
    set(next: SessionSummary[]) {
      list = next;
    },
    async step(next?: SessionSummary[]) {
      if (next) list = next;
      feed.nudge(0);
      await new Promise((r) => setTimeout(r, 5));
      await feed.idle();
    },
  };
}

describe("diffRows", () => {
  test("upserts new and changed rows (any compared field), removes gone paths, skips equal rows and seenAt-only changes", () => {
    const prev = new Map([row("a"), row("b"), row("c", { seenAt: 1 })].map((s) => [s.path, s]));
    const d = diffRows(prev, [clone(row("a")), row("b", { outlineNow: "new" }), row("c", { seenAt: 2 }), row("d")]);
    assert.deepEqual(d.upsert.map((s) => s.id), ["b", "d"]);
    assert.deepEqual(d.remove, []);
    const gone = diffRows(d.next, [row("a")]);
    assert.deepEqual(gone.upsert, []);
    assert.deepEqual(gone.remove.sort(), ["/s/b.jsonl", "/s/c.jsonl", "/s/d.jsonl"]);
  });
});

describe("rows sockets beside old ones", () => {
  test("a rows socket gets rows_hello first, then rows; an old socket still gets list_changed, never rows", async () => {
    const h = harness([row("a")]);
    const old: SessionFeedMessage[] = [];
    const rows: SessionFeedMessage[] = [];
    h.feed.add((m) => old.push(m));
    h.feed.add((m) => rows.push(m), { rows: true });
    await h.feed.idle();
    assert.equal(rows[0]?.type, "rows_hello");
    assert.deepEqual(types(old), ["marks"]);
    const hello = rows[0] as Extract<SessionFeedMessage, { type: "rows_hello" }>;

    // A new session: list_changed for the old socket, one rows frame for the new one.
    await h.step([row("b", { lastActiveAt: "2026-01-02T00:00:00.000Z" }), row("a")]);
    assert.deepEqual(types(old), ["marks", "list_changed"]);
    const r = rows.at(-1) as Extract<SessionFeedMessage, { type: "rows" }>;
    assert.equal(r.type, "rows");
    assert.equal(r.epoch, hello.epoch);
    assert.equal(r.from, hello.version);
    assert.equal(r.to, hello.version + 1);
    assert.deepEqual(r.upsert.map((s) => s.id), ["b"]);
    assert.deepEqual(r.remove, []);
    assert.ok(!rows.some((m) => m.type === "list_changed"));
    assert.ok(!old.some((m) => m.type === "rows" || m.type === "rows_hello"));
  });

  test("activity-only change: one small rows frame naming that row; the old socket's list_changed as before", async () => {
    const h = harness([row("a"), row("b")]);
    const old: SessionFeedMessage[] = [];
    const rows: SessionFeedMessage[] = [];
    h.feed.add((m) => old.push(m));
    h.feed.add((m) => rows.push(m), { rows: true });
    await h.feed.idle();
    await h.step([row("a", { activity: { state: "working", at: 1 } as never }), row("b")]);
    const frames = rows.filter((m) => m.type === "rows") as Extract<SessionFeedMessage, { type: "rows" }>[];
    assert.equal(frames.length, 1);
    assert.deepEqual(frames[0]!.upsert.map((s) => s.id), ["a"]);
    assert.deepEqual(types(old), ["marks", "list_changed"]);
    // Nothing changed: no frame, no version move.
    await h.step();
    assert.equal(rows.filter((m) => m.type === "rows").length, 1);
  });

  test("a change list_changed never announced (an outline) is still a rows frame; the old socket hears nothing, as before", async () => {
    const h = harness([row("a")]);
    const old: SessionFeedMessage[] = [];
    const rows: SessionFeedMessage[] = [];
    h.feed.add((m) => old.push(m));
    h.feed.add((m) => rows.push(m), { rows: true });
    await h.feed.idle();
    await h.step([row("a", { outlineNow: "Reading files" })]);
    assert.deepEqual(types(old), ["marks"]);
    assert.deepEqual(types(rows), ["rows_hello", "marks", "rows"]);
  });

  test("oversize: over ROWS_MAX_ROWS rows, or over ROWS_MAX_BYTES, is list_changed on the rows socket; the version still moves", async () => {
    const many = Array.from({ length: ROWS_MAX_ROWS + 1 }, (_, i) => row(`r${i}`));
    const h = harness([]);
    const rows: SessionFeedMessage[] = [];
    h.feed.add((m) => rows.push(m), { rows: true });
    await h.feed.idle();
    const v0 = h.feed.listVersion.version;
    await h.step(many);
    assert.equal(rows.at(-1)?.type, "list_changed");
    assert.equal(h.feed.listVersion.version, v0 + 1);
    // One big row: bytes, not count.
    await h.step([...many, row("big", { outlineNow: "x".repeat(ROWS_MAX_BYTES) })]);
    assert.equal(rows.at(-1)?.type, "list_changed");
    // Small again: rows.
    await h.step([...many, row("big", { outlineNow: "y" })]);
    assert.equal(rows.at(-1)?.type, "rows");
    assert.ok(!rows.some((m) => m.type === "rows" && m.upsert.length > ROWS_MAX_ROWS));
  });

  test("rows_check with each safety-net re-diff: the digest of the list at its version", async () => {
    const h = harness([row("a"), row("b")], 30);
    const rows: SessionFeedMessage[] = [];
    h.feed.add((m) => rows.push(m), { rows: true });
    await h.feed.idle();
    await new Promise((r) => setTimeout(r, 80));
    await h.feed.idle();
    const check = rows.find((m) => m.type === "rows_check") as Extract<SessionFeedMessage, { type: "rows_check" }> | undefined;
    assert.ok(check, "a rows_check was sent");
    assert.equal(check.version, h.feed.listVersion.version);
    assert.equal(check.digest, rowsDigest([row("a"), row("b")].map(clone)));
    h.feed.stop();
  });

  test("an old socket never gets rows_check", async () => {
    const h = harness([row("a")], 30);
    const old: SessionFeedMessage[] = [];
    h.feed.add((m) => old.push(m));
    await new Promise((r) => setTimeout(r, 80));
    await h.feed.idle();
    assert.deepEqual(types(old), ["marks"]);
    h.feed.stop();
  });

  test("epoch: a new one each time the feed starts, so a read made while no one listened is never this run's", async () => {
    const h = harness([row("a")]);
    const before = h.feed.listVersion;
    const got: SessionFeedMessage[] = [];
    const off = h.feed.add((m) => got.push(m), { rows: true });
    await h.feed.idle();
    const hello = got[0] as Extract<SessionFeedMessage, { type: "rows_hello" }>;
    assert.notEqual(hello.epoch, before.epoch);
    off();
    const again: SessionFeedMessage[] = [];
    h.feed.add((m) => again.push(m), { rows: true });
    await h.feed.idle();
    assert.notEqual((again[0] as typeof hello).epoch, hello.epoch);
    h.feed.stop();
  });

  test("snapshot: runs between re-diffs and names the version whose diff finished before its read", async () => {
    const h = harness([row("a")]);
    const rows: SessionFeedMessage[] = [];
    h.feed.add((m) => rows.push(m), { rows: true });
    await h.feed.idle();
    h.set([row("a"), row("b")]);
    h.feed.nudge(0);
    await new Promise((r) => setTimeout(r, 5));
    // Queued behind the pending diff: its version is the one after b appeared.
    const snap = await h.feed.snapshot(async () => "body");
    assert.equal(snap.body, "body");
    assert.equal(snap.version, h.feed.listVersion.version);
    assert.equal(snap.epoch, (rows[0] as Extract<SessionFeedMessage, { type: "rows_hello" }>).epoch);
    assert.ok(rows.some((m) => m.type === "rows" && m.to === snap.version));
    await assert.rejects(h.feed.snapshot(async () => Promise.reject(new Error("boom"))), /boom/);
    // A failed read doesn't stall the chain.
    assert.equal((await h.feed.snapshot(async () => 1)).body, 1);
    h.feed.stop();
  });
});

test("a seen-only change (the server drops the seen signal) is a rows frame, and the merged row shows no mark", async () => {
  const sig: SessionSummary["signals"] = { at: 100, turnId: "t1", provider: "jev", kinds: ["unverified"] };
  const h = harness([row("a", { signals: sig, seenAt: 50 }), row("b")]);
  let view: SessionSummary[] = [];
  const lr = new ListRows({ refetch: () => assert.fail("no re-read needed"), publish: (r) => (view = r) });
  lr.socketOpened();
  lr.fetchStarted();
  h.feed.add((m) => lr.message(clone(m)), { rows: true });
  await h.feed.idle();
  const snap = await h.feed.snapshot(async () => [row("a", { signals: sig, seenAt: 50 }), row("b")].map(clone));
  view = lr.snapshot(snap.body, { epoch: snap.epoch, version: snap.version });
  const a0 = view.find((s) => s.id === "a")!;
  assert.ok(rowNeedsYou(a0, { selected: null, busy: false }), "unseen: the mark shows");
  // The user opens it elsewhere: seenAt moves past the signal and the server stops listing it.
  await h.step([row("a", { seenAt: 150 }), row("b")]);
  assert.equal(lr.refetches, 0);
  const a1 = view.find((s) => s.id === "a")!;
  assert.equal(a1.signals, undefined);
  assert.equal(a1.seenAt, 150, "the upsert carries the server's current seenAt");
  assert.equal(rowNeedsYou(a1, { selected: null, busy: false }), null);
  h.feed.stop();
});

test("a list handed out by identity (unchanged rows, the same objects) costs no stringify in a re-diff; a fresh equal object still compares by value", async () => {
  const sig: SessionSummary["signals"] = { at: 100, turnId: "t1", provider: "jev", kinds: ["unverified"] };
  const kept = [row("a", { signals: sig }), row("b", { tags: { topic: "x" } }), row("c")];
  let list = kept;
  const feed = new SessionFeed({ list: async () => [...list], intervalMs: 60_000, debounceMs: 0, minGapMs: 0 });
  const old: SessionFeedMessage[] = [];
  const rows: SessionFeedMessage[] = [];
  feed.add((m) => old.push(m));
  feed.add((m) => rows.push(m), { rows: true });
  await feed.idle();
  const settle = async () => {
    feed.nudge(0);
    await new Promise((r) => setTimeout(r, 5));
    await feed.idle();
  };
  await settle(); // every row's key, signature and marks are cached now
  const real = JSON.stringify;
  let calls = 0;
  JSON.stringify = ((...a: Parameters<typeof JSON.stringify>) => (calls++, real(...a))) as typeof JSON.stringify;
  const diffs = feed.diffs;
  try {
    await settle();
  } finally {
    JSON.stringify = real;
  }
  assert.equal(feed.diffs, diffs + 1, "the re-diff ran");
  assert.equal(calls, 0, "same objects: nothing stringified");
  // Fresh objects equal by value: no frame of any kind (compared by value, not identity).
  const before = [old.length, rows.length];
  list = kept.map(clone);
  await settle();
  assert.deepEqual([old.length, rows.length], before);
  // A fresh object that differs: a frame, as always.
  list = [clone(kept[0]!), clone(kept[1]!), row("c", { title: "renamed" })];
  await settle();
  assert.equal(rows.at(-1)?.type, "rows");
  assert.equal(old.at(-1)?.type, "list_changed");
  feed.stop();
});
