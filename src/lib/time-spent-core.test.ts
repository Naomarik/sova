// Run: pnpm test -- src/lib/time-spent-core.test.ts
// The clock of §app.subagents-pane/time-spent-counting, on a fake clock: every step of the row order, the idle cutoff,
// resuming, the chat following new text, and which pane counts.
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, test } from "node:test";
import {
  addSeconds,
  addSums,
  countedSession,
  countWords,
  decide,
  idleCutoffMs,
  initialClock,
  MAX_UNSENT_SLICES,
  reduce,
  reportOutcome,
  sessionsOnScreen,
  shownFraction,
  tick,
  type ClockEvent,
  type ClockState,
  type Slice,
  withRunIds,
} from "./time-spent-core";

const A = "/s/a.jsonl";
const B = "/s/b.jsonl";
const T0 = 1_000_000;
/** A recording in a composer outside every pane: the single view's. */
const REC = { id: 1, pane: null };

const run = (s: ClockState, ...events: ClockEvent[]) => events.reduce(reduce, s);
/** A page with sessions on screen and an input at `at`. */
const page = (paths: string[] = [A], at = T0) => run(initialClock(at), { type: "sessions", paths }, { type: "pointer", at, pane: null });
const rowAt = (s: ClockState, at: number) => decide(s, at)?.row ?? null;
const main = (session: string, transcript: number, alignments = 0, words = 0, docs: string[] = []): ClockEvent => ({ type: "main-view", session, view: { transcript, alignments, words, docs } });

describe("when a second counts", () => {
  test("a visible page counts within the cutoff, and blur is not an event at all", () => {
    assert.equal(rowAt(page(), T0 + 1000), "other");
  });
  test("hiding the page stops it at once, and coming back counts again without an input while inside the cutoff", () => {
    const hidden = run(page(), { type: "visible", on: false, at: T0 + 100 });
    assert.equal(decide(hidden, T0 + 200), null);
    assert.equal(rowAt(run(hidden, { type: "visible", on: true, at: T0 + 300 }), T0 + 400), "other");
  });
  test("a page that has seen no input doesn't count", () => {
    assert.equal(decide(run(initialClock(T0), { type: "sessions", paths: [A] }), T0 + 1), null);
  });
  test("idle past the cutoff stops it; any input resumes it at once", () => {
    const s = page();
    assert.equal(rowAt(s, T0 + 59_999), "other");
    assert.equal(decide(s, T0 + 60_000), null);
    for (const e of [
      { type: "pointer", at: T0 + 70_000, pane: null },
      { type: "wheel", at: T0 + 70_000, pane: null },
      { type: "key", at: T0 + 70_000, pane: null },
      { type: "typed", at: T0 + 70_000, pane: null },
    ] satisfies ClockEvent[]) {
      assert.notEqual(decide(reduce(s, e), T0 + 70_001), null, e.type);
    }
  });
  test("settings counts for nothing, and no session on screen counts for nothing", () => {
    assert.equal(decide(run(page(), { type: "elsewhere", on: true }), T0 + 1), null);
    assert.equal(decide(run(page(), { type: "sessions", paths: [] }), T0 + 1), null);
  });
});

describe("the idle cutoff", () => {
  test("grows with the words in view at 250 a minute, capped at 3 minutes", () => {
    assert.equal(idleCutoffMs(0), 60_000);
    assert.equal(idleCutoffMs(250), 120_000);
    assert.equal(idleCutoffMs(500), 180_000);
    assert.equal(idleCutoffMs(100_000), 180_000);
  });
  test("is worked out again as the view changes", () => {
    const s = page();
    assert.equal(decide(s, T0 + 90_000), null);
    const reading = run(s, main(A, 100, 0, 250));
    assert.equal(rowAt(reading, T0 + 90_000), "reading-transcript");
    assert.equal(decide(reading, T0 + 120_000), null);
    const long = run(s, main(A, 100, 0, 5_000));
    assert.equal(rowAt(long, T0 + 179_999), "reading-transcript");
    assert.equal(decide(long, T0 + 180_000), null, "the cap holds however much text is in view");
    const shrunk = run(long, main(A, 100, 0, 0));
    assert.equal(decide(shrunk, T0 + 90_000), null, "the view changing back shortens it");
  });
  test("a worker's words in view extend it too", () => {
    assert.notEqual(decide(run(page(), { type: "worker-view", session: A, view: { area: 100, words: 500 } }), T0 + 170_000), null);
  });
  test("counts words, not characters", () => {
    assert.equal(countWords("  one two\n\tthree\u00a0four  "), 4);
    assert.equal(countWords(""), 0);
  });
});

