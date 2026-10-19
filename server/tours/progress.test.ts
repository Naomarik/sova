import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { tourManifestFixture } from "../../shared/tour-fixtures";
import { digest } from "./assets";
import { TourProgressStore } from "./progress";

test("positions are server-side, exact membership and independent per reader", () => {
  const root = mkdtempSync(join(tmpdir(), "tour-progress-")); try {
    const store = new TourProgressStore(root), m = tourManifestFixture(), step = m.steps[0]!, view = step.views[0]!;
    const input = { stepId: step.id, viewId: view.id, size: "phone" };
    store.put("owner:a", m, input);
    assert.equal(new TourProgressStore(root).get("owner:a", m)?.size, "phone", "another device/process resumes from the server");
    assert.equal(store.get("person:b", m), null);
    for (const bad of [{ ...input, stepId: "guessed" }, { ...input, viewId: "guessed" }, { ...input, size: "watch" }, { ...input, script: "extra" }]) assert.throws(() => store.put("owner:a", m, bad));
    const foreign = structuredClone(m); foreign.id = "foreign-tour"; assert.equal(store.get("owner:a", foreign), null, "a reused scope cannot map progress into another tour");
    const next = structuredClone(m); next.editionId = "new-edition";
    assert.equal(store.get("owner:a", next)?.editionId, "new-edition");
    next.steps[0]!.id = "replacement";
    assert.equal(store.get("owner:a", next), null, "an unrelated replacement resets; never resumes by array index");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test("public readers are hash-only, token-scoped and never a common position", () => {
  const root = mkdtempSync(join(tmpdir(), "tour-readers-")); try {
    const store = new TourProgressStore(root), a = digest("share-a"), b = digest("share-b");
    const r1 = store.createReader(a), r2 = store.createReader(a), scope1 = store.readerScope(a, r1)!, scope2 = store.readerScope(a, r2)!;
    assert.notEqual(scope1, scope2); assert.equal(store.readerScope(b, r1), null); assert.equal(store.readerScope(a, "guessed"), null);
    const raw = readFileSync(join(root, "readers", `${a}.json`), "utf8"); assert.equal(raw.includes(r1), false); assert.ok(raw.includes(digest(r1)));
    const m = tourManifestFixture(); store.put(scope1, m, { stepId: m.steps[0]!.id, viewId: m.steps[0]!.views[0]!.id, size: "desktop" });
    assert.ok(store.get(scope1, m)); assert.equal(store.get(scope2, m), null);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
