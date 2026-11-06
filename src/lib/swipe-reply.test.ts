// Run: pnpm test -- src/lib/swipe-reply.test.ts
// Swipe a message to reply on a touch screen (§chat.transcript/reply): the thresholds, and the
// presses it must leave alone.
import assert from "node:assert/strict";
import { test } from "node:test";
import { canStartSwipe, justArmed, moveSwipe, startSwipe, SWIPE_COMMIT_PX, SWIPE_EDGE_PX, swipeCommits, swipeOffset, type SwipeStartFacts } from "./swipe-reply";

const facts = (over: Partial<SwipeStartFacts> = {}): SwipeStartFacts => ({
  pointerType: "touch",
  x: 120,
  width: 400,
  replyOn: true,
  inField: false,
  inScroller: false,
  selecting: false,
  ...over,
});

/** The track after the finger went through each point, from (100, 300). */
const path = (...pts: [number, number][]) => pts.reduce((t, [x, y]) => moveSwipe(t, x, y), startSwipe(100, 300));

test("only a finger, on a message whose Reply is on, away from the edges, outside fields, side-scrollers and selections", () => {
  assert.equal(canStartSwipe(facts()), true);
  assert.equal(canStartSwipe(facts({ pointerType: "mouse" })), false);
  assert.equal(canStartSwipe(facts({ pointerType: "pen" })), false);
  assert.equal(canStartSwipe(facts({ replyOn: false })), false);
  assert.equal(canStartSwipe(facts({ inField: true })), false);
  assert.equal(canStartSwipe(facts({ inScroller: true })), false, "a code block or table keeps its own sideways pan");
  assert.equal(canStartSwipe(facts({ selecting: true })), false);
  assert.equal(canStartSwipe(facts({ x: SWIPE_EDGE_PX - 1 })), false, "the left edge is the system's back gesture");
  assert.equal(canStartSwipe(facts({ x: 400 - SWIPE_EDGE_PX + 1 })), false, "the right edge too");
  assert.equal(canStartSwipe(facts({ x: SWIPE_EDGE_PX })), true);
});

test("a rightward, sideways swipe of 64px arms; the bubble follows no further", () => {
  const short = path([120, 302], [160, 305]);
  assert.equal(short.mode, "swipe");
  assert.equal(swipeCommits(short), false);
  assert.equal(swipeOffset(short), 60);
  const far = path([120, 302], [164, 305], [220, 306]);
  assert.equal(swipeCommits(far), true);
  assert.equal(swipeOffset(far), SWIPE_COMMIT_PX);
});

test("the buzz comes once, as the swipe reaches the threshold", () => {
  const before = path([120, 302], [160, 304]);
  const at = moveSwipe(before, 164, 304);
  assert.equal(justArmed(before, at), true);
  assert.equal(justArmed(at, moveSwipe(at, 190, 304)), false);
});

test("a gesture that starts vertical is a scroll for the rest of the press", () => {
  const t = path([102, 330], [200, 332]);
  assert.equal(t.mode, "scroll");
  assert.equal(swipeCommits(t), false);
  assert.equal(swipeOffset(t), 0);
});

test("leftward, or not sideways enough, never swipes", () => {
  assert.equal(path([80, 301]).mode, "scroll", "leftward");
  assert.equal(path([120, 312]).mode, "scroll", "20 across, 12 down: not twice as far sideways");
});

test("a swipe that drifts too far up or down by the end doesn't stage", () => {
  const t = path([120, 302], [170, 340]);
  assert.equal(t.mode, "swipe");
  assert.equal(swipeCommits(t), false);
});

test("going back under the threshold disarms; back past the start draws nothing", () => {
  const back = path([120, 302], [170, 303], [130, 303]);
  assert.equal(swipeCommits(back), false);
  assert.equal(swipeOffset(path([120, 301], [90, 301])), 0);
});

test("movement under the slop decides nothing yet", () => {
  assert.equal(path([104, 303]).mode, "undecided");
});
