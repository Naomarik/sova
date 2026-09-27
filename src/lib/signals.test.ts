import assert from "node:assert/strict";
import { test } from "node:test";
import { type SessionSignals, type SessionSummary, TAG_STATUSES, TAG_TOPICS, type SignalKind } from "../../shared/protocol";
import {
  applyMarks,
  createNudgeThrottle,
  EMPTY_OVERLAY,
  overlaid,
  rowLeadMark,
  rowNeedsYou,
  SIGNAL_CLASS,
  SIGNAL_ICON,
  SIGNAL_PRECEDENCE,
  signalTitle,
  signalWords,
  tagSearchText,
  tagStatusWord,
  tagsTitle,
  tagTopicWord,
  turnErrorTitle,
} from "./signals";
import { reuseUnchanged } from "./summary-diff";

const sig = (kinds: SignalKind[], at = 100): SessionSignals => ({ at, turnId: "t1", provider: "jev", kinds });
const row = (over: Partial<SessionSummary> = {}): SessionSummary =>
  ({ id: "a", path: "/s/a.jsonl", cwd: "/w", title: "T", createdAt: "", lastActiveAt: "", ...over }) as SessionSummary;
const open = { selected: null, busy: false };

const align = (openQuestions: number, questionDocs = 1) => ({ openDocs: 2, openQuestions, questionDocs, lead: { id: "al_3", title: "Autonomy" } });

test("the mark is the most urgent kind the server sent, never one it didn't", () => {
  assert.equal(rowNeedsYou(row(), open), null);
  assert.equal(rowNeedsYou(row({ signals: sig([]) }), open), null, "a classified turn with no kinds shows nothing");
  assert.deepEqual(rowNeedsYou(row({ signals: sig(["looping"]) }), open), { kind: "looping", worker: false });
  // Raw answers far past any threshold don't make a mark: the kinds are the server's word.
  const raw = { ...sig([]), stuck: { score: 2, confidence: 1 } };
  assert.equal(rowNeedsYou(row({ signals: raw }), open), null);
});

test("open alignment questions come first, carry the counts, and a visit never clears them", () => {
  const s = row({ align: align(3), signals: sig(["looping"], 100), workerSignals: { stuck: 1 } });
  assert.deepEqual(rowNeedsYou(s, open), { kind: "questions", worker: false, align: align(3) });
  assert.deepEqual(rowNeedsYou({ ...s, seenAt: 500 }, open)?.kind, "questions", "a fact of the file, not news");
  assert.equal(rowNeedsYou(s, { selected: s.path, busy: false }), null, "never on the open session");
  assert.equal(rowNeedsYou(s, { selected: null, busy: true }), null, "never while this tab runs a turn there");
  assert.deepEqual(rowNeedsYou(row({ align: { openDocs: 1, openQuestions: 0, questionDocs: 0 } }), open), null, "open but asking nothing: no mark");
  const m = rowNeedsYou(s, open)!;
  assert.equal(signalWords(m), "3 open questions. ");
  assert.equal(signalTitle(m), "3 open questions in al_3 Autonomy");
  assert.equal(signalTitle({ kind: "questions", worker: false, align: align(1, 1) }), "1 open question in al_3 Autonomy");
  assert.equal(signalTitle({ kind: "questions", worker: false, align: align(4, 2) }), "4 open questions in 2 alignments");
  assert.equal(signalWords({ kind: "questions", worker: false, align: align(1) }), "1 open question. ");
});

test("hidden on the open session, while this tab runs a turn, and once seen after the turn", () => {
  const s = row({ signals: sig(["looping"], 100) });
  assert.equal(rowNeedsYou(s, { selected: s.path, busy: false }), null);
  assert.equal(rowNeedsYou(s, { selected: null, busy: true }), null);
  assert.equal(rowNeedsYou({ ...s, seenAt: 100 }, open), null);
  assert.notEqual(rowNeedsYou({ ...s, seenAt: 99 }, open), null, "seen before the turn: still shows");
  assert.notEqual(rowNeedsYou(s, { selected: "/s/other.jsonl", busy: false }), null);
});

