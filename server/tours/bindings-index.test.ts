import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { TourBindingIndex } from "./bindings-index";
test("source attachment index is exact-edition scoped, and duplicates cannot broaden destination authority", () => {
  const root = mkdtempSync(join(tmpdir(), "sova-tour-binding-index-"));
  try {
    const index = new TourBindingIndex(root), row = { sessionId: "source", tourId: "tour-one", editionId: "edition-one", destinationSessionId: "conversation-one", handle: "tr_abcdefghijklmnop" };
    index.add(row);
    assert.deepEqual(index.list("source", "tour-one", "edition-one"), [row]);
    assert.deepEqual(index.list("source", "tour-one", "edition-two"), []);
    assert.deepEqual(index.list("other-source", "tour-one", "edition-one"), []);
    assert.throws(() => index.add({ ...row, destinationSessionId: "conversation-two" }), /Duplicate/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
