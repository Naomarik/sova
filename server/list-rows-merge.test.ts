// Property-style: a tab following the real feed's rows frames (src/lib/list-rows.ts against
// server/session-feed.ts) ends with exactly the list a full read gives, for random change
// sequences (new, changed, renamed, archived, deleted, activity), reads crossing deltas, and lost
// frames (the digest repairs those). Pure: an injected list, no sockets, no files.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { SessionFeedMessage, SessionSummary } from "../shared/protocol";
import { ListRows } from "../src/lib/list-rows";
import { byActivity, rowKey } from "../src/lib/summary-diff";
import { SessionFeed } from "./session-feed";

function rng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) / 2 ** 32;
  };
}

const row = (n: number, at: number): SessionSummary => ({
  id: `s${n}`, path: `/s/${n}.jsonl`, cwd: "/w", title: `t${n}`, createdAt: "", lastActiveAt: new Date(at).toISOString(), model: null, live: null, busy: false, origin: "web", archived: false,
});
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const tick = () => new Promise((r) => setTimeout(r, 0));

async function run(seed: number, opts: { drop: number }) {
  const rand = rng(seed);
  let clock = 1_000_000;
  let next = 0;
  // The server's truth, in listSessions' order.
  let server: SessionSummary[] = Array.from({ length: 8 }, () => row(next++, clock++));
  const listed = () => clone([...server].sort(byActivity));
  // With no loss, no safety net: the merge alone must be right (a digest would hide its mistakes).
  const feed = new SessionFeed({ list: async () => listed(), intervalMs: opts.drop ? 15 : 3_600_000, debounceMs: 0, minGapMs: 0 });

  let view: SessionSummary[] = [];
  let reading = 0;
  const refetch = () => {
      reading++;
      lr.fetchStarted();
      // The GET: in turn with the re-diffs, as server/app.ts reads it, its body crossing the wire.
      void feed.snapshot(async () => listed()).then(async (snap) => {
        await tick();
        view = lr.snapshot(clone(snap.body), { epoch: snap.epoch, version: snap.version });
        reading--;
      });
  };
  const lr: ListRows = new ListRows({
    refetch,
    publish: (rows) => {
      view = rows;
    },
  });
  lr.socketOpened();
  const remove = feed.add(
    (m: SessionFeedMessage) => {
      const lost = m.type === "rows" && rand() < opts.drop;
      if (!lost) setTimeout(() => lr.message(clone(m)), 0);
    },
    { rows: true },
  );
  await feed.idle();
  // The page's first read, raced with the socket.
  refetch();

  for (let step = 0; step < 60; step++) {
    const k = Math.floor(rand() * 6);
    const i = Math.floor(rand() * server.length);
    const target = server[i];
    if (k === 0 || !target) server = [...server, row(next++, clock++)];
    else if (k === 1) server = server.map((s) => (s === target ? { ...s, lastActiveAt: new Date(clock++).toISOString(), busy: !s.busy } : s));
    else if (k === 2) server = server.map((s) => (s === target ? { ...s, title: `renamed${step}` } : s));
    else if (k === 3) server = server.map((s) => (s === target ? { ...s, archived: !s.archived } : s));
    else if (k === 4) server = server.filter((s) => s !== target);
    else server = server.map((s) => (s === target ? { ...s, outlineNow: `doing ${step}` } : s));
    if (rand() < 0.15) refetch();
    if (rand() < 0.6) feed.nudge(0);
    if (rand() < 0.5) await tick();
  }
  // Settle: the last change compared, the safety nets' digests sent, every read answered.
  for (let i = 0; i < 40; i++) {
    feed.nudge(0);
    await new Promise((r) => setTimeout(r, 20));
    await feed.idle();
    if (!reading && sameList(view, listed())) break;
  }
  remove();
  feed.stop();
  return { view, truth: listed(), refetches: lr.refetches };
}

const sameList = (a: SessionSummary[], b: SessionSummary[]) => a.length === b.length && a.every((s, i) => s.path === b[i]!.path && rowKey(s) === rowKey(b[i]!));

test("the merged list equals a full read, for random change sequences with reads crossing deltas", async () => {
  for (let seed = 1; seed <= 25; seed++) {
    const { view, truth, refetches } = await run(seed, { drop: 0 });
    assert.ok(sameList(view, truth), `seed ${seed}: ${view.map((s) => s.id)} ≠ ${truth.map((s) => s.id)}`);
    assert.equal(refetches, 0, `seed ${seed}: nothing lost, so the merge never needed a re-read`);
  }
});

test("lost frames: the digest (or the next gap) brings the list back to a full read's", async () => {
  let repairs = 0;
  for (let seed = 101; seed <= 115; seed++) {
    const { view, truth, refetches } = await run(seed, { drop: 0.2 });
    assert.ok(sameList(view, truth), `seed ${seed}: ${view.map((s) => s.id)} ≠ ${truth.map((s) => s.id)}`);
    repairs += refetches;
  }
  assert.ok(repairs > 0, "some loss was repaired by a re-read");
});