describe("one row per second, in the order the claim gives", () => {
  // Every step true at once, then each knocked out in turn: each row names the second only when no earlier one does.
  const at = T0 + 1000;
  const all = run(
    page(),
    main(A, 100, 500, 0, ["d1"]),
    { type: "foreground-open", view: { id: 1, kind: "changes", session: A } },
    { type: "wheel", at: at - 200, pane: null },
    { type: "typed", at: at - 100, pane: null },
    { type: "dictating", on: true, at: at - 50, recording: REC },
  );
  test("1 Dictating over everything", () => assert.equal(rowAt(all, at), "dictating"));
  const noVoice = run(all, { type: "dictating", on: false, at: at - 50, recording: REC });
  test("2 Typing next", () => assert.equal(rowAt(noVoice, at), "typing"));
  const noKeys = { ...noVoice, typedAt: -Infinity };
  test("3 Scrolling next", () => assert.equal(rowAt(noKeys, at), "scrolling"));
  const noScroll = { ...noKeys, scrolledAt: -Infinity };
  test("4 a foreground view next", () => assert.equal(rowAt(noScroll, at), "changes"));
  test("4 each foreground view names its own row", () => {
    const over = (kind: "changes" | "tours" | "alignment") => run(page(), main(A, 500), { type: "foreground-open", view: { id: 2, kind, session: A } });
    assert.equal(rowAt(over("tours"), T0 + 1), "tours");
    assert.equal(rowAt(over("alignment"), T0 + 1), "reading-alignments");
  });
  const noFore = run(noScroll, { type: "foreground-close", id: 1 });
  test("5 the largest share of the screen next", () => assert.equal(rowAt(noFore, at), "reading-alignments"));
  test("6 Other last", () => assert.equal(rowAt(run(noFore, main(A, 0)), at), "other"));

  test("the largest share names it: a tie goes to the alignment, and a worker's transcript is Reading Workers", () => {
    assert.equal(rowAt(run(page(), main(A, 500, 100)), T0 + 1), "reading-transcript");
    assert.equal(rowAt(run(page(), main(A, 100, 500)), T0 + 1), "reading-alignments");
    assert.equal(rowAt(run(page(), main(A, 300, 300)), T0 + 1), "reading-alignments");
    const worker = (area: number): ClockEvent => ({ type: "worker-view", session: A, view: { area, words: 0 } });
    assert.equal(rowAt(run(page(), main(A, 300), worker(500)), T0 + 1), "reading-workers");
    assert.equal(rowAt(run(page(), main(A, 500), worker(300)), T0 + 1), "reading-transcript");
    assert.equal(rowAt(run(page(), main(A, 0, 300), worker(300)), T0 + 1), "reading-alignments");
  });
  test("a session pane over the chat hides what is behind it: only the part of a row left of its edge shows", () => {
    assert.equal(shownFraction(300, 1000, Infinity), 1, "beside the chat");
    assert.equal(shownFraction(300, 1000, 650), 0.5);
    assert.equal(shownFraction(300, 1000, 300), 0, "the row starts at the edge");
    assert.equal(shownFraction(300, 1000, 0), 0, "a phone's: the whole chat");
    assert.equal(shownFraction(300, 300, 1000), 0, "no width");
  });
  test("a linked session open in the Agents tab is transcript rows", () => {
    const linked: ClockEvent = { type: "linked-view", session: A, view: { area: 400, words: 0 } };
    assert.equal(rowAt(run(page(), linked), T0 + 1), "reading-transcript");
    assert.equal(rowAt(run(page(), main(A, 100, 300), linked), T0 + 1), "reading-transcript", "its rows add to the transcript's share");
    assert.equal(rowAt(run(page(), main(A, 100, 600), linked), T0 + 1), "reading-alignments");
  });
  test("its words extend the cutoff too", () => {
    const s = run(page(), { type: "linked-view", session: A, view: { area: 400, words: 500 } });
    assert.equal(rowAt(s, T0 + 170_000), "reading-transcript");
  });
  test("type, read, type shows as Typing, Reading, Typing, within about 2 seconds of each change", () => {
    const reading = run(page(), main(A, 500));
    const typed = run(reading, { type: "typed", at: T0 + 1000, pane: null });
    assert.equal(rowAt(typed, T0 + 1500), "typing");
    assert.equal(rowAt(typed, T0 + 3000), "reading-transcript");
    assert.equal(rowAt(run(typed, { type: "typed", at: T0 + 4000, pane: null }), T0 + 4001), "typing");
  });
  test("Scrolling lasts about 1.5 seconds after the last user scroll", () => {
    const s = run(page(), main(A, 500), { type: "wheel", at: T0 + 1000, pane: null });
    assert.equal(rowAt(s, T0 + 2499), "scrolling");
    assert.equal(rowAt(s, T0 + 2500), "reading-transcript");
  });
});

