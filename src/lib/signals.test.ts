import assert from "node:assert/strict";
import { test } from "node:test";
import { type SessionSignals, type SessionSummary, TAG_STATUSES, TAG_TOPICS, type SignalKind } from "../../shared/protocol";
import {
  applyMarks,
  createNudgeThrottle,
  EMPTY_OVERLAY,
  overlaid,
  rowNeedsYou,
  SIGNAL_CLASS,
  SIGNAL_ICON,
  SIGNAL_PRECEDENCE,
  signalWords,
  tagSearchText,
  tagStatusWord,
  tagsTitle,
  tagTopicWord,
} from "./signals";
import { reuseUnchanged } from "./summary-diff";

const sig = (kinds: SignalKind[], at = 100): SessionSignals => ({ at, turnId: "t1", provider: "jev", kinds });
const row = (over: Partial<SessionSummary> = {}): SessionSummary =>
  ({ id: "a", path: "/s/a.jsonl", cwd: "/w", title: "T", createdAt: "", lastActiveAt: "", ...over }) as SessionSummary;
const open = { selected: null, busy: false };

test("the mark is the most urgent kind the server sent, never one it didn't", () => {
  assert.equal(rowNeedsYou(row(), open), null);
  assert.equal(rowNeedsYou(row({ signals: sig([]) }), open), null, "a classified turn with no kinds shows nothing");
  assert.deepEqual(rowNeedsYou(row({ signals: sig(["looping", "asks-you"]) }), open), { kind: "asks-you", worker: false });
  assert.deepEqual(rowNeedsYou(row({ signals: sig(["asks-you", "task-failed", "looping"]) }), open), { kind: "task-failed", worker: false });
  // Raw answers far past any threshold don't make a mark: the kinds are the server's word.
  const raw = { ...sig([]), asksUser: 0.99, outcome: { choice: "failed" as const, confidence: 1 } };
  assert.equal(rowNeedsYou(row({ signals: raw }), open), null);
});

test("hidden on the open session, while this tab runs a turn, and once seen after the turn", () => {
  const s = row({ signals: sig(["asks-you"], 100) });
  assert.equal(rowNeedsYou(s, { selected: s.path, busy: false }), null);
  assert.equal(rowNeedsYou(s, { selected: null, busy: true }), null);
  assert.equal(rowNeedsYou({ ...s, seenAt: 100 }, open), null);
  assert.notEqual(rowNeedsYou({ ...s, seenAt: 99 }, open), null, "seen before the turn: still shows");
  assert.notEqual(rowNeedsYou(s, { selected: "/s/other.jsonl", busy: false }), null);
});

test("subagent counts mark the parent row, below the session's own kind of the same urgency", () => {
  assert.deepEqual(rowNeedsYou(row({ workerSignals: { stuck: 1, failed: 0 } }), open), { kind: "looping", worker: true });
  assert.deepEqual(rowNeedsYou(row({ workerSignals: { stuck: 1, failed: 2 } }), open), { kind: "task-failed", worker: true });
  assert.equal(rowNeedsYou(row({ workerSignals: { stuck: 0, failed: 0 } }), open), null);
  // A failed worker outranks the session's own asks-you (precedence is by kind first) …
  assert.deepEqual(rowNeedsYou(row({ signals: sig(["asks-you"]), workerSignals: { stuck: 0, failed: 1 } }), open), { kind: "task-failed", worker: true });
  // … but the session's own failure wins over a worker's.
  assert.deepEqual(rowNeedsYou(row({ signals: sig(["task-failed"]), workerSignals: { stuck: 0, failed: 1 } }), open), { kind: "task-failed", worker: false });
  // Seen hides the session's own signal, not its workers' (the server sends those only while they apply).
  assert.deepEqual(rowNeedsYou(row({ signals: sig(["asks-you"], 5), seenAt: 9, workerSignals: { stuck: 1, failed: 0 } }), open), { kind: "looping", worker: true });
});

test("every kind has its own glyph, class and words", () => {
  assert.deepEqual([...SIGNAL_PRECEDENCE].sort(), ["asks-you", "looping", "task-failed"]);
  const icons = SIGNAL_PRECEDENCE.map((k) => SIGNAL_ICON[k]);
  const classes = SIGNAL_PRECEDENCE.map((k) => SIGNAL_CLASS[k]);
  const words = SIGNAL_PRECEDENCE.flatMap((k) => [signalWords({ kind: k, worker: false }), signalWords({ kind: k, worker: true })]);
  assert.equal(new Set(icons).size, 3);
  assert.equal(new Set(classes).size, 3);
  assert.equal(new Set(words).size, 5, "worker and session words differ except where one never applies");
  for (const w of words) assert.match(w, /\. $/, "hidden words end a sentence before the title");
});

test("status words: every status has one, lowercase, and absent means none", () => {
  for (const st of TAG_STATUSES) assert.match(tagStatusWord({ status: st }) ?? "", /^[a-z ]+$/);
  assert.equal(tagStatusWord({ status: "in_progress" }), "in progress");
  assert.equal(tagStatusWord({ topic: "docs" }), null);
  assert.equal(tagStatusWord(undefined), null);
  for (const t of TAG_TOPICS) assert.ok(tagTopicWord({ topic: t }));
  assert.equal(tagTopicWord({ topic: "bugfix" }), "bug fix");
});

