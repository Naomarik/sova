// Run: pnpm test -- server/harness/pi/agent-dir.test.ts. §app.harness/agent-root: the adapter's agent
// directory is pi's own, read on every call.
import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { piAgentDir } from "./agent-dir";

const saved = process.env.PI_CODING_AGENT_DIR;
after(() => {
  if (saved === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = saved;
});

test("piAgentDir follows PI_CODING_AGENT_DIR on every call, as pi's getAgentDir does", () => {
  process.env.PI_CODING_AGENT_DIR = "/srv/one";
  assert.equal(piAgentDir(), "/srv/one");
  process.env.PI_CODING_AGENT_DIR = "/srv/two";
  assert.equal(piAgentDir(), "/srv/two");
  assert.equal(piAgentDir(), getAgentDir());
});

test("piAgentDir expands a leading ~ and falls back to ~/.pi/agent", () => {
  process.env.PI_CODING_AGENT_DIR = "~/agent-x";
  assert.equal(piAgentDir(), join(homedir(), "agent-x"));
  assert.equal(piAgentDir(), getAgentDir());
  delete process.env.PI_CODING_AGENT_DIR;
  assert.equal(piAgentDir(), join(homedir(), ".pi", "agent"));
  assert.equal(piAgentDir(), getAgentDir());
});
