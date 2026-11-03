// "New since your last visit" (§app.owner-page/content): the previous visit per organization in the browser, pinned for
// the tab's session; a first visit marks nothing.
import assert from "node:assert/strict";
import { test } from "node:test";
import { isNewSince, visitBaseline, type KeyStore } from "./owner-seen";

const store = (): KeyStore & { data: Map<string, string> } => {
  const data = new Map<string, string>();
  return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v) };
};

test("a first visit marks nothing; the next visit's marks start at the previous one", () => {
  const local = store();
  assert.equal(visitBaseline("Acme", local, store(), 1000), null, "first visit");
  // A new tab later: what changed after the first visit is new.
  assert.equal(visitBaseline("Acme", local, store(), 5000), 1000);
  assert.equal(isNewSince(new Date(2000).toISOString(), 1000), true);
  assert.equal(isNewSince(new Date(500).toISOString(), 1000), false);
  assert.equal(isNewSince(new Date(2000).toISOString(), null), false, "no baseline: nothing is new");
});

test("a reload in the same tab keeps the marks; each organization has its own visit", () => {
  const local = store();
  visitBaseline("Acme", local, store(), 1000);
  const tab = store();
  assert.equal(visitBaseline("Acme", local, tab, 5000), 1000);
  assert.equal(visitBaseline("Acme", local, tab, 9000), 1000, "the reload: still from the visit before this tab");
  assert.equal(visitBaseline("Other Co", local, tab, 9000), null, "another organization's first visit");
});

test("blocked storage: nothing is new, nothing throws", () => {
  const broken: KeyStore = {
    getItem: () => {
      throw new Error("blocked");
    },
    setItem: () => {
      throw new Error("blocked");
    },
  };
  assert.equal(visitBaseline("Acme", broken, broken, 1000), null);
  assert.equal(visitBaseline("Acme", null, null, 1000), null);
});
