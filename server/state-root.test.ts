// Run: pnpm test -- server/state-root.test.ts. §app.harness/agent-root: one agent directory, read per call.
import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { agentRoot, stateRoot } from "./state-root";

const saved = process.env.PI_CODING_AGENT_DIR;
after(() => {
  if (saved === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = saved;
});

test("agentRoot and stateRoot follow PI_CODING_AGENT_DIR on every call", () => {
  process.env.PI_CODING_AGENT_DIR = "/srv/agent-a";
  assert.equal(agentRoot(), "/srv/agent-a");
  assert.equal(stateRoot(), "/srv/agent-a/sova");
  process.env.PI_CODING_AGENT_DIR = "/srv/agent-b";
  assert.equal(agentRoot(), "/srv/agent-b");
  assert.equal(stateRoot(), "/srv/agent-b/sova");
});

test("agentRoot falls back to ~/.pi/agent", () => {
  delete process.env.PI_CODING_AGENT_DIR;
  assert.equal(agentRoot(), join(homedir(), ".pi", "agent"));
  assert.equal(stateRoot(), join(homedir(), ".pi", "agent", "sova"));
});
