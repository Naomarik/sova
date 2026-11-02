import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { SessionFeedMessage, SessionSummary } from "../../shared/protocol";
import { ListRows } from "./list-rows";
import { byActivity, parseListVersion, rowsDigest } from "./summary-diff";

const row = (id: string, at: number, over: Partial<SessionSummary> = {}): SessionSummary => ({
  id, path: `/s/${id}.jsonl`, cwd: "/w", title: id, createdAt: "", lastActiveAt: new Date(at).toISOString(), model: null, live: null, busy: false, origin: "web", archived: false, ...over,
});
const E = "ep1";
const hello = (version: number, epoch = E): SessionFeedMessage => ({ type: "rows_hello", epoch, version });
const delta = (from: number, upsert: SessionSummary[], remove: string[] = [], epoch = E): SessionFeedMessage => ({ type: "rows", epoch, from, to: from + 1, upsert, remove });
const marks: SessionFeedMessage = { type: "marks", full: true, sessions: [] };

function make() {
  const published: SessionSummary[][] = [];
  let refetches = 0;
  const lr = new ListRows({ refetch: () => refetches++, publish: (r) => published.push(r) });
  return { lr, published, refetches: () => refetches };
}

/** A tab that read the list at version 0 and opened its socket at version 0. */
function synced(rows: SessionSummary[]) {
  const t = make();
  t.lr.fetchStarted();
  t.lr.socketOpened();
  assert.equal(t.lr.message(hello(0)), true);
  t.lr.snapshot(rows, { epoch: E, version: 0 });
  assert.equal(t.refetches(), 0);
  return t;
}

