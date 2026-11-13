// Run: pnpm test:int -- server/modes/engine-project-tools.integration.test.ts. Project mode tools under Sova's
// engine (§chat.mode-menu/project-modes), on a fake pi host: in a chat (approval before turning on, the tool in
// the loadout, a program changed since approval refused, off takes it away), and in a worker, through Sova's
// own module in the worker's project-tools slot (server/harness/pi/modes-project-tools-worker.ts: the parent's
// copies registered and in the loadout, run in the worker's cwd, refused while its sandbox is on; nothing
// without a hand-off file). Integration tier: each tool call runs a program.
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

const scratch = realpathSync(mkdtempSync(join(tmpdir(), "sova-engine-tools-")));
const agentDir = join(scratch, "agent");
mkdirSync(agentDir, { recursive: true });
process.env.PI_CODING_AGENT_DIR = agentDir; // before the engine reads its agent dir
process.env.SOVA_CHAT_STATE_ROOT = join(scratch, "state");
after(() => rmSync(scratch, { recursive: true, force: true }));

const { modesExtension } = await import("../harness/pi/modes");
const { default: projectToolsWorker } = await import("../harness/pi/modes-project-tools-worker");
const { recordApproval } = await import("../../pi-config/extensions/mode/project-tools-approval.ts");
const { discoverProjectModes, toolsHashOf } = await import("../../pi-config/extensions/mode/project-discovery.ts");
const { PROJECT_SNAPSHOT_TYPE } = await import("../../pi-config/extensions/mode/project-format.ts");
const { PROJECT_TOOLS_FILE_ENV, writeWorkerToolsFile } = await import("../../pi-config/extensions/mode/project-tools.ts");

type Entry = { type: string; customType?: string; data?: unknown };
type Tool = { name: string; execute: (...args: unknown[]) => Promise<{ content: { text: string }[] }> };
const noop = () => {};

/** A chat's pi as far as the engine's project-mode path uses it. */
function chatPi(entries: Entry[], cwd: string) {
  const handlers = new Map<string, ((event: unknown, ctx: unknown) => unknown)[]>();
  const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
  const tools = new Map<string, Tool>();
  let active = ["read", "bash"];
  const notes: string[] = [];
  const base: Record<string, unknown> = {
    on: (name: string, fn: (event: unknown, ctx: unknown) => unknown) => handlers.set(name, [...(handlers.get(name) ?? []), fn]),
    events: { on: () => noop, emit: noop },
    getFlag: () => undefined,
    registerCommand: (name: string, command: { handler: (args: string, ctx: unknown) => Promise<void> }) => commands.set(name, command),
    registerTool: (tool: Tool) => tools.set(tool.name, tool),
    getAllTools: () => [...tools.values()].map((t) => ({ name: t.name })),
    getActiveTools: () => [...active],
    setActiveTools: (next: string[]) => {
      active = [...next];
    },
    appendEntry: (customType: string, data: unknown) => entries.push({ type: "custom", customType, data }),
  };
  const pi = new Proxy(base, { get: (t, k) => (typeof k === "string" && k in t ? t[k] : noop) });
  const ctx = {
    cwd,
    hasUI: false,
    signal: undefined,
    isIdle: () => true,
    sessionManager: { getBranch: () => entries, getEntries: () => entries, getSessionId: () => "s1", getSessionFile: () => undefined, getHeader: () => ({ timestamp: new Date().toISOString() }) },
    ui: { notify: (text: string) => notes.push(text) },
  };
  modesExtension(pi as never, { claudeModels: async () => [] });
  return {
    notes,
    tools,
    activeTools: () => [...active],
    start: async () => {
      for (const fn of handlers.get("session_start") ?? []) await fn({ reason: "startup" }, ctx);
    },
    mode: (args: string) => commands.get("mode")!.handler(args, ctx),
  };
}