describe("dictating holds the count", () => {
  test("past the cutoff with no key pressed, and the cutoff runs from the recording's end", () => {
    const rec = run(page(), { type: "dictating", on: true, at: T0, recording: REC });
    assert.equal(rowAt(rec, T0 + 170_000), "dictating");
    const ended = run(rec, { type: "dictating", on: false, at: T0 + 170_000, recording: REC });
    assert.equal(rowAt(ended, T0 + 170_001), "other");
    assert.equal(decide(ended, T0 + 230_000), null);
  });
  test("hiding the page stops it even mid-recording", () => {
    assert.equal(decide(run(page(), { type: "dictating", on: true, at: T0, recording: REC }, { type: "visible", on: false, at: T0 + 1 }), T0 + 2), null);
  });
});

describe("a recording in a pane, and the newest input elsewhere", () => {
  const inA = { id: 2, pane: A };
  const start: ClockEvent = { type: "dictating", on: true, at: T0, recording: inA };
  const two = () => run(page([A, B]), { type: "pointer", at: T0, pane: A }, main(B, 500));
  test("A gets Dictating while A is named", () => {
    assert.deepEqual(decide(run(two(), start), T0 + 1000), { session: A, row: "dictating", docs: [] });
  });
  test("the wheel names B: B gets its own row, never Dictating, and A nothing", () => {
    const s = run(two(), start, { type: "wheel", at: T0 + 1000, pane: B });
    assert.deepEqual(decide(s, T0 + 1500), { session: B, row: "scrolling", docs: [] });
    assert.deepEqual(decide(s, T0 + 3000), { session: B, row: "reading-transcript", docs: [] });
  });
  test("the recording goes on holding the count for B, past the cutoff", () => {
    const s = run(two(), start, { type: "wheel", at: T0 + 1000, pane: B });
    assert.deepEqual(decide(s, T0 + 170_000), { session: B, row: "reading-transcript", docs: [] });
    assert.equal(decide(run(s, { type: "dictating", on: false, at: T0 + 2000, recording: inA }), T0 + 170_000), null);
  });
  test("back over A it is Dictating again", () => {
    const s = run(two(), start, { type: "wheel", at: T0 + 1000, pane: B }, { type: "pointer", at: T0 + 5000, pane: A });
    assert.equal(decide(s, T0 + 5001)?.row, "dictating");
    assert.equal(decide(s, T0 + 5001)?.session, A);
  });
  test("two recordings end apart: one ending leaves the other holding", () => {
    const other = { id: 3, pane: B };
    const s = run(two(), start, { type: "dictating", on: true, at: T0, recording: other }, { type: "dictating", on: false, at: T0, recording: inA });
    assert.equal(s.recordings.length, 1);
    assert.equal(rowAt(run(s, { type: "pointer", at: T0, pane: B }), T0 + 170_000), "dictating");
  });
});

