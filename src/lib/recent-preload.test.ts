import assert from "node:assert/strict";
import { test } from "node:test";
import type { TranscriptItem } from "../../shared/protocol";
import { nextPreload, PAINT_WAIT_MS, preloadBlocked, type PreloadTarget } from "./recent-preload";
import { TranscriptStore } from "./transcript-cache";

const rows = (id: string): TranscriptItem[] => [{ id, kind: "assistant-text", text: id, at: "t", meta: { type: "message" } }];
const T0 = "2026-09-28T10:00:00.000Z";
const T1 = "2026-09-28T10:01:00.000Z";
const target = (key: string, stamp = T0, working = false): PreloadTarget => ({ key, path: `/s/${key}.jsonl`, stamp, working });

test("the next preload is the first Recent session missing, in Recent's order", () => {
  const st = new TranscriptStore();
  const recent = [target("a"), target("b"), target("c")];
  st.pin(recent.map((t) => t.key));
  assert.equal(nextPreload(recent, st, new Map())?.key, "a");
  st.preload("a", rows("a"), T0, 1);
  assert.equal(nextPreload(recent, st, new Map())?.key, "b");
  st.preload("b", rows("b"), T0, 1);
  st.preload("c", rows("c"), T0, 1);
  assert.equal(nextPreload(recent, st, new Map()), null, "all current");
});

test("a Recent session whose file moved since its rows were fetched is fetched again", () => {
  const st = new TranscriptStore();
  st.pin(["a"]);
  st.preload("a", rows("a"), T0, 1);
  assert.equal(nextPreload([target("a", T1)], st, new Map())?.key, "a");
  assert.equal(nextPreload([target("a", "2026-09-28T09:59:00.000Z")], st, new Map()), null, "an older stamp is not newer rows");
});

test("rows a view kept current until it went away are not refetched unless the file moved after", () => {
  let now = Date.parse(T1);
  const st = new TranscriptStore(3, () => now);
  st.pin(["a"]);
  const release = st.show("a");
  st.setItems("a", rows("a"));
  assert.equal(nextPreload([target("a", T0)], st, new Map()), null, "shown: the view owns it");
  release();
  assert.equal(nextPreload([target("a", T0)], st, new Map()), null, "file older than the view's close");
  now += 1;
  assert.equal(nextPreload([target("a", "2026-09-28T10:02:00.000Z")], st, new Map())?.key, "a");
});

test("a session mid-turn, or one that failed at this stamp, is skipped", () => {
  const st = new TranscriptStore();
  st.pin(["a", "b"]);
  assert.equal(nextPreload([target("a", T0, true), target("b")], st, new Map())?.key, "b");
  assert.equal(nextPreload([target("b")], st, new Map([["b", T0]])), null);
  assert.equal(nextPreload([target("b", T1)], st, new Map([["b", T0]]))?.key, "b", "tried again once the file moved");
});

test("the preloader waits for an open view's first paint (bounded) and for a running turn", () => {
  let now = 1_000;
  const st = new TranscriptStore(3, () => now);
  assert.equal(preloadBlocked(st, new Set(), now), null, "no view: go");
  const release = st.show("open");
  assert.equal(preloadBlocked(st, new Set(), now), "painting");
  assert.equal(preloadBlocked(st, new Set(), now + PAINT_WAIT_MS), null, "a view that never gets rows stops holding it up");
  st.setItems("open", rows("open"));
  assert.equal(preloadBlocked(st, new Set(), now), null);
  assert.equal(preloadBlocked(st, new Set(["open"]), now), "streaming");
  assert.equal(preloadBlocked(st, new Set(["elsewhere"]), now), null, "a turn in a session not on screen doesn't");
  release();
});

test("a Recent session already dropped as too big is not fetched again", () => {
  const st = new TranscriptStore(3, Date.now, 100);
  st.pin(["a", "b"]);
  st.preload("a", rows("a"), T0, 80);
  st.preload("b", rows("b"), T0, 90); // b is dropped: a + b > 100, b largest
  assert.equal(st.peek("b"), undefined);
  assert.equal(nextPreload([target("a"), target("b")], st, new Map()), null);
});

test("equal-size Recent sessions past the budget settle instead of evicting each other forever", () => {
  const st = new TranscriptStore(3, Date.now, 100);
  const recent = ["a", "b", "c", "d"].map((k) => target(k));
  st.pin(recent.map((t) => t.key));
  let fetches = 0;
  for (let next = nextPreload(recent, st, new Map()); next && fetches < 20; next = nextPreload(recent, st, new Map())) {
    fetches++;
    st.preload(next.key, rows(next.key), T0, 40);
  }
  assert.equal(fetches, 4, "each fetched once");
  assert.equal(st.keys().length, 2, "2 of 40 fit in 100");
});

test("a session whose announced size can't fit is noted and not fetched again", () => {
  const st = new TranscriptStore(3, Date.now, 100);
  st.pin(["a", "b"]);
  st.preload("a", rows("a"), T0, 70);
  assert.equal(st.wouldKeep("b", 80), false, "80 beside 70 is over 100, and b is the larger");
  assert.equal(st.wouldKeep("b", 60), true, "60 beside 70: a, the larger, would go instead");
  st.noteSize("b", 80);
  assert.equal(nextPreload([target("a"), target("b")], st, new Map()), null);
});
