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
  tick,
  type ClockEvent,
  type ClockState,
  type Slice,
} from "./time-spent-core";

const A = "/s/a.jsonl";
const B = "/s/b.jsonl";
const T0 = 1_000_000;

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
  test("words of the transcript a phone's session pane covers don't extend it", () => {
    const s = run(page(), main(A, 100, 0, 5_000), { type: "covered", session: A, on: true });
    assert.equal(decide(s, T0 + 60_000), null);
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
    { type: "dictating", on: true, at: at - 50 },
  );
  test("1 Dictating over everything", () => assert.equal(rowAt(all, at), "dictating"));
  const noVoice = run(all, { type: "dictating", on: false, at: at - 50 });
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
  const noFore = run(noScroll, { type: "foreground-close", id: 1, at });
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
  test("a phone's session pane covers the chat: its rows aren't on screen, the worker view is", () => {
    const covered = run(page(), main(A, 900, 900, 0, ["d1"]), { type: "covered", session: A, on: true });
    assert.equal(rowAt(covered, T0 + 1), "other");
    assert.deepEqual(decide(covered, T0 + 1)?.docs, []);
    assert.equal(rowAt(run(covered, { type: "worker-view", session: A, view: { area: 100, words: 0 } }), T0 + 1), "reading-workers");
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
    const rec = run(page(), { type: "dictating", on: true, at: T0 });
    assert.equal(rowAt(rec, T0 + 170_000), "dictating");
    const ended = run(rec, { type: "dictating", on: false, at: T0 + 170_000 });
    assert.equal(rowAt(ended, T0 + 170_001), "other");
    assert.equal(decide(ended, T0 + 230_000), null);
  });
  test("hiding the page stops it even mid-recording", () => {
    assert.equal(decide(run(page(), { type: "dictating", on: true, at: T0 }, { type: "visible", on: false, at: T0 + 1 }), T0 + 2), null);
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
  test("the latest pointer wins over the keyboard however recent the key", () => {
    const s = run(two(), { type: "pointer", at: T0, pane: B }, { type: "typed", at: T0 + 500, pane: A });
    assert.equal(countedSession(s), B);
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
    assert.equal(s.pointerPane, null);
    assert.equal(countedSession(run(page([A]), { type: "pointer", at: T0, pane: B })), A);
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
    assert.equal(tick(paused, T0 + 1500).state.carry, 0);
  });
  test("a page frozen for minutes counts none of the gap", () => {
    const s = run(page(), { type: "dictating", on: true, at: T0 });
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