describe("only the user's own scrolling", () => {
  test("the chat following new text is neither Scrolling nor activity", () => {
    const idle = run(page(), main(A, 500));
    const followed = run(idle, { type: "scrolled", at: T0 + 30_000 });
    assert.equal(followed, idle, "a scroll with no input behind it changes nothing");
    assert.equal(rowAt(followed, T0 + 30_001), "reading-transcript");
    assert.equal(decide(followed, T0 + 60_000), null, "and doesn't put off the cutoff");
    const stopped = run(idle, { type: "scrolled", at: T0 + 70_000 });
    assert.equal(decide(stopped, T0 + 70_001), null, "and doesn't resume a stopped count");
  });
  test("a scroll right behind a wheel is the user's, and goes on being Scrolling", () => {
    const s = run(page(), main(A, 500), { type: "wheel", at: T0 + 1000, pane: null }, { type: "scrolled", at: T0 + 1200 });
    assert.equal(rowAt(s, T0 + 2600), "scrolling");
  });
  test("once the wheel's moment has passed, a scroll is the chat's again", () => {
    const s = run(page(), main(A, 500), { type: "wheel", at: T0 + 1000, pane: null }, { type: "scrolled", at: T0 + 1400 });
    assert.equal(rowAt(s, T0 + 2600), "reading-transcript");
  });
  test("a fling goes on scrolling after the finger lifts; the scrollbar drag scrolls with no wheel", () => {
    const flung = run(page(), main(A, 500), { type: "fling", at: T0 + 1000 }, { type: "scrolled", at: T0 + 3000 });
    assert.equal(rowAt(flung, T0 + 4000), "scrolling");
    const dragged = run(page(), main(A, 500), { type: "press", on: true, at: T0 + 1000, pane: null }, { type: "scrolled", at: T0 + 9000 });
    assert.equal(rowAt(dragged, T0 + 9500), "scrolling");
    const released = run(dragged, { type: "press", on: false, at: T0 + 9600, pane: null }, { type: "scrolled", at: T0 + 20_000 });
    assert.equal(rowAt(released, T0 + 20_001), "reading-transcript");
  });
  test("the scroll a scroll key starts is the user's; a fling's lift is activity", () => {
    const keyed = run(page(), main(A, 500), { type: "scroll-key", at: T0 + 1000, pane: null }, { type: "scrolled", at: T0 + 1500 });
    assert.equal(rowAt(keyed, T0 + 2600), "scrolling");
    assert.notEqual(decide(run(page(), { type: "fling", at: T0 + 70_000 }), T0 + 70_001), null);
  });
  test("a scroll key outside an input is Scrolling", () => {
    assert.equal(rowAt(run(page(), { type: "scroll-key", at: T0 + 1, pane: null }), T0 + 2), "scrolling");
  });
});

