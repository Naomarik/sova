// Run: npx tsx --test src/lib/share-linkify.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { linkSegments } from "./share-linkify";

test("an http address in a sentence is its own segment", () => {
  assert.deepEqual(linkSegments("see http://127.0.0.1:4861 now"), [{ text: "see " }, { href: "http://127.0.0.1:4861", text: "http://127.0.0.1:4861" }, { text: " now" }]);
});

test("trailing punctuation stays outside the link", () => {
  assert.deepEqual(linkSegments("Preview: https://x.test/a."), [{ text: "Preview: " }, { href: "https://x.test/a", text: "https://x.test/a" }, { text: "." }]);
});

test("no other scheme, no bare host, no e-mail", () => {
  for (const s of ["javascript:alert(1)", "mailto:a@b.c", "www.x.com", "a@b.c", "ftp://x.test/f", "file:///etc/passwd"]) {
    assert.deepEqual(linkSegments(s), [{ text: s }], s);
  }
});

test("markup in an address is kept as text, never parsed", () => {
  const segs = linkSegments("http://a.test/?q=<b>");
  assert.equal(segs.some((s) => "href" in s && s.href.startsWith("http://a.test/?q=")), true);
  assert.equal(segs.map((s) => s.text).join(""), "http://a.test/?q=<b>");
});

test("the text survives whole; empty text is one empty segment", () => {
  const t = "two: https://a.test and http://b.test/x?y=1#z end";
  assert.equal(linkSegments(t).map((s) => s.text).join(""), t);
  assert.equal(linkSegments(t).filter((s) => "href" in s).length, 2);
  assert.deepEqual(linkSegments(""), [{ text: "" }]);
});
