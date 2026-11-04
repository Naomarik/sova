// Run: npx tsx --test src/lib/updates.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import type { UpdateTarget } from "../../shared/protocol";
import { goBackLabel, resultLine, withdrawnTitle } from "./updates";

const target: UpdateTarget = { sha: "a".repeat(40), label: "v0.9.0", version: "v0.9.0", count: null } as UpdateTarget;

test("a copy on a withdrawn release is told so with the reason, never 'ahead', and offered to go back", () => {
  const r = { state: "withdrawn" as const, tag: "v0.10.0", why: "breaks settings on upgrade.", at: "2026-11-03T10:00:00Z", target, message: "v0.10.0 was withdrawn" };
  assert.equal(resultLine(r, { kind: "stable" }), "Stable is back on v0.9.0.");
  assert.equal(withdrawnTitle(r), "v0.10.0 was withdrawn: breaks settings on upgrade.");
  assert.equal(goBackLabel(target), "Go Back to v0.9.0");
});