describe("ListRows", () => {
  test("in order: each delta at the held version is applied, sorted by lastActiveAt, unchanged rows kept by identity", () => {
    const a = row("a", 1);
    const b = row("b", 2);
    const t = synced([b, a]);
    t.lr.message(delta(0, [row("a", 3)]));
    assert.deepEqual(t.published.at(-1)!.map((s) => s.id), ["a", "b"]);
    assert.equal(t.published.at(-1)![1], b);
    t.lr.message(delta(1, [], [b.path]));
    assert.deepEqual(t.published.at(-1)!.map((s) => s.id), ["a"]);
    assert.equal(t.refetches(), 0);
    assert.deepEqual(t.lr.version, { epoch: E, version: 2 });
  });

  test("a gap (from ≠ held version) re-reads and applies nothing", () => {
    const t = synced([row("a", 1)]);
    t.lr.message(delta(1, [row("b", 2)])); // 0→1 was lost
    assert.equal(t.published.length, 0);
    assert.equal(t.refetches(), 1);
    assert.equal(t.lr.following, false);
  });

  test("out of order: a later frame first re-reads; the re-read's answer then follows on", () => {
    const t = synced([row("a", 1)]);
    t.lr.message(delta(1, [row("c", 3)]));
    assert.equal(t.refetches(), 1);
    t.lr.fetchStarted();
    t.lr.message(delta(2, [row("d", 4)])); // waits for the read
    const out = t.lr.snapshot([row("c", 3), row("a", 1)], { epoch: E, version: 2 });
    assert.deepEqual(out.map((s) => s.id), ["d", "c", "a"]);
    assert.deepEqual(t.lr.version, { epoch: E, version: 3 });
    assert.equal(t.refetches(), 1);
  });

  test("deltas wait while a read is in flight, then those after its version are replayed onto it (older ones dropped)", () => {
    const t = synced([row("a", 1)]);
    t.lr.fetchStarted();
    t.lr.message(delta(0, [row("b", 2)]));
    t.lr.message(delta(1, [row("c", 3)]));
    assert.equal(t.published.length, 0);
    // The read was answered at version 1 (it already has b).
    const out = t.lr.snapshot([row("b", 2), row("a", 1)], { epoch: E, version: 1 });
    assert.deepEqual(out.map((s) => s.id), ["c", "b", "a"]);
    assert.equal(t.published.length, 0, "a read's answer is returned, not published");
    assert.equal(t.refetches(), 0);
  });

  test("no rows_hello (an older server or peer): legacy, list_changed is left to the caller, rows frames are ignored", () => {
    const t = make();
    t.lr.socketOpened();
    assert.equal(t.lr.message(marks), false);
    assert.equal(t.lr.message({ type: "list_changed" }), false);
    assert.equal(t.lr.following, false);
    t.lr.fetchStarted();
    const rows = [row("a", 1)];
    assert.equal(t.lr.snapshot(rows, null), rows);
    assert.equal(t.refetches(), 0);
  });

  test("a snapshot without the version header on a rows socket re-reads a few times, then falls back to legacy", () => {
    const t = make();
    t.lr.socketOpened();
    t.lr.message(hello(0));
    for (let i = 0; i < 5; i++) {
      t.lr.fetchStarted();
      t.lr.snapshot([row("a", 1)], null);
    }
    // One for the hello (nothing held), three retries, then no more.
    assert.equal(t.refetches(), 4);
    assert.equal(t.lr.message({ type: "list_changed" }), false, "legacy: the caller re-reads on list_changed");
  });

  test("the digest catches a dropped frame: same version, different rows → re-read; a match does nothing", () => {
    const server = [row("a", 1), row("b", 2, { outlineNow: "x" })];
    const t = synced([row("a", 1), row("b", 2)]);
    t.lr.message({ type: "rows_check", epoch: E, version: 0, digest: rowsDigest([row("a", 1), row("b", 2)]) });
    assert.equal(t.refetches(), 0);
    t.lr.message({ type: "rows_check", epoch: E, version: 0, digest: rowsDigest(server) });
    assert.equal(t.refetches(), 1);
  });

  test("the digest at a version ahead of the held one (the frame and its successors lost) re-reads", () => {
    const t = synced([row("a", 1)]);
    t.lr.message({ type: "rows_check", epoch: E, version: 4, digest: "0" });
    assert.equal(t.refetches(), 1);
  });

  test("epoch change: a frame or a hello of another epoch re-reads; a snapshot of another epoch is not continued", () => {
    const t = synced([row("a", 1)]);
    t.lr.message(delta(0, [row("b", 2)], [], "ep2"));
    assert.equal(t.refetches(), 1);
    assert.equal(t.published.length, 0);
    // A reconnect to a restarted server: new hello, new epoch.
    t.lr.socketOpened();
    t.lr.message(hello(0, "ep2"));
    assert.equal(t.refetches(), 2);
    t.lr.fetchStarted();
    t.lr.snapshot([row("a", 1)], { epoch: "ep1", version: 7 });
    assert.equal(t.lr.following, false);
    assert.equal(t.refetches(), 3);
    t.lr.fetchStarted();
    t.lr.snapshot([row("a", 1)], { epoch: "ep2", version: 0 });
    assert.equal(t.lr.following, true);
  });

  test("a reconnect whose hello names the held version needs no read; any other version does", () => {
    const t = synced([row("a", 1)]);
    t.lr.socketClosed();
    t.lr.socketOpened();
    t.lr.message(hello(0));
    assert.equal(t.refetches(), 0);
    t.lr.socketClosed();
    t.lr.socketOpened();
    t.lr.message(hello(3));
    assert.equal(t.refetches(), 1);
  });

  test("list_changed on a rows socket (too big for a frame) re-reads, and later frames wait for it", () => {
    const t = synced([row("a", 1)]);
    assert.equal(t.lr.message({ type: "list_changed" }), true);
    assert.equal(t.refetches(), 1);
    t.lr.fetchStarted();
    t.lr.message(delta(1, [row("z", 9)]));
    const out = t.lr.snapshot([row("y", 8), row("a", 1)], { epoch: E, version: 1 });
    assert.deepEqual(out.map((s) => s.id), ["z", "y", "a"]);
  });

  test("two reads crossing: an older answer after a newer one keeps the newer rows", () => {
    const t = synced([row("a", 1)]);
    t.lr.fetchStarted();
    t.lr.fetchStarted();
    t.lr.snapshot([row("b", 2), row("a", 1)], { epoch: E, version: 5 });
    const out = t.lr.snapshot([row("a", 1)], { epoch: E, version: 3 });
    assert.deepEqual(out.map((s) => s.id), ["b", "a"]);
  });

  test("a failed read replays what waited onto the held rows", () => {
    const t = synced([row("a", 1)]);
    t.lr.fetchStarted();
    t.lr.message(delta(0, [row("b", 2)]));
    const moved = t.lr.fetchFailed();
    assert.deepEqual(moved?.map((s) => s.id), ["b", "a"]);
  });
});

test("byActivity and the version header", () => {
  const rows = [row("b", 1), row("a", 1), row("c", 2)];
  assert.deepEqual([...rows].sort(byActivity).map((s) => s.id), ["c", "a", "b"]);
  assert.deepEqual(parseListVersion("abc_-1:12"), { epoch: "abc_-1", version: 12 });
  assert.equal(parseListVersion(null), null);
  assert.equal(parseListVersion("x"), null);
});
