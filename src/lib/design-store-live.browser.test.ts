// Run: pnpm test -- src/lib/design-store-live.browser.test.ts (Solid's reactive build).
import assert from "node:assert/strict";
import { test } from "node:test";
if (!import.meta.resolve("solid-js").endsWith("/dist/solid.js")) throw new Error("run with --conditions=browser (the *.browser.test.ts invocation)");

const { liveAfter } = await import("./design-store");

test("slices of one document add up; a part added to the draft's end goes on from where the draft ends", () => {
  let held = liveAfter(null, { version: 1, draw: 5, at: 0, text: "AB" });
  assert.deepEqual(held, { version: 1, draw: 5, text: "AB" });
  held = liveAfter(held, { version: 1, draw: 5, at: 2, text: "CD" });
  assert.deepEqual(held, { version: 1, draw: 5, text: "ABCD" });
});

test("the same version drawn again replaces what is held; a slice that doesn't follow on asks for the whole page", () => {
  const held = { version: 1, draw: 5, text: "<p>old</p>" };
  assert.deepEqual(liveAfter(held, { version: 1, draw: 6, at: 0, text: "<p>new</p>" }), { version: 1, draw: 6, text: "<p>new</p>" });
  assert.equal(liveAfter(held, { version: 1, draw: 5, at: 0, text: "<p>o" }), null, "the same document told again: resync");
  assert.equal(liveAfter(held, { version: 1, draw: 5, at: 99, text: "x" }), null);
  assert.equal(liveAfter(held, { version: 1, draw: 6, at: 10, text: "x" }), null, "more of a document this browser doesn't hold");
});

test("a server that names no draw is followed as before", () => {
  const held = liveAfter(null, { version: 1, at: 0, text: "a" });
  assert.deepEqual(held, { version: 1, text: "a" });
  assert.deepEqual(liveAfter(held, { version: 1, at: 1, text: "b" }), { version: 1, text: "ab" });
  assert.deepEqual(liveAfter(held, { version: 2, at: 0, text: "z" }), { version: 2, text: "z" });
});