test("a chat: a mode with tools needs approval; approved, its tool is in the loadout and runs; changed, refused; off, gone", async () => {
  const root = join(scratch, "tools");
  mkdirSync(join(root, ".git"), { recursive: true });
  const dir = join(root, ".sova", "minor-modes", "release");
  mkdirSync(join(dir, "bin"), { recursive: true });
  writeFileSync(join(dir, "MODE.md"), `---\ndescription: Release\ntools: [{"name": "status", "description": "Status", "command": ["./bin/status.sh"]}]\n---\nUse release__status.\n`);
  writeFileSync(join(dir, "bin/status.sh"), "#!/bin/sh\necho ready\n");
  chmodSync(join(dir, "bin/status.sh"), 0o755);
  const entries: Entry[] = [];
  const a = chatPi(entries, root);
  await a.start();
  await a.mode("release on");
  assert.match(a.notes.at(-1)!, /approve it from a Sova chat's mode menu first/);
  assert.ok(!entries.some((e) => e.customType === PROJECT_SNAPSHOT_TYPE), "refused: nothing saved");

  recordApproval(root, "release", discoverProjectModes(root).modes[0]!.toolsHash, "user");
  await a.mode("release on");
  assert.ok(a.activeTools().includes("release__status"), a.activeTools().join(","));
  const run = await a.tools.get("release__status")!.execute("c1", {}, undefined);
  assert.match(run.content[0]!.text, /ready/);

  writeFileSync(join(dir, "bin/status.sh"), "#!/bin/sh\necho tampered\n");
  await assert.rejects(a.tools.get("release__status")!.execute("c2", {}, undefined), /the files of release changed since it was approved/);

  await a.mode("release off");
  assert.ok(!a.activeTools().includes("release__status"));
  await assert.rejects(a.tools.get("release__status")!.execute("c3", {}, undefined));
});

test("a worker: Sova's module in its slot registers the parent's copies, puts them in the loadout, runs them in the worker's cwd, refuses while the sandbox is on", async () => {
  const root = join(scratch, "worker", "repo");
  const dir = join(root, ".sova", "minor-modes", "release-check");
  const cwd = join(root, "sub");
  mkdirSync(join(dir, "bin"), { recursive: true });
  mkdirSync(cwd, { recursive: true });
  writeFileSync(join(dir, "bin/status"), "#!/bin/sh\npwd\n");
  chmodSync(join(dir, "bin/status"), 0o755);
  const tools = [{ name: "status", description: "Report status", params: { type: "object", properties: { q: { type: "string" } } }, command: ["./bin/status"], timeoutS: 60 }];
  const copy = { v: 1 as const, id: "release-check", dir, description: "d", workers: true, tools, text: "t", sha: "e".repeat(64), toolsHash: toolsHashOf(dir, tools as never) };
  const file = writeWorkerToolsFile(join(scratch, "worker", "agent"), [copy as never])!;
  const registered = new Map<string, Tool>();
  let active = ["read", "bash"];
  const handlers = new Map<string, (event: unknown, ctx: unknown) => Promise<void>>();
  const listeners = new Map<string, (data: unknown) => void>();
  const pi = {
    registerTool: (def: Tool) => registered.set(def.name, def),
    getActiveTools: () => active,
    setActiveTools: (names: string[]) => (active = names),
    on: (name: string, fn: (event: unknown, ctx: unknown) => Promise<void>) => handlers.set(name, fn),
    events: { on: (name: string, fn: (data: unknown) => void) => listeners.set(name, fn), emit: noop },
  };
  const before = process.env[PROJECT_TOOLS_FILE_ENV];
  process.env[PROJECT_TOOLS_FILE_ENV] = file;
  try {
    projectToolsWorker(pi as never);
  } finally {
    if (before === undefined) delete process.env[PROJECT_TOOLS_FILE_ENV];
    else process.env[PROJECT_TOOLS_FILE_ENV] = before;
  }
  assert.deepEqual([...registered.keys()], ["release_check__status"]);
  await handlers.get("session_start")!({}, { cwd });
  assert.deepEqual(active, ["read", "bash", "release_check__status"]);
  const r = await registered.get("release_check__status")!.execute("c", {});
  assert.equal(r.content[0]!.text, `Exit code 0.\n\nstdout:\n${cwd}\n`);
  listeners.get("sandbox:state")!({ version: 1, on: true });
  await assert.rejects(() => registered.get("release_check__status")!.execute("c", {}), /sandbox is on/);
});

test("a worker with no hand-off file: Sova's module registers nothing", () => {
  const before = process.env[PROJECT_TOOLS_FILE_ENV];
  delete process.env[PROJECT_TOOLS_FILE_ENV];
  let calls = 0;
  const pi = { registerTool: () => calls++, on: () => calls++, events: { on: () => calls++, emit: () => calls++ } };
  try {
    projectToolsWorker(pi as never);
  } finally {
    if (before !== undefined) process.env[PROJECT_TOOLS_FILE_ENV] = before;
  }
  assert.equal(calls, 0);
});
