// Focus (§chat.transcript/focus-view): one choice per browser, kept in localStorage, read once at
// load and held by a signal for the page. Run: pnpm test -- src/lib/focus-view.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";

const values = new Map<string, string>();
const storage = {
  getItem: (k: string) => values.get(k) ?? null,
  setItem: (k: string, v: string) => void values.set(k, v),
  removeItem: (k: string) => void values.delete(k),
} as Storage;
// A browser that left Focus on: the stored value is read when the module loads.
values.set("sova:focus", "true");
Object.defineProperty(globalThis, "localStorage", { configurable: true, value: storage });
const { FOCUS_KEY, focusView, parseFocus, readStoredFocus, setFocusView } = await import("./ui-state");

test("only an explicit true is on; missing, corrupt and other values are off", () => {
  assert.equal(parseFocus("true"), true);
  for (const raw of [null, "", "false", "1", "on", "True", " true", "garbage"]) assert.equal(parseFocus(raw), false, String(raw));
});

test("a reload brings back what this browser chose, for every session at once", () => {
  assert.equal(FOCUS_KEY, "sova:focus");
  // The key names no session: one choice for the whole browser, so a switch keeps it.
  assert.doesNotMatch(FOCUS_KEY, /\//);
  assert.equal(focusView(), true, "the stored on was read at load");
  setFocusView(false);
  assert.equal(focusView(), false);
  assert.equal(values.get(FOCUS_KEY), "false");
  assert.equal(readStoredFocus(), false, "a reload now reads off");
  setFocusView(true);
  assert.equal(values.get(FOCUS_KEY), "true");
  assert.equal(readStoredFocus(), true, "and on again");
});

test("blocked or full storage keeps the choice for the page and never throws", () => {
  const blocked = {
    getItem() {
      throw new Error("blocked");
    },
    setItem() {
      throw new Error("full");
    },
  } as unknown as Storage;
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: blocked });
  try {
    assert.equal(readStoredFocus(), false);
    assert.doesNotThrow(() => setFocusView(false));
    assert.equal(focusView(), false);
    assert.doesNotThrow(() => setFocusView(true));
    assert.equal(focusView(), true, "the in-memory choice holds");
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      get() {
        throw new Error("no storage");
      },
    });
    assert.equal(readStoredFocus(), false);
    assert.doesNotThrow(() => setFocusView(false));
    assert.equal(focusView(), false);
  } finally {
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: storage });
  }
});
