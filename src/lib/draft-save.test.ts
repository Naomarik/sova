// Run: npx tsx --test src/lib/draft-save.test.ts (or npm test)
import assert from "node:assert/strict";
import { test } from "node:test";
import type { UploadResult } from "../../shared/protocol";
import { createDraftSaver, type DraftPayload, type SaveDraft } from "./draft-save";

/** A text-only draft; most tests only care which payload won. */
const d = (text: string, attachments: UploadResult[] = []): DraftPayload => ({ text, attachments });

/** Hand-driven timers: `tick()` fires every timer still armed. */
function fakeTimers() {
  let next = 0;
  const armed = new Map<number, () => void>();
  return {
    setTimer: (fn: () => void) => {
      armed.set(++next, fn);
      return next;
    },
    clearTimer: (h: unknown) => void armed.delete(h as number),
    tick() {
      const due = [...armed.values()];
      armed.clear();
      for (const fn of due) fn();
    },
    get armed() {
      return armed.size;
    },
  };
}

function recorder(impl?: SaveDraft) {
  const calls: [string, string][] = [];
  const payloads: [string, DraftPayload][] = [];
  const save: SaveDraft = (path, draft) => {
    calls.push([path, draft.text]);
    payloads.push([path, draft]);
    return impl?.(path, draft);
  };
  return { calls, payloads, save };
}

test("a burst of keystrokes costs one save, with the last text", () => {
  const t = fakeTimers();
  const r = recorder();
  const saver = createDraftSaver(r.save, t);
  for (const text of ["h", "he", "hel", "hello"]) saver.schedule("/a", d(text));
  assert.equal(t.armed, 1);
  assert.deepEqual(r.calls, []);
  t.tick();
  assert.deepEqual(r.calls, [["/a", "hello"]]);
  t.tick();
  assert.equal(r.calls.length, 1);
});

test("a later burst replaces the pending text", () => {
  const t = fakeTimers();
  const r = recorder();
  const saver = createDraftSaver(r.save, t);
  saver.schedule("/a", d("first"));
  t.tick();
  saver.schedule("/a", d("second"));
  saver.schedule("/a", d(""));
  t.tick();
  assert.deepEqual(r.calls, [
    ["/a", "first"],
    ["/a", ""],
  ]);
});

test("attachments ride with the text, and the last whole payload wins", () => {
  const t = fakeTimers();
  const r = recorder();
  const saver = createDraftSaver(r.save, t);
  const shot: UploadResult = { path: "/att/s1/sova-1.png", name: "sova-1.png", mimeType: "image/png", size: 10 };
  saver.schedule("/a", d("look", [shot]));
  saver.schedule("/a", d("look here", [shot]));
  t.tick();
  saver.schedule("/a", d("look here", []));
  t.tick();
  assert.deepEqual(r.payloads, [
    ["/a", { text: "look here", attachments: [shot] }],
    ["/a", { text: "look here", attachments: [] }],
  ]);
});

test("flush writes every pending save now, and is safe with nothing pending", () => {
  const t = fakeTimers();
  const r = recorder();
  const saver = createDraftSaver(r.save, t);
  saver.flush();
  assert.deepEqual(r.calls, []);
  saver.schedule("/a", d("x"));
  saver.schedule("/b", d("y"));
  saver.flush();
  assert.deepEqual(r.calls, [
    ["/a", "x"],
    ["/b", "y"],
  ]);
  assert.equal(t.armed, 0);
  t.tick();
  saver.flush();
  assert.equal(r.calls.length, 2);
});

test("paths are isolated: one path's burst never cancels another's save", () => {
  const t = fakeTimers();
  const r = recorder();
  const saver = createDraftSaver(r.save, t);
  saver.schedule("/a", d("a1"));
  saver.schedule("/b", d("b1"));
  saver.schedule("/a", d("a2"));
  assert.equal(t.armed, 2);
  t.tick();
  assert.deepEqual(
    r.calls.sort(([x], [y]) => x.localeCompare(y)),
    [
      ["/a", "a2"],
      ["/b", "b1"],
    ],
  );
});

test("a throwing or rejecting save is swallowed", async () => {
  const t = fakeTimers();
  const unhandled: unknown[] = [];
  const onUnhandled = (e: unknown) => unhandled.push(e);
  process.on("unhandledRejection", onUnhandled);
  try {
    const throwing = createDraftSaver(() => {
      throw new Error("sync");
    }, t);
    throwing.schedule("/a", d("x"));
    assert.doesNotThrow(() => t.tick());
    throwing.schedule("/a", d("y"));
    assert.doesNotThrow(() => throwing.flush());

    const rejecting = createDraftSaver(() => Promise.reject(new Error("async")), t);
    rejecting.schedule("/b", d("x"));
    t.tick();
    rejecting.schedule("/b", d("y"));
    rejecting.flush();
    // Let the rejections settle; none may escape as unhandled.
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.deepEqual(unhandled, []);
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
});

test("the default timer is real and waits delayMs", async () => {
  const r = recorder();
  const saver = createDraftSaver(r.save, { delayMs: 5 });
  saver.schedule("/a", d("x"));
  assert.deepEqual(r.calls, []);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.deepEqual(r.calls, [["/a", "x"]]);
});
