import assert from "node:assert/strict";
import { test } from "node:test";
import { newVisitTab, VISIT_TAB_RE, visitTab } from "../share/visit-tab";

const memory = () => {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), m };
};

test("a new id is 22 base64url characters, and two are not the same", () => {
  const a = newVisitTab();
  const b = newVisitTab();
  assert.match(a, VISIT_TAB_RE);
  assert.match(b, VISIT_TAB_RE);
  assert.notEqual(a, b);
  // Bytes that encode to + and / in plain base64 come out url-safe.
  assert.match(newVisitTab((u) => u.fill(0xff)), /^_+[A-Za-z0-9_-]$/);
  assert.match(newVisitTab((u) => u.fill(0xfb)), VISIT_TAB_RE);
});

test("the same tab keeps its id across reloads", () => {
  const s = memory();
  const first = visitTab(s);
  assert.equal(visitTab(s), first);
  assert.equal(visitTab(s, () => "never used"), first);
});

test("a stored value of the wrong shape is replaced", () => {
  const s = memory();
  s.setItem("sova:share-visit", "short");
  const v = visitTab(s);
  assert.match(v, VISIT_TAB_RE);
  assert.equal(s.m.get("sova:share-visit"), v);
});

test("a blocked sessionStorage still yields an id", () => {
  const blocked = {
    getItem: () => {
      throw new Error("SecurityError");
    },
    setItem: () => {
      throw new Error("SecurityError");
    },
  };
  assert.match(visitTab(blocked), VISIT_TAB_RE);
  assert.match(visitTab(null), VISIT_TAB_RE);
});
