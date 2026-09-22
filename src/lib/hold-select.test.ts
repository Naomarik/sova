// Run: npx tsx --test src/lib/hold-select.test.ts
// The press-and-hold gesture, driven by hand on a fake clock: what makes a hold, what cancels one,
// and what the click it leaves behind is allowed to do.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createHoldGesture, HOLD_MOVE_PX, HOLD_MS, HOLD_SUPPRESS_MS } from "./hold-select";

/** A clock and a task queue the test drives: `tick(ms)` runs whatever was due by then. */
function rig() {
  let clock = 0;
  let held = 0;
  const due = new Map<number, { at: number; fn: () => void }>();
  let seq = 0;
  const gesture = createHoldGesture({
    onHold: () => void held++,
    now: () => clock,
    schedule: (fn, ms) => {
      due.set(++seq, { at: clock + ms, fn });
      return seq;
    },
    unschedule: (h) => void due.delete(h as number),
  });
  const tick = (ms: number) => {
    clock += ms;
    for (const [id, task] of [...due]) {
      if (task.at <= clock) {
        due.delete(id);
        task.fn();
      }
    }
  };
  return { gesture, tick, holds: () => held, pending: () => due.size };
}

test("a press that stays put becomes a hold, once, after the delay", () => {
  const { gesture, tick, holds } = rig();
  gesture.start({ x: 100, y: 200 });
  tick(HOLD_MS - 1);
  assert.equal(holds(), 0, "not yet: a click is shorter than this");
  tick(1);
  assert.equal(holds(), 1);
  assert.equal(gesture.held(), true);
  tick(HOLD_MS * 4);
  assert.equal(holds(), 1, "a hold fires once, however long the press lasts");
});

test("drift inside the tolerance is still a hold; past it, the press is a drag or a scroll", () => {
  const drift = (dx: number, dy: number) => {
    const { gesture, tick, holds } = rig();
    gesture.start({ x: 100, y: 200 });
    tick(100);
    gesture.move({ x: 100 + dx, y: 200 + dy });
    tick(HOLD_MS);
    return holds();
  };
  assert.equal(drift(0, 0), 1);
  assert.equal(drift(HOLD_MOVE_PX, 0), 1);
  assert.equal(drift(0, -HOLD_MOVE_PX), 1);
  assert.equal(drift(HOLD_MOVE_PX + 1, 0), 0, "a drag starts sideways");
  assert.equal(drift(0, HOLD_MOVE_PX + 1), 0, "a scroll starts downwards");
  assert.equal(drift(-40, 60), 0);
});

test("a moved press cannot come back: the timer is gone, not paused", () => {
  const { gesture, tick, holds, pending } = rig();
  gesture.start({ x: 0, y: 0 });
  gesture.move({ x: 0, y: 400 });
  assert.equal(pending(), 0);
  gesture.move({ x: 0, y: 0 }); // back where it started, and still not a hold
  tick(HOLD_MS * 2);
  assert.equal(holds(), 0);
});

test("cancel — a pointercancel, a scroll, the row unmounting — ends the press", () => {
  const { gesture, tick, holds } = rig();
  gesture.start({ x: 5, y: 5 });
  tick(HOLD_MS - 10);
  gesture.cancel();
  tick(HOLD_MS);
  assert.equal(holds(), 0);
  assert.equal(gesture.suppressed(), false, "nothing fired, so nothing is suppressed");
});

test("a short press is a click: finish() says so, and the click is not suppressed", () => {
  const { gesture, tick } = rig();
  gesture.start({ x: 5, y: 5 });
  tick(HOLD_MS - 1);
  assert.equal(gesture.finish(), false);
  assert.equal(gesture.suppressed(), false);
});

test("after a hold, the click and the context menu it produces are both suppressed", () => {
  const { gesture, tick } = rig();
  gesture.start({ x: 5, y: 5 });
  tick(HOLD_MS);
  // On touch the context menu arrives BEFORE the pointerup; both ask the same question.
  assert.equal(gesture.suppressed(), true, "contextmenu, still pressed");
  assert.equal(gesture.finish(), true);
  assert.equal(gesture.suppressed(), true, "click, after the pointerup");
});