test("subagent counts mark the parent row, below the session's own kind of the same urgency", () => {
  assert.deepEqual(rowNeedsYou(row({ workerSignals: { stuck: 1 } }), open), { kind: "looping", worker: true });
  assert.equal(rowNeedsYou(row({ workerSignals: { stuck: 0 } }), open), null);
  // At the same kind, the session's own wins over a worker's.
  assert.deepEqual(rowNeedsYou(row({ signals: sig(["looping"]), workerSignals: { stuck: 1 } }), open), { kind: "looping", worker: false });
  // Seen hides the session's own signal, not its workers' (the server sends those only while they apply).
  assert.deepEqual(rowNeedsYou(row({ signals: sig(["looping"], 5), seenAt: 9, workerSignals: { stuck: 1 } }), open), { kind: "looping", worker: true });
});

test("line 1 leads with ONE state mark: the turn error in the unread dot's place, else the dot", () => {
  assert.equal(rowLeadMark(row(), null), null);
  assert.equal(rowLeadMark(row({ unread: true }), null), "unread");
  assert.equal(rowLeadMark(row({ turnError: {} }), null), "error", "a never-stamped session has no unread, and still shows the error");
  assert.equal(rowLeadMark(row({ unread: true, turnError: { message: "overloaded" } }), null), "error", "the error wins the slot");
  assert.equal(rowLeadMark(row({ unread: true, turnError: {} }), "/s/a.jsonl"), null, "never on the open session");
  // The error is no needs-you kind: it never reaches the signal mark after it.
  assert.equal(rowNeedsYou(row({ turnError: {} }), open), null);
});

test("the turn-error tooltip says the fact, then pi's message when there is one", () => {
  assert.equal(turnErrorTitle({}), "The last turn stopped with an error.");
  assert.equal(turnErrorTitle({ message: "429 rate limited" }), "The last turn stopped with an error: 429 rate limited");
});

test("every kind has its own glyph, class and words", () => {
  assert.deepEqual([...SIGNAL_PRECEDENCE], ["questions", "looping"]);
  const icons = SIGNAL_PRECEDENCE.map((k) => SIGNAL_ICON[k]);
  const classes = SIGNAL_PRECEDENCE.map((k) => SIGNAL_CLASS[k]);
  const words = SIGNAL_PRECEDENCE.flatMap((k) => [signalWords({ kind: k, worker: false }), signalWords({ kind: k, worker: true })]);
  assert.equal(new Set(icons).size, SIGNAL_PRECEDENCE.length);
  assert.equal(new Set(classes).size, SIGNAL_PRECEDENCE.length);
  // A worker only ever speaks for "looping"; open questions are the session's own, whatever the flag.
  assert.equal(new Set(words).size, 3, "worker and session words differ except where one never applies");
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
  const listed = row({ signals: sig(["looping"]), tags: { status: "done" } });
  assert.equal(overlaid(listed, EMPTY_OVERLAY), listed, "no snapshot yet: the list's own fields");
  const full = applyMarks(EMPTY_OVERLAY, { full: true, sessions: [] });
  const bare = overlaid(listed, full);
  assert.equal(bare.signals, undefined, "a session the snapshot doesn't name has no marks");
  assert.equal(bare.tags, undefined);
  assert.equal(overlaid(listed, full, true), listed, "a peer's row keeps its list fields");
});

test("the feed: deltas set, clear with null, and leave absent fields alone", () => {
  let o = applyMarks(EMPTY_OVERLAY, { full: true, sessions: [{ id: "a", path: "/s/a.jsonl", signals: sig(["looping"]), tags: { status: "done" } }] });
  o = applyMarks(o, { sessions: [{ id: "a", path: "/s/a.jsonl", signals: null }] });
  const s = overlaid(row(), o);
  assert.equal(s.signals, undefined);
  assert.deepEqual(s.tags, { status: "done" });
  o = applyMarks(o, { sessions: [{ id: "a", path: "/s/a.jsonl", workerSignals: { stuck: 1 } }] });
  assert.deepEqual(overlaid(row(), o).workerSignals, { stuck: 1 });
  // The turn-error mark rides the same feed: it appears and clears without a list read.
  o = applyMarks(o, { sessions: [{ id: "a", path: "/s/a.jsonl", turnError: { message: "boom" } }] });
  assert.deepEqual(overlaid(row(), o).turnError, { message: "boom" });
  assert.equal(overlaid(row({ turnError: { message: "boom" } }), applyMarks(o, { sessions: [{ id: "a", path: "/s/a.jsonl", turnError: null }] })).turnError, undefined);
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
