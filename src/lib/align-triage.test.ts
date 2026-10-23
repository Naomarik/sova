import assert from "node:assert/strict";
import { test } from "node:test";
import { stakesChip, triageKey, triageOf } from "./align-triage";

test("the chip: low risk is muted, every other stakes is flagged; its title names who guessed", () => {
  assert.deepEqual(stakesChip("low-risk", { provider: "jev" }), { text: "Low risk", flagged: false, tone: "text-muted", title: "Guessed by Jev." });
  assert.deepEqual(stakesChip("deletes-data", { provider: "pi", model: "zai/glm-5.3" }), { text: "Deletes data", flagged: true, tone: "chip-error", title: "Guessed by glm-5.3." });
  assert.equal(stakesChip("costs-money", { provider: "jev" }).text, "Costs money");
  for (const st of ["deletes-data", "costs-money", "changes-architecture-or-contract"] as const)
    assert.notEqual(stakesChip(st, { provider: "jev" }).tone, "chip-warn" as string, "a flagged chip never shares the Open chip's warn tone");
  assert.equal(stakesChip("changes-architecture-or-contract", { provider: "jev" }).text, "Changes architecture");
});

test("the read key follows open cards' versions; an answer for another version is none", () => {
  assert.equal(triageKey([{ id: "al_2", rev: 3, open: true }, { id: "al_1", rev: 1, open: true }, { id: "al_3", rev: 9, open: false }]), "al_1@1 al_2@3");
  assert.equal(triageKey([]), "");
  const t = { docs: { al_1: { rev: 2, provider: "jev" as const, model: "m", stakes: { q1: "low-risk" as const } } } };
  assert.equal(triageOf(t, "al_1", 2)?.stakes.q1, "low-risk");
  assert.equal(triageOf(t, "al_1", 3), undefined);
  assert.equal(triageOf(undefined, "al_1", 2), undefined);
});
