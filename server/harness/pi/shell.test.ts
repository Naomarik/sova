// Run: pnpm test -- server/harness/pi/shell.test.ts. The user's own commands on pi (§chat.shell-mode/running,
// quirk P37): the extensions' user_bash hook goes first, and the operations are picked in a fixed order
// whatever the extensions' load order: the hook's (a remote target) over the sandbox's, the sandbox's over
// pi's local shell, and a sandbox that can't be prepared runs nothing (no start, no record). A hook that ran
// the command itself is recorded as given. Nothing here spawns a process (the unit tier refuses it): the
// commands run on the hook's operations; real local and sandboxed runs are the integration tests'.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { loadPi } from "./testing/load-pi.ts";
import { pickOperations, piShell, sandboxBus, sandboxOf } from "./shell.ts";

const dir = realpathSync(mkdtempSync(join(tmpdir(), "sova-pi-shell-")));
after(() => rmSync(dir, { recursive: true, force: true }));
process.env.PI_CODING_AGENT_DIR = dir;
const pi = await loadPi();
const { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } = pi.agent;

/** A parent scope the session's folder is outside of: preparing the sandbox fails before any probe. */
const OUTSIDE = { version: 1, level: "workspace-write", workspaceRoot: "/nonexistent-parent-q7", writable: ["/nonexistent-parent-q7"] };

const remoteOps = (ran: string[]) => ({
  exec: async (command: string, _cwd: string, o: { onData(d: Buffer): void }) => {
    ran.push(command);
    o.onData(Buffer.from("from the target\n"));
    return { exitCode: 0 };
  },
});

async function session(extensions: ((api: any) => void)[]) {
  const cwd = join(dir, `cwd-${Math.random().toString(36).slice(2)}`);
  mkdirSync(cwd, { recursive: true });
  const settingsManager = SettingsManager.inMemory({ cacheWarming: "off" } as never);
  const sb = sandboxBus();
  const resourceLoader = new DefaultResourceLoader({ cwd, agentDir: dir, settingsManager, extensionFactories: extensions as never, eventBus: sb.bus as never });
  await resourceLoader.reload();
  const modelRuntime = await ModelRuntime.create({ authPath: join(dir, "auth.json"), modelsPath: null, refreshOnCreate: false });
  const { session: s } = await createAgentSession({ cwd, agentDir: dir, modelRuntime, sessionManager: SessionManager.inMemory(cwd), settingsManager, resourceLoader, noTools: "builtin" });
  await s.bindExtensions({});
  sb.attach(s);
  const shell = piShell(() => s, () => sandboxOf(s));
  const bash = () => (s.sessionManager.getEntries() as any[]).filter((e) => e.type === "message" && e.message.role === "bashExecution");
  return { s, shell, bash };
}

function runOf(shell: ReturnType<typeof piShell>, command: string, o: { private?: boolean } = {}) {
  const seen = { started: 0, output: "" };
  const done = shell.run(command, { id: "sh_t", ...o, onStart: () => void seen.started++, onOutput: (c) => void (seen.output += c) });
  return { seen, done };
}

describe("the user's own commands on pi", () => {
  test("pickOperations: the hook's operations, else the sandbox when On, else local", () => {
    const ops = { exec: async () => ({ exitCode: 0 }) };
    assert.deepEqual(pickOperations({ operations: ops as never }, { on: true }), { kind: "hook", operations: ops });
    assert.deepEqual(pickOperations(undefined, { on: true }), { kind: "sandbox" });
    assert.deepEqual(pickOperations({}, { on: false }), { kind: "local" });
  });

  for (const order of ["remote hook first", "sandbox first"] as const) {
    test(`a sandboxed chat bound to a remote target runs on the target's operations (${order})`, async () => {
      const ran: string[] = [];
      const hook = (api: any) => api.on("user_bash", () => ({ operations: remoteOps(ran) }));
      const sandbox = (api: any) => api.events.emit("sandbox:state", { version: 1, on: true, scope: { worktreeRoots: [], parent: OUTSIDE } });
      const { s, shell, bash } = await session(order === "remote hook first" ? [hook, sandbox] : [sandbox, hook]);
      assert.equal(sandboxOf(s).on, true, "the sandbox said On");
      const { seen, done } = runOf(shell, "uname -a");
      const r = await done;
      assert.ok(!("refused" in r), "the sandbox's preparation never ran (it would refuse)");
      assert.deepEqual(ran, ["uname -a"]);
      assert.equal(seen.started, 1);
      assert.equal(seen.output, "from the target\n");
      assert.equal(r.output, "from the target\n");
      assert.equal(r.exitCode, 0);
      const saved = await r.saved;
      assert.equal(saved?.kind, "shell");
      assert.equal(saved?.id, bash()[0].id);
      s.dispose();
    });
  }

  test("a sandbox On that can't be prepared runs nothing: no start, no record, the reason", async () => {
    const { s, shell, bash } = await session([(api: any) => api.events.emit("sandbox:state", { version: 1, on: true, scope: { worktreeRoots: [], parent: OUTSIDE } })]);
    const { seen, done } = runOf(shell, "ls");
    const r = await done;
    assert.ok("refused" in r);
    assert.equal(r.why, "sandbox");
    // Here it fails at the policy file (none in this agent dir) or the parent scope: either way, before a probe.
    assert.match(r.refused, /^The sandbox couldn't be prepared, so nothing ran: /);
    assert.equal(seen.started, 0);
    assert.deepEqual(bash(), []);
    s.dispose();
  });

  test("a hook that ran the command itself: its result is recorded as given, `!!` kept from the model", async () => {
    const result = { output: "done there", exitCode: 3, cancelled: false, truncated: false };
    const { s, shell, bash } = await session([(api: any) => api.on("user_bash", () => ({ result }))]);
    const { seen, done } = runOf(shell, "make", { private: true });
    const r = await done;
    assert.ok(!("refused" in r));
    assert.equal(seen.started, 1);
    assert.equal(seen.output, "done there");
    assert.equal(r.exitCode, 3);
    const saved = await r.saved;
    assert.deepEqual(saved && { kind: saved.kind, private: (saved as any).private, exitCode: (saved as any).exitCode }, { kind: "shell", private: true, exitCode: 3 });
    assert.equal(bash()[0].message.excludeFromContext, true);
    s.dispose();
  });

  test("a hook that throws runs nothing, and says so", async () => {
    const { s, shell, bash } = await session([(api: any) => api.on("user_bash", () => { throw new Error("no link"); })]);
    const { seen, done } = runOf(shell, "ls");
    const r = await done;
    assert.ok("refused" in r);
    assert.equal(r.why, "failed");
    assert.match(r.refused, /no link/);
    assert.equal(seen.started, 0);
    assert.deepEqual(bash(), []);
    s.dispose();
  });
});
