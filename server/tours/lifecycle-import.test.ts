import assert from "node:assert/strict";
import { test } from "node:test";

// No static project imports: runtime must be the cold entry point, reproducing the real loader
// cycle through store -> ownership -> sessions-index -> lifecycle -> the unfinished store module.
test("a cold recording-runtime import does not eagerly read unfinished lifecycle store bindings", async () => {
  const runtime = await import("./runtime");
  assert.equal(typeof runtime.TourRuntime, "function");
  assert.equal(typeof runtime.ensureTourToolRuntime, "function");
  const lifecycle = await import("./lifecycle");
  assert.equal(typeof lifecycle.removeSessionTours, "function");
});
