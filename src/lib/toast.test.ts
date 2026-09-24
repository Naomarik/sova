// Run: npx tsx --test src/lib/toast.test.ts
// A toast's shape and clock: every toast goes by itself (an Undo one later), a keyed toast
// replaces the one before it, and a paused countdown resumes with what was left.
import assert from "node:assert/strict";
import { test } from "node:test";
import { ACTION_TOAST_MS, makeToast, pauseCountdown, placeToast, remaining, resumeCountdown, startCountdown, TOAST_MS } from "./toast";

const undo = { label: "Undo", run: () => {} };

test("a plain toast goes after 3s, exactly as every existing call expects", () => {
  for (const t of [makeToast(1, "Copied path."), makeToast(2, "Copied path.", {}), makeToast(3, "x", { action: undefined })]) {
    assert.equal(t.timeout, 3000);
    assert.equal(t.action, undefined);
  }
  assert.equal(TOAST_MS, 3000);
});

test("a toast with an action also goes by itself, but after 6s, and carries that action", () => {
  let ran = 0;
  const action = { label: "Undo", run: () => void ran++ };
  const t = makeToast(4, "Archived. Find it under Archive.", { action });
  assert.equal(t.timeout, 6000);
  assert.equal(ACTION_TOAST_MS, 6000);
  assert.ok(t.timeout > TOAST_MS);
  assert.equal(t.action, action);
  void t.action!.run();
  assert.equal(ran, 1);
});

test("a keyed toast replaces the one with the same key: 3 archives leave 1 Undo, last", () => {
  let list = placeToast([], makeToast(1, "Copied path."));
  for (const id of [2, 3, 4]) list = placeToast(list, makeToast(id, "Archived. Find it under Archive.", { key: "archive-undo", action: undo }));
  assert.deepEqual(
    list.map((t) => t.id),
    [1, 4],
  );
  // Another key, and unkeyed toasts, are left alone.
  list = placeToast(list, makeToast(5, "Other", { key: "other", action: undo }));
  list = placeToast(list, makeToast(6, "Copied path."));
  list = placeToast(list, makeToast(7, "Copied path."));
  assert.deepEqual(
    list.map((t) => t.id),
    [1, 4, 5, 6, 7],
  );
});

test("placeToast never mutates the stack it was given", () => {
  const before = [makeToast(1, "a", { key: "k" })];
  placeToast(before, makeToast(2, "b", { key: "k" }));
  assert.deepEqual(
    before.map((t) => t.id),
    [1],
  );
});

test("a paused countdown resumes with the time that was left, not the full time", () => {
  let c = startCountdown(6000, 1000);
  assert.equal(remaining(c, 3000), 4000);
  c = pauseCountdown(c, 3000);
  // Paused: time passing costs nothing.
  assert.equal(remaining(c, 50_000), 4000);
  c = resumeCountdown(c, 50_000);
  assert.equal(remaining(c, 51_000), 3000);
  // A second pause and resume keeps accumulating correctly.
  c = pauseCountdown(c, 51_500);
  assert.equal(remaining(c, 90_000), 2500);
  c = resumeCountdown(c, 90_000);
  assert.equal(remaining(c, 92_500), 0);
  assert.equal(remaining(c, 99_000), 0, "never below zero");
});

test("pausing a paused clock, or resuming a running one, changes nothing", () => {
  const running = startCountdown(3000, 0);
  assert.equal(resumeCountdown(running, 2000), running);
  const paused = pauseCountdown(running, 1000);
  assert.equal(pauseCountdown(paused, 2500), paused);
  assert.equal(remaining(paused, 2500), 2000);
});