describe("split view: one pane counts", () => {
  const two = () => page([A, B]);
  test("the keyboard in A's composer, the wheel over B: B counts Scrolling, A nothing", () => {
    const s = run(two(), { type: "focus", pane: A }, { type: "wheel", at: T0 + 1000, pane: B });
    assert.deepEqual(decide(s, T0 + 1100), { session: B, row: "scrolling", docs: [] });
  });
  test("with no pointer, the pane holding the keyboard; with neither, the app's focused one", () => {
    assert.equal(countedSession(run(two(), { type: "focused", path: B })), B);
    assert.equal(countedSession(run(two(), { type: "focused", path: B }, { type: "focus", pane: A })), A);
  });
  test("the mouse resting over B, keys in A's composer: A counts Typing, B nothing", () => {
    const s = run(two(), { type: "pointer", at: T0, pane: B }, { type: "typed", at: T0 + 500, pane: A });
    assert.deepEqual(decide(s, T0 + 600), { session: A, row: "typing", docs: [] });
  });
  test("whichever input is newest names the pane, back and forth", () => {
    const typed = run(two(), { type: "typed", at: T0, pane: A });
    const wheeled = run(typed, { type: "wheel", at: T0 + 1, pane: B });
    assert.equal(countedSession(wheeled), B);
    assert.equal(countedSession(run(wheeled, { type: "key", at: T0 + 2, pane: A })), A);
    assert.equal(countedSession(run(wheeled, { type: "scroll-key", at: T0 + 2, pane: A })), A);
    assert.equal(countedSession(run(wheeled, { type: "pointer", at: T0 + 3, pane: A })), A);
  });
  test("typing in A then the wheel over B: B counts Scrolling, not A's Typing", () => {
    const s = run(two(), main(B, 500), { type: "typed", at: T0, pane: A }, { type: "wheel", at: T0 + 1, pane: B });
    assert.deepEqual(decide(s, T0 + 1000), { session: B, row: "scrolling", docs: [] });
  });
  test("the wheel over B then the pointer into A: A reads on, with none of B's Scrolling", () => {
    const s = run(two(), main(A, 500), { type: "wheel", at: T0, pane: B }, { type: "pointer", at: T0 + 1, pane: A });
    assert.equal(rowAt(s, T0 + 1000), "reading-transcript");
    assert.equal(countedSession(s), A);
  });
  test("typing in A, the wheel over B and back: A's window is still its own", () => {
    const s = run(two(), { type: "typed", at: T0, pane: A }, { type: "wheel", at: T0 + 1, pane: B }, { type: "pointer", at: T0 + 2, pane: A });
    assert.equal(rowAt(s, T0 + 1000), "typing");
    assert.notEqual(rowAt(s, T0 + 2000), "typing");
  });
  test("typing outside every pane counts for the pane counted then, and doesn't follow the next input", () => {
    const search = run(two(), { type: "pointer", at: T0, pane: B }, { type: "typed", at: T0 + 1, pane: null });
    assert.deepEqual(decide(search, T0 + 2), { session: B, row: "typing", docs: [] });
    assert.equal(rowAt(run(search, { type: "pointer", at: T0 + 2, pane: A }), T0 + 3), "other");
  });
  test("a raw scroll behind the wheel stays with the pane under the wheel", () => {
    const s = run(two(), { type: "wheel", at: T0, pane: B }, { type: "scrolled", at: T0 + 100 });
    assert.equal(s.scrolledPane, B);
  });
  test("a mouse press names the pane under it", () => {
    assert.equal(countedSession(run(two(), { type: "pointer", at: T0, pane: A }, { type: "press", on: true, at: T0 + 1, pane: B })), B);
  });
  test("a key's pane also holds the keyboard: when the pane the mouse named leaves, the count falls back to it", () => {
    const s = run(two(), { type: "key", at: T0, pane: A }, { type: "pointer", at: T0 + 1, pane: B }, { type: "sessions", paths: [A] }, { type: "sessions", paths: [A, B] });
    assert.equal(countedSession(s), A);
  });
  test("an input over a pane that isn't on screen names nothing: the last pane stays", () => {
    assert.equal(countedSession(run(two(), { type: "pointer", at: T0, pane: A }, { type: "pointer", at: T0 + 1, pane: "/s/behind.jsonl" })), A);
    assert.equal(countedSession(run(two(), { type: "focus", pane: A }, { type: "focus", pane: "/s/behind.jsonl" })), A);
  });
  test("a pane that left the screen holds the keyboard no longer when it comes back", () => {
    const s = run(two(), { type: "focus", pane: A }, { type: "sessions", paths: [B] }, { type: "sessions", paths: [A, B] }, { type: "focused", path: B });
    assert.equal(countedSession(s), B);
  });
  test("focus moving is no input: it doesn't take the count from the pane the newest input named", () => {
    assert.equal(countedSession(run(two(), { type: "wheel", at: T0, pane: B }, { type: "focus", pane: A })), B);
  });
  test("a key outside every pane names none: the last pane stays", () => {
    assert.equal(countedSession(run(two(), { type: "pointer", at: T0, pane: B }, { type: "key", at: T0 + 1, pane: null })), B);
  });
  test("a pointer outside every pane keeps the last pane", () => {
    assert.equal(countedSession(run(two(), { type: "pointer", at: T0, pane: B }, { type: "pointer", at: T0 + 1, pane: null })), B);
  });
  test("two panes and no signal count nothing rather than guess; one session needs no signal", () => {
    assert.equal(countedSession(two()), null);
    assert.equal(countedSession(page([A])), A);
  });
  test("a pane leaving the screen stops being counted, and a tab behind the front one is not a pane", () => {
    const s = run(two(), { type: "pointer", at: T0, pane: B }, { type: "sessions", paths: [A] });
    assert.equal(countedSession(s), A);
    assert.equal(s.inputPane, null);
    assert.equal(countedSession(run(page([A]), { type: "pointer", at: T0, pane: B })), A);
  });
  test("the session pane is on screen only where no view is: the Agents board's", () => {
    assert.deepEqual(sessionsOnScreen([], [A]), [A], "the board");
    assert.deepEqual(sessionsOnScreen([B], [A]), [B], "a workspace tab behind B keeps its pane, not the count");
    assert.deepEqual(sessionsOnScreen([A, A], [A]), [A], "a session listed twice is one");
  });
  test("a dialog counts for the session it opened over, wherever the pointer goes", () => {
    const s = run(two(), { type: "pointer", at: T0, pane: B }, { type: "foreground-open", view: { id: 3, kind: "tours", session: A } }, { type: "pointer", at: T0 + 1, pane: B });
    assert.deepEqual(decide(s, T0 + 2), { session: A, row: "tours", docs: [] });
  });
});

