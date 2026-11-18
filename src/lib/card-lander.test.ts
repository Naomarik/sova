// A chat's landing on the card it opens on (§chat.playbooks/run-card), with the page's listeners
// stood in for: a card drawn late still gets the view, and again as things settle; a view the reader
// already moved, before the card was drawn or after, is never moved by it.
import assert from "node:assert/strict";
import { test } from "node:test";
import { cardLander, type LandingHost } from "./card-lander";

/** The page's side, by hand: fire an input, a settle, or the clock; and what is still listened to. */
function page() {
  const input = new Set<() => void>();
  const settle = new Set<() => void>();
  const timers = new Set<{ ms: number; cb: () => void }>();
  const sub = (set: Set<() => void>) => (cb: () => void) => {
    set.add(cb);
    return () => void set.delete(cb);
  };
  const host: LandingHost = {
    onInput: sub(input),
    onSettle: sub(settle),
    later: (ms, cb) => {
      const t = { ms, cb };
      timers.add(t);
      return () => void timers.delete(t);
    },
  };
  return {
    host,
    scroll: () => [...input].forEach((cb) => cb()),
    settles: () => [...settle].forEach((cb) => cb()),
    /** The settling time runs out. */
    timeUp: () => [...timers].forEach((t) => (timers.delete(t), t.cb())),
    listening: () => ({ input: input.size, settle: settle.size, timers: timers.size, ms: [...timers].map((t) => t.ms) }),
  };
}
const counter = () => {
  let n = 0;
  return { land: () => void n++, count: () => n };
};

test("a card drawn late, the reader having touched nothing: the view lands on it, and again each time what stands above settles", () => {
  const p = page();
  const lander = cardLander(p.host, 3000);
  // The chat has been open a while; nothing has landed and nothing but the reader's input is listened for.
  assert.deepEqual(p.listening(), { input: 1, settle: 0, timers: 0, ms: [] });
  const c = counter();
  lander.drawn(c.land);
  assert.equal(c.count(), 1, "lands as the card is drawn");
  assert.deepEqual(p.listening(), { input: 1, settle: 1, timers: 1, ms: [3000] });
  p.settles();
  p.settles();
  assert.equal(c.count(), 3, "and again as the opening lines push it down");
});

test("a card drawn late after the reader already moved the view: it never lands, and listens to nothing", () => {
  const p = page();
  const lander = cardLander(p.host, 3000);
  p.scroll();
  const c = counter();
  const stop = lander.drawn(c.land);
  p.settles();
  p.timeUp();
  assert.equal(c.count(), 0);
  assert.deepEqual(p.listening(), { input: 1, settle: 0, timers: 0, ms: [] });
  stop();
  // And no card drawn after that lands either: the view stays the reader's for as long as the chat is open.
  lander.drawn(c.land);
  assert.equal(c.count(), 0);
});

test("the reader's input after the card landed ends the landing: what settles later moves nothing", () => {
  const p = page();
  const lander = cardLander(p.host, 3000);
  const c = counter();
  lander.drawn(c.land);
  p.settles();
  assert.equal(c.count(), 2);
  p.scroll();
  p.settles();
  p.timeUp();
  assert.equal(c.count(), 2);
  assert.deepEqual(p.listening(), { input: 1, settle: 0, timers: 0, ms: [] });
});

test("the landing is over once the settling time is up, or the card leaves; the chat closing stops listening altogether", () => {
  for (const how of ["time", "card leaves", "chat closes"] as const) {
    const p = page();
    const lander = cardLander(p.host, 3000);
    const c = counter();
    const stop = lander.drawn(c.land);
    if (how === "time") p.timeUp();
    else if (how === "card leaves") stop();
    else lander.close();
    p.settles();
    assert.equal(c.count(), 1, how);
    assert.deepEqual(p.listening(), { input: how === "chat closes" ? 0 : 1, settle: 0, timers: 0, ms: [] }, how);
    // Ending twice is nothing.
    stop();
    lander.close();
  }
});

test("time running out is not the reader's input: a card drawn again later lands again", () => {
  const p = page();
  const lander = cardLander(p.host, 3000);
  const first = counter();
  lander.drawn(first.land);
  p.timeUp();
  const second = counter();
  lander.drawn(second.land);
  p.settles();
  assert.equal(first.count(), 1);
  assert.equal(second.count(), 2);
});
