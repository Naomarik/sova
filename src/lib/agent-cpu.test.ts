// Settings → General's Agents' CPU words (src/lib/agent-cpu.ts): the switch's first ceiling, what a save announces,
// and the line when systemd holds something else.
import assert from "node:assert/strict";
import { test } from "node:test";
import { driftLine, firstCeiling, savedLine } from "./agent-cpu";

const st = (o: Partial<Parameters<typeof driftLine>[0]> = {}) => ({ available: true, why: null, cores: 16, maxCores: 4, inForce: 4, ...o });

test("the switch offers all but 2 cores, at least 1", () => {
  assert.deepEqual([16, 4, 3, 2, 1].map(firstCeiling), [14, 2, 1, 1, 1]);
});

test("a save says the ceiling, or that it is gone", () => {
  assert.equal(savedLine({ maxCores: 4, cores: 16 }), "Agents may now use at most 4 of 16 cores.");
  assert.equal(savedLine({ maxCores: 1, cores: 1 }), "Agents may now use at most 1 of 1 core.");
  assert.equal(savedLine({ maxCores: null, cores: 16 }), "Agents may use every core again.");
});

test("a line only when systemd holds another ceiling than the saved one", () => {
  assert.equal(driftLine(st()), null);
  assert.equal(driftLine(st({ maxCores: null, inForce: null })), null);
  assert.equal(driftLine(st({ available: false, inForce: null })), null);
  assert.equal(driftLine(st({ inForce: null })), "systemd holds no ceiling on the agents now. Sova puts your setting back when it next starts.");
  assert.equal(driftLine(st({ maxCores: null, inForce: 1 })), "systemd holds a ceiling of 1 core on the agents now. Sova puts your setting back when it next starts.");
});