describe("a card's on-screen time is a separate count", () => {
  test("a card on screen while typing grows the card and counts as Typing", () => {
    const s = run(page(), main(A, 100, 300, 0, ["d1"]), { type: "typed", at: T0 + 1, pane: null });
    assert.deepEqual(decide(s, T0 + 2), { session: A, row: "typing", docs: ["d1"] });
  });
  test("a report view counts its own document; a changes viewer over the chat hides the cards", () => {
    const base = run(page(), main(A, 100, 300, 0, ["d1"]));
    assert.deepEqual(decide(run(base, { type: "foreground-open", view: { id: 4, kind: "alignment", doc: "d2", session: A } }), T0 + 1)?.docs, ["d2"]);
    assert.deepEqual(decide(run(base, { type: "foreground-open", view: { id: 5, kind: "changes", session: A } }), T0 + 1)?.docs, []);
  });
});

describe("whole seconds", () => {
  test("a tick counts only whole seconds and keeps the rest", () => {
    let s = page();
    const counts: number[] = [];
    for (const at of [T0 + 600, T0 + 1200, T0 + 1800, T0 + 2400]) {
      const t = tick(s, at);
      counts.push(t.seconds);
      s = t.state;
    }
    assert.deepEqual(counts, [0, 1, 0, 1]);
  });
  test("a paused second isn't carried into the next count", () => {
    const paused = run(page(), { type: "visible", on: false, at: T0 + 500 });
    assert.equal(tick(paused, T0 + 1500).seconds, 0);
  });
  test("a pause drops the part-second it had, and time hidden is never counted on the way back", () => {
    const part = tick(page(), T0 + 600).state;
    assert.equal(part.carry, 600);
    assert.equal(tick(run(part, { type: "visible", on: false, at: T0 + 700 }), T0 + 800).state.carry, 0);
    assert.equal(tick({ ...part, lastActiveAt: -Infinity }, T0 + 800).state.carry, 0, "idle drops it too");
    const back = run(part, { type: "visible", on: false, at: T0 + 700 }, { type: "visible", on: true, at: T0 + 4_000 });
    assert.equal(tick(back, T0 + 4_100).seconds, 0, "3 hidden seconds aren't in the first tick back");
  });
  test("a page frozen for minutes counts none of the gap", () => {
    const s = run(page(), { type: "dictating", on: true, at: T0, recording: REC });
    assert.equal(tick(s, T0 + 120_000).seconds, 0);
  });
});