test("search matches a tag by id and by its display word, and the user's own tags", () => {
  const text = tagSearchText({ topic: "bugfix", status: "in_progress", user: ["release"] });
  for (const q of ["bugfix", "bug fix", "in_progress", "in progress", "release"]) assert.ok(text.includes(q), q);
  assert.equal(tagSearchText(undefined), "");
});

test("line 3's title names what is tagged, and nothing when nothing is", () => {
  assert.equal(tagsTitle({ topic: "bugfix", status: "done" }), "Topic: bug fix · status: done (tagged automatically)");
  assert.equal(tagsTitle({ status: "done" }), "Status: done (tagged automatically)");
  assert.equal(tagsTitle({ user: ["x"] }), null);
  assert.equal(tagsTitle(undefined), null);
});

test("the feed: nothing applies before a full snapshot; then it is the whole truth for this host", () => {
  const listed = row({ signals: sig(["asks-you"]), tags: { status: "done" } });
  assert.equal(overlaid(listed, EMPTY_OVERLAY), listed, "no snapshot yet: the list's own fields");
  const full = applyMarks(EMPTY_OVERLAY, { full: true, sessions: [] });
  const bare = overlaid(listed, full);
  assert.equal(bare.signals, undefined, "a session the snapshot doesn't name has no marks");
  assert.equal(bare.tags, undefined);
  assert.equal(overlaid(listed, full, true), listed, "a peer's row keeps its list fields");
});

test("the feed: deltas set, clear with null, and leave absent fields alone", () => {
  let o = applyMarks(EMPTY_OVERLAY, { full: true, sessions: [{ id: "a", path: "/s/a.jsonl", signals: sig(["asks-you"]), tags: { status: "done" } }] });
  o = applyMarks(o, { sessions: [{ id: "a", path: "/s/a.jsonl", signals: null }] });
  const s = overlaid(row(), o);
  assert.equal(s.signals, undefined);
  assert.deepEqual(s.tags, { status: "done" });
  o = applyMarks(o, { sessions: [{ id: "a", path: "/s/a.jsonl", workerSignals: { stuck: 1, failed: 0 } }] });
  assert.deepEqual(overlaid(row(), o).workerSignals, { stuck: 1, failed: 0 });
  assert.deepEqual(overlaid(row(), o).tags, { status: "done" });
  // A new full snapshot replaces everything the deltas built.
  o = applyMarks(o, { full: true, sessions: [] });
  assert.deepEqual(overlaid(row({ tags: { status: "done" } }), o).tags, undefined);
});

test("the feed keeps row identity: untouched rows are the same object, changed rows are new", () => {
  const a = row({ tags: { status: "done" } });
  const b = row({ id: "b", path: "/s/b.jsonl" });
  const o = applyMarks(EMPTY_OVERLAY, { full: true, sessions: [{ id: "a", path: a.path, tags: { status: "done" } }] });
  assert.equal(overlaid(a, o), a);
  assert.equal(overlaid(b, o), b);
  const o2 = applyMarks(o, { sessions: [{ id: "b", path: b.path, signals: sig(["looping"]) }] });
  const first = [a, b].map((s) => overlaid(s, o2));
  assert.equal(first[0], a);
  assert.notEqual(first[1], b);
  // Recomputed on a later, unrelated message: reuseUnchanged hands back the same objects.
  const o3 = applyMarks(o2, { sessions: [{ id: "c", path: "/s/c.jsonl", tags: { topic: "docs" } }] });
  const again = reuseUnchanged([a, b].map((s) => overlaid(s, o3)), first);
  assert.equal(again[1], first[1]);
});

/** A hand-cranked clock: timers fire only when the test advances time past them. */
function fakeTimers() {
  let t = 0;
  let seq = 0;
  const due = new Map<number, { at: number; fn: () => void }>();
  return {
    now: () => t,
    setTimeout: (fn: () => void, ms: number) => (due.set(++seq, { at: t + ms, fn }), seq),
    clearTimeout: (h: unknown) => void due.delete(h as number),
    advance(ms: number) {
      t += ms;
      for (const [h, d] of [...due].sort((a, b) => a[1].at - b[1].at)) if (d.at <= t) (due.delete(h), d.fn());
    },
    pending: () => due.size,
  };
}

test("list nudges: the first re-reads at once, a burst folds into one trailing read after the gap", () => {
  const clock = fakeTimers();
  let reads = 0;
  const n = createNudgeThrottle(() => reads++, 1000, clock);
  n.nudge();
  assert.equal(reads, 1, "an idle feed's nudge reads the list now");
  n.nudge();
  n.nudge();
  n.nudge();
  assert.equal(reads, 1, "nudges inside the gap wait");
  assert.equal(clock.pending(), 1, "and share one timer");
  clock.advance(999);
  assert.equal(reads, 1);
  clock.advance(1);
  assert.equal(reads, 2, "the burst ends in exactly one more read, so the last change is never missed");
  clock.advance(5000);
  assert.equal(reads, 2, "and nothing more without a new nudge");
  n.nudge();
  assert.equal(reads, 3, "after the gap a nudge reads at once again");
});

test("list nudges: cancel drops a waiting read (the sidebar going away)", () => {
  const clock = fakeTimers();
  let reads = 0;
  const n = createNudgeThrottle(() => reads++, 1000, clock);
  n.nudge();
  n.nudge();
  n.cancel();
  clock.advance(2000);
  assert.equal(reads, 1);
  n.nudge();
  assert.equal(reads, 2, "a cancelled throttle still works for the next nudge");
});
