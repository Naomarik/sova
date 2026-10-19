// Run: pnpm test -- scripts/sova-scenario-steps.test.ts
// The scenario runner's write and read steps stay inside the server's agent dir (scripts/sova-scenario.mjs
// agentPath): a relative path or an absolute one inside it is that file; a `..` anywhere, an absolute
// path elsewhere, or a sibling whose name only starts like the agent dir is refused.
import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { agentPath } from "./sova-scenario.mjs";

const agent = "/scratch/run-1/agent";

test("inside the agent dir: the file it names", () => {
  assert.equal(agentPath(agent, "sova/extensions.json"), join(agent, "sova", "extensions.json"));
  assert.equal(agentPath(agent, `${agent}/sova/extension-keys/x.key`), join(agent, "sova", "extension-keys", "x.key"));
  assert.equal(agentPath(agent, "./sova//a.json"), join(agent, "sova", "a.json"));
});

test("anything that reaches outside is refused", () => {
  for (const p of ["../x", "sova/../../x", "sova/..", "..", "/etc/passwd", "/scratch/run-1/agent-other/x", "/scratch/run-1/x", `${agent}/../x`, "sova\\..\\..\\x", "", agent, `${agent}/`]) {
    assert.equal(agentPath(agent, p), null, p);
  }
  assert.equal(agentPath(agent, undefined), null);
  assert.equal(agentPath(agent, 7), null);
});
