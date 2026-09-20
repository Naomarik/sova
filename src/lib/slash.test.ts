import assert from "node:assert/strict";
import { test } from "node:test";
import { localCommand } from "./slash";

test("localCommand claims a bare /agents and /subagents", () => {
  assert.equal(localCommand("/agents"), "subagents");
  assert.equal(localCommand("/subagents"), "subagents");
  assert.equal(localCommand("  /agents\n"), "subagents");
});

test("localCommand leaves everything else to the runtime", () => {
  assert.equal(localCommand("/subagents models haiku"), null); // the runtime's model picker
  assert.equal(localCommand("/agents please"), null);
  assert.equal(localCommand("/team"), null);
  assert.equal(localCommand("agents"), null);
  assert.equal(localCommand("what do the /agents do?"), null);
  assert.equal(localCommand(""), null);
});