describe("the ledger", () => {
  const typing = { row: "typing" as const, docs: [] };
  test("adjacent identical seconds merge; a new row or a gap starts a run", () => {
    let l: Slice[] = addSeconds([], typing, 1, 1000);
    l = addSeconds(l, typing, 1, 2000);
    assert.deepEqual(l, [{ row: "typing", docs: [], sec: 2, endAt: 2000 }]);
    l = addSeconds(l, { row: "other", docs: [] }, 1, 3000);
    assert.equal(l.length, 2);
    l = addSeconds(l, { row: "other", docs: [] }, 1, 90_000);
    assert.equal(l.length, 3, "a long gap is a new run: it isn't one moment");
    l = addSeconds(l, { row: "other", docs: ["d"] }, 1, 91_000);
    assert.equal(l.length, 4, "other documents on screen are a new run");
  });
  test("a run sent once takes no more seconds, and the next seconds start a run with no id of its own", () => {
    const first = withRunIds(addSeconds([], typing, 3, 3000), 7);
    assert.deepEqual(first.slices.map((s) => s.id), [7]);
    assert.equal(first.nextId, 8);
    const after = addSeconds(first.slices, typing, 1, 4000);
    assert.equal(after.length, 2, "the host would drop these as part of a resend");
    assert.equal(after[0]!.sec, 3);
    assert.equal(after[1]!.id, undefined);
    assert.equal(after[1]!.sec, 1);
  });
  test("a resend keeps its ids, and only new runs get new ones", () => {
    const first = withRunIds(addSeconds([], typing, 3, 3000), 1);
    const again = withRunIds(addSeconds(first.slices, { row: "other", docs: [] }, 1, 4000), first.nextId);
    assert.deepEqual(again.slices.map((s) => [s.id, s.sec]), [[1, 3], [2, 1]]);
    assert.equal(again.nextId, 3);
    const thrice = withRunIds(again.slices, again.nextId);
    assert.deepEqual(thrice.slices.map((s) => s.id), [1, 2], "nothing new, nothing renumbered");
    assert.equal(thrice.nextId, 3);
  });
  test("what is kept is bounded, and the oldest goes first", () => {
    let l: Slice[] = [];
    for (let i = 0; i < MAX_UNSENT_SLICES + 10; i++) l = addSeconds(l, { row: i % 2 ? "typing" : "other", docs: [] }, 1, i * 1000);
    assert.equal(l.length, MAX_UNSENT_SLICES);
    assert.equal(l[0]!.endAt, 10_000);
    assert.equal(l[l.length - 1]!.endAt, (MAX_UNSENT_SLICES + 9) * 1000);
  });
  test("rows add up to the total, and a card's seconds overlap them", () => {
    const sums = addSums({ you: 0, rows: {}, cards: {} }, [
      { row: "typing", docs: ["d"], sec: 3, endAt: 1 },
      { row: "other", docs: [], sec: 2, endAt: 2 },
      { row: "typing", docs: ["d"], sec: 1, endAt: 3 },
    ]);
    assert.deepEqual(sums, { you: 6, rows: { typing: 4, other: 2 }, cards: { d: 4 } });
  });
  test("a refusal or a too-old host is told from a network failure", () => {
    assert.equal(reportOutcome(200), "accepted");
    assert.equal(reportOutcome(403), "refused");
    assert.equal(reportOutcome(404), "refused");
    assert.equal(reportOutcome(400), "rejected");
    assert.equal(reportOutcome(500), "failed");
    assert.equal(reportOutcome(502), "failed");
    assert.equal(reportOutcome(null), "failed");
  });
});

describe("share pages never count", () => {
  const SRC = join(import.meta.dirname, "..");
  /** Every file a module reaches through relative imports. */
  function graph(entry: string, seen = new Set<string>()): Set<string> {
    if (seen.has(entry)) return seen;
    seen.add(entry);
    for (const m of readFileSync(entry, "utf8").matchAll(/(?:from|import)\s*\(?\s*"(\.[^"]+)"/g)) {
      const base = join(dirname(entry), m[1]!);
      const file = [base, `${base}.ts`, `${base}.tsx`].find((f) => existsSync(f) && !f.endsWith(".css") && /\.tsx?$/.test(f));
      if (file) graph(file, seen);
    }
    return seen;
  }
  test("no share page's code reaches the one call that starts the tracker", () => {
    const share = join(SRC, "share");
    const pages = readdirSync(share).filter((f) => /\.tsx?$/.test(f));
    assert.ok(pages.includes("main.tsx"));
    for (const page of pages) {
      const reached = [...graph(join(share, page))].map((f) => f.slice(SRC.length));
      assert.ok(reached.length > 1 || page.endsWith(".ts"), `${page} imports something`);
      assert.deepEqual(reached.filter((f) => f === "/App.tsx"), [], page);
    }
    const starters = (readdirSync(SRC, { recursive: true }) as string[])
      .filter((f) => /\.tsx?$/.test(f) && !f.endsWith(".test.ts"))
      .filter((f) => /\bstartTimeSpent\(/.test(readFileSync(join(SRC, f), "utf8")));
    assert.deepEqual(starters.sort(), ["App.tsx", "lib/time-spent.ts"], "App calls it, and time-spent.ts defines it");
  });
  test("the walk can tell the two apart: the page that starts it is found from the app's entry", () => {
    assert.ok([...graph(join(SRC, "main.tsx"))].some((f) => f.endsWith("/App.tsx")));
  });
});
