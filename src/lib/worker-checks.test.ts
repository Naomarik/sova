import assert from "node:assert/strict";
import { test } from "node:test";
import { checksKey, untestedChip } from "./worker-checks";

const checks = {
  workers: {
    ag_01: { report: "e1", provider: "jev" as const, model: "jev-1", outcome: "finished" as const, unverified: true },
    ag_02: { report: "e2", provider: "jev" as const, model: "jev-1", outcome: "finished" as const, unverified: false },
  },
};

test("only an unverified finished report gets the chip, naming its source", () => {
  const c = untestedChip(checks, "ag_01");
  assert.equal(c?.text, "Untested");
  assert.match(c!.title, /doesn't say it ran tests or checks\. Guessed by Jev\.$/);
  assert.equal(untestedChip(checks, "ag_02"), null);
  assert.equal(untestedChip(checks, "ag_09"), null);
});

test("the key follows settled workers only, so a new ending asks again", () => {
  const a = checksKey([{ id: "ag_01", working: false, endedAt: 5 }, { id: "ag_02", working: true }]);
  assert.equal(a, "ag_01@5");
  assert.notEqual(checksKey([{ id: "ag_01", working: false, endedAt: 9 }]), a);
  assert.equal(checksKey([{ id: "ag_02", working: true }]), "");
});
