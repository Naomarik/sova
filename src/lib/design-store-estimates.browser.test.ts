// Run: pnpm test -- src/lib/design-store-estimates.browser.test.ts (Solid's reactive build).
import assert from "node:assert/strict";
import { test } from "node:test";
if (!import.meta.resolve("solid-js").endsWith("/dist/solid.js")) throw new Error("run with --conditions=browser (the *.browser.test.ts invocation)");

const { keepEstimates } = await import("./design-store");
type View = import("../../shared/design").DesignChatView;
type Rec = import("../../shared/design").DesignRecord;

const rec = (live?: Rec["live"]): Rec => ({ label: "A", runId: "r", direction: "Minimalist", model: "x/y", modelName: "Y", parents: [], status: live ? "writing" : "ready", route: "tool", versions: [], vision: true, workerState: "idle", createdAt: "", updatedAt: "", ...(live ? { live } : {}) });
const view = (d: Rec): View => ({ designs: [d] }) as unknown as View;

test("a writing design's estimate holds through a view without one, and never outlives its page", () => {
  const before = view(rec({ version: 1, chars: 100, estimateUsd: 0.004 }));
  assert.equal(keepEstimates(before, view(rec({ version: 1, chars: 200 }))).designs[0]!.live?.estimateUsd, 0.004, "held");
  assert.equal(keepEstimates(before, view(rec({ version: 1, chars: 300, estimateUsd: 0.006 }))).designs[0]!.live?.estimateUsd, 0.006, "a newer one wins");
  assert.equal(keepEstimates(before, view(rec({ version: 2, chars: 10 }))).designs[0]!.live?.estimateUsd, undefined, "a new page starts afresh");
  assert.equal(keepEstimates(before, view(rec())).designs[0]!.live, undefined, "writing ended");
  assert.equal(keepEstimates(null, view(rec({ version: 1, chars: 1 }))).designs[0]!.live?.estimateUsd, undefined);
});
