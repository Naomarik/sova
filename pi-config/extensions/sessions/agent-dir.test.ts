import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { AGENT_DIR_ENV, agentDir, liveDirOf } from "./agent-dir.ts";
import { defaultLiveDir } from "./feed.ts";
import { loadConfig } from "./index.ts";
import { createPresenceChannel } from "./presence.ts";

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/** Run `fn` with PI_CODING_AGENT_DIR set to `value` (undefined = unset), restoring it after. */
async function withAgentDir<T>(value: string | undefined, fn: () => T | Promise<T>): Promise<T> {
  const before = process.env[AGENT_DIR_ENV];
  if (value === undefined) delete process.env[AGENT_DIR_ENV]; else process.env[AGENT_DIR_ENV] = value;
  try { return await fn(); } finally {
    if (before === undefined) delete process.env[AGENT_DIR_ENV]; else process.env[AGENT_DIR_ENV] = before;
  }
}

test("agentDir: unset or empty ⇒ ~/.pi/agent; set ⇒ that dir, with ~ and file:// handled as pi does", () => {
  const home = "/home/someone";
  assert.equal(agentDir({}, home), join(home, ".pi", "agent"));
  assert.equal(agentDir({ [AGENT_DIR_ENV]: "" }, home), join(home, ".pi", "agent"));
  assert.equal(agentDir({ [AGENT_DIR_ENV]: "/srv/agent" }, home), "/srv/agent");
  assert.equal(agentDir({ [AGENT_DIR_ENV]: "~" }, home), home);
  assert.equal(agentDir({ [AGENT_DIR_ENV]: "~/hermetic/.agent" }, home), join(home, "hermetic/.agent"));
  assert.equal(agentDir({ [AGENT_DIR_ENV]: pathToFileURL("/srv/x y").href }, home), "/srv/x y");
  // Like pi: any other value is taken as given (no ~user expansion, no resolution).
  assert.equal(agentDir({ [AGENT_DIR_ENV]: "~other/a" }, home), "~other/a");
  assert.equal(liveDirOf({ [AGENT_DIR_ENV]: "/srv/agent" }), "/srv/agent/sessions/live");
  assert.equal(agentDir({}), join(homedir(), ".pi", "agent"), "the real home by default");
});

test("env unset: the live dir defaults to ~/.pi/agent/sessions/live", async () => {
  await withAgentDir(undefined, () => {
    assert.equal(defaultLiveDir(), join(homedir(), ".pi", "agent", "sessions", "live"));
  });
});

test("env set: live records, the feed's dir and sessions.json all follow PI_CODING_AGENT_DIR", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-sessions-agentdir-"));
  try {
    await withAgentDir(root, async () => {
      assert.equal(defaultLiveDir(), join(root, "sessions", "live"));
      writeFileSync(join(root, "sessions.json"), JSON.stringify({ budgetBytes: 8192 }));
      assert.equal(loadConfig().budgetBytes, 8192);
      // No explicit dir: the channel writes its own record under the agent dir, not the real one.
      const channel = createPresenceChannel({ pollMs: 20, heartbeatMs: 40, onEvent() {},
        info: () => ({ name: "hermetic", cwd: "/tmp/h", model: "m", pid: process.pid, startedAt: 1, lastActivity: 1, status: "Idle" }) });
      try {
        await sleep(120);
        const live = join(root, "sessions", "live");
        assert.ok(existsSync(live));
        assert.ok(readdirSync(live).some((f) => f.startsWith(`p${process.pid}-`) && f.endsWith(".json")));
      } finally { channel.close(); }
      // An explicit dir still wins.
      const other = join(root, "explicit");
      mkdirSync(other);
      const pinned = createPresenceChannel({ dir: other, pollMs: 20, heartbeatMs: 40, onEvent() {},
        info: () => ({ name: "pinned", cwd: "/tmp/p", model: "m", pid: process.pid, startedAt: 1, lastActivity: 1, status: "Idle" }) });
      try {
        await sleep(120);
        assert.ok(readdirSync(other).some((f) => f.endsWith(".json")));
      } finally { pinned.close(); }
    });
  } finally { rmSync(root, { recursive: true, force: true }); }
});
