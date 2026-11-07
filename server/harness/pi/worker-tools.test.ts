// Run: pnpm test -- server/harness/pi/worker-tools.test.ts. A worker chat's built-ins in a real pi session
// (§app.chat-processes/workers): the build excludes the built-ins its spec doesn't list and turns on the ones it
// does, so a /btw side thread (read, grep, find, ls) has exactly those, and never bash, edit or write. A throwaway
// PI_CODING_AGENT_DIR; no model is called.
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { WorkerSpec } from "../../../shared/chat-runtime";

const agentDir = realpathSync(mkdtempSync(join(tmpdir(), "sova-worker-tools-")));
process.on("exit", () => rmSync(agentDir, { recursive: true, force: true }));
process.env.PI_CODING_AGENT_DIR = agentDir;

const pi = await import("@earendil-works/pi-coding-agent");
const { workerBuild } = await import("../../chat-manager");
const { PiHarnessSession } = await import("./session");
const { BTW_TOOLS } = await import("../../../pi-config/extensions/btw/chat.ts");

const BUILTINS = ["read", "bash", "powershell", "edit", "write", "grep", "find", "ls"];

const spec = (builtins: string[] | null): WorkerSpec => ({
  kind: "btw",
  parent: { sessionId: "p", path: "/p.jsonl", workerId: "btw-contextual-x" },
  cwd: agentDir,
  model: null,
  thinking: null,
  builtins,
  extensions: [],
  flags: {},
  appendSystemPrompt: null,
  env: {},
  agentDir: null,
  lowered: true,
});

/** The built-ins active in a real session built as the worker's build says: its exclusions at creation, then its built hook. */
async function activeBuiltins(w: WorkerSpec): Promise<string[]> {
  const build = workerBuild(w, join(agentDir, "w.jsonl"));
  const { session } = await pi.createAgentSession({ cwd: agentDir, agentDir, settingsManager: pi.SettingsManager.inMemory(), sessionManager: pi.SessionManager.inMemory(agentDir), excludeTools: build.exclude([]) });
  build.built?.(new PiHarnessSession({ session, services: {} } as never));
  return session.getActiveToolNames().filter((t) => BUILTINS.includes(t)).sort();
}

test("a /btw side thread's real session has exactly read, grep, find and ls: never bash, edit or write", async () => {
  assert.deepEqual(await activeBuiltins(spec([...BTW_TOOLS])), ["find", "grep", "ls", "read"]);
});

test("a worker's built-ins are its list, whatever pi's default set: an empty list has none, null keeps pi's default", async () => {
  assert.deepEqual(await activeBuiltins(spec(["read", "grep"])), ["grep", "read"]);
  assert.deepEqual(await activeBuiltins(spec([])), []);
  assert.deepEqual(await activeBuiltins(spec(null)), ["bash", "edit", "read", "write"]);
});