test("a LONG press is still a hold: its click is suppressed however long the finger stayed down", () => {
  // The bug this pins: with the window measured from the moment the hold fired, a 3s press had
  // already "expired" by the time it was released, so the click reached the row and toggled the
  // selection the hold had just made straight back off.
  const { gesture, tick } = rig();
  gesture.start({ x: 5, y: 5 });
  tick(HOLD_MS);
  tick(3000 - HOLD_MS); // three seconds of press, well past HOLD_SUPPRESS_MS
  assert.equal(gesture.held(), true, "still the same press");
  assert.equal(gesture.suppressed(), true, "a contextmenu at 3s is still the hold's");
  assert.equal(gesture.finish(), true);
  assert.equal(gesture.suppressed(), true, "and so is the click that follows the release");
  // The window starts at the RELEASE, not at the hold.
  tick(HOLD_SUPPRESS_MS);
  assert.equal(gesture.suppressed(), true);
  tick(1);
  assert.equal(gesture.suppressed(), false);
});

test("a hold that ends in a cancel still suppresses the click some platforms send anyway", () => {
  const { gesture, tick } = rig();
  gesture.start({ x: 5, y: 5 });
  tick(HOLD_MS + 2000);
  gesture.cancel(); // pointercancel, a dragstart, the pointer leaving the row
  assert.equal(gesture.held(), false, "no press is down any more");
  assert.equal(gesture.suppressed(), true);
  tick(HOLD_SUPPRESS_MS + 1);
  assert.equal(gesture.suppressed(), false);
});

test("a long press that never fired suppresses nothing", () => {
  const { gesture, tick, holds } = rig();
  gesture.start({ x: 5, y: 5 });
  tick(100);
  gesture.move({ x: 5, y: 300 }); // scrolled away before the delay
  tick(3000);
  assert.equal(holds(), 0);
  assert.equal(gesture.finish(), false);
  assert.equal(gesture.suppressed(), false);
});

test("suppression is a window, not forever, and the next press clears it", () => {
  const { gesture, tick } = rig();
  gesture.start({ x: 5, y: 5 });
  tick(HOLD_MS);
  gesture.finish();
  tick(HOLD_SUPPRESS_MS);
  assert.equal(gesture.suppressed(), true, "at the edge of the window");
  tick(1);
  assert.equal(gesture.suppressed(), false, "a later, unrelated click still navigates");

  gesture.start({ x: 5, y: 5 });
  tick(HOLD_MS);
  gesture.finish();
  assert.equal(gesture.suppressed(), true);
  gesture.start({ x: 5, y: 5 }); // a fresh press starts clean
  assert.equal(gesture.suppressed(), false);
  gesture.cancel();
});

test("a press ends once: a second finish or cancel never extends the suppression window", () => {
  // Several events can end one press (a pointerup AND a lostpointercapture; a cancel then a
  // finish). Re-stamping the release on the later one would hold suppression open past the click
  // the window was opened for, and the next real click on the row would be swallowed.
  const { gesture, tick } = rig();
  gesture.start({ x: 5, y: 5 });
  tick(HOLD_MS);
  assert.equal(gesture.finish(), true);
  tick(HOLD_SUPPRESS_MS - 100);
  gesture.cancel(); // a late lostpointercapture for the same press
  gesture.finish();
  assert.equal(gesture.suppressed(), true, "still inside the window the RELEASE opened");
  tick(101);
  assert.equal(gesture.suppressed(), false, "and it closed on time, not 100ms later");
});

test("the real clock is the default: a press with no hold delay elapsed fires nothing", () => {
  let fired = 0;
  const g = createHoldGesture({ onHold: () => void fired++ });
  g.start({ x: 1, y: 1 });
  assert.equal(fired, 0);
  g.cancel();
});
