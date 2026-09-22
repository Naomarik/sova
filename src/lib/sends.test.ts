// Run: npx tsx --test src/lib/sends.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";

/** A stand-in for the browser's per-tab store; node has none. */
function fakeSessionStorage() {
  const map = new Map<string, string>();
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
    clear: () => map.clear(),
    key: (i: number) => [...map.keys()][i] ?? null,
    get length() {
      return map.size;
    },
  } as Storage;
}
Object.defineProperty(globalThis, "sessionStorage", { value: fakeSessionStorage(), configurable: true, writable: true });
const { rememberSend, sentHere } = await import("./ui-state");

const A = "/sessions/a.jsonl";
const B = "/sessions/b.jsonl";

test("a message this tab sent is recognised as ours, per session", () => {
  rememberSend(A, "c1");
  assert.equal(sentHere(A, "c1"), true);
  // Another session's chat never claims it, so a failure there can't paste it into this draft.
  assert.equal(sentHere(B, "c1"), false);
  // And a message we never sent — another tab's, or the server's own prompt — is not ours.
  assert.equal(sentHere(A, "c2"), false);
  assert.equal(sentHere(A, ""), false);
});

test("authorship survives a reload, which is the whole point of the store", () => {
  rememberSend(A, "c9");
  // A reload rebuilds every module and every in-memory Set; sessionStorage is what persists.
  const raw = sessionStorage.getItem("sova:sends-" + A);
  assert.ok(raw && raw.includes("c9"), "the id is in the tab's own storage, not just in memory");
  // The pre-rebrand spelling is mirrored too, so a rollback build sees the same authorship.
  assert.equal(sessionStorage.getItem("pi-web:sends-" + A), raw);
});

test("the list is capped, and keeps the RECENT ids — the only ones still in flight", () => {
  sessionStorage.clear();
  for (let i = 0; i < 60; i++) rememberSend(A, `id-${i}`);
  assert.equal(sentHere(A, "id-59"), true, "the newest is kept");
  assert.equal(sentHere(A, "id-0"), false, "the oldest is dropped");
  assert.equal(JSON.parse(sessionStorage.getItem("sova:sends-" + A)!).length, 50);
});

test("re-recording an id doesn't duplicate it or push the others out", () => {
  sessionStorage.clear();
  rememberSend(A, "c1");
  rememberSend(A, "c2");
  rememberSend(A, "c1");
  assert.deepEqual(JSON.parse(sessionStorage.getItem("sova:sends-" + A)!), ["c2", "c1"]);
});

test("a pre-rebrand list under the legacy key still reads (the rename bridge)", () => {
  sessionStorage.clear();
  sessionStorage.setItem("pi-web:sends-" + B, JSON.stringify(["old-1"]));
  assert.equal(sentHere(B, "old-1"), true);
  // A new write keeps both spellings, and the new one then wins.
  rememberSend(B, "new-1");
  assert.deepEqual(JSON.parse(sessionStorage.getItem("sova:sends-" + B)!), ["old-1", "new-1"]);
  assert.deepEqual(JSON.parse(sessionStorage.getItem("pi-web:sends-" + B)!), ["old-1", "new-1"]);
});

test("a browser with no sessionStorage degrades to 'not ours', never to a crash", () => {
  const real = Object.getOwnPropertyDescriptor(globalThis, "sessionStorage")!;
  Object.defineProperty(globalThis, "sessionStorage", {
    get() {
      throw new Error("blocked");
    },
    configurable: true,
  });
  try {
    assert.doesNotThrow(() => rememberSend(A, "c1"));
    assert.equal(sentHere(A, "c1"), false);
  } finally {
    Object.defineProperty(globalThis, "sessionStorage", real);
  }
});
