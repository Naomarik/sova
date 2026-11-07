// Run: pnpm test -- server/harness/pi/shell.test.ts. The user's own commands on pi (§chat.shell-mode/running,
// quirk P40): the extensions' user_bash hook goes first, and the operations are picked in a fixed order
// whatever the extensions' load order: the hook's (a remote target) over the sandbox's, the sandbox's over
// pi's local shell, and a sandbox that can't be prepared runs nothing (no start, no record). A hook that ran
// the command itself is recorded as given. Several run at once, each stopped alone by its own signal (one
// stopped before it starts never starts); a run whose output passes its limit is stopped, `limited`; a
// malformed worker scope refuses rather than widening. Nothing here spawns a process (the unit tier refuses it): the
// commands run on the hook's operations; real local and sandboxed runs are the integration tests'.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { loadPi } from "./testing/load-pi.ts";
import { ScriptedModel } from "./testing/scripted-model.ts";
import { pickOperations, piShell, sandboxBus, sandboxOf } from "./shell.ts";

const dir = realpathSync(mkdtempSync(join(tmpdir(), "sova-pi-shell-")));
after(() => rmSync(dir, { recursive: true, force: true }));
process.env.PI_CODING_AGENT_DIR = dir;
const pi = await loadPi();
const { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } = pi.agent;
const { createFauxCore } = pi.ai;

/** A parent scope the session's folder is outside of: preparing the sandbox fails before any probe. */
const OUTSIDE = { version: 1, level: "workspace-write", workspaceRoot: "/nonexistent-parent-q7", writable: ["/nonexistent-parent-q7"] };

const remoteOps = (ran: string[]) => ({
  exec: async (command: string, _cwd: string, o: { onData(d: Buffer): void }) => {
    ran.push(command);
    o.onData(Buffer.from("from the target\n"));
    return { exitCode: 0 };
  },
});

/** A faux model the session can reply with (its turns run on a ScriptedModel, never a network). */
async function fauxRuntime() {
  const faux = createFauxCore({ provider: "faux", models: [{ id: "faux-1" }] });
  const runtime = await ModelRuntime.create({ authPath: join(dir, "auth.json"), modelsPath: null, refreshOnCreate: false });
  runtime.registerProvider("faux", {
    name: "Faux",
    baseUrl: "http://127.0.0.1:9",
    apiKey: "stub",
    api: faux.api,
    streamSimple: faux.streamSimple,
    models: [{ id: "faux-1", name: "faux-1", input: ["text"], reasoning: false, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200_000, maxTokens: 4_000 }],
  } as never);
  return runtime;
}

async function session(extensions: ((api: any) => void)[], o: { model?: boolean } = {}) {
  const cwd = join(dir, `cwd-${Math.random().toString(36).slice(2)}`);
  mkdirSync(cwd, { recursive: true });
  const settingsManager = SettingsManager.inMemory({ cacheWarming: "off", retry: { enabled: false } } as never);
  const sb = sandboxBus();
  const resourceLoader = new DefaultResourceLoader({ cwd, agentDir: dir, settingsManager, extensionFactories: extensions as never, eventBus: sb.bus as never });
  await resourceLoader.reload();
  const modelRuntime = o.model ? await fauxRuntime() : await ModelRuntime.create({ authPath: join(dir, "auth.json"), modelsPath: null, refreshOnCreate: false });
  const { session: s } = await createAgentSession({
    cwd, agentDir: dir, modelRuntime, sessionManager: SessionManager.inMemory(cwd), settingsManager, resourceLoader, noTools: "builtin",
    ...(o.model ? { model: modelRuntime.getModel("faux", "faux-1") } : {}),
  });
  await s.bindExtensions({});
  sb.attach(s);
  const model = o.model ? new ScriptedModel().attach(s) : null;
  const shell = piShell(() => s, () => sandboxOf(s));
  const bash = () => (s.sessionManager.getEntries() as any[]).filter((e) => e.type === "message" && e.message.role === "bashExecution");
  return { s, shell, bash, model };
}

/** Poll a condition until it holds. */
async function until(cond: () => boolean, what: string): Promise<void> {
  for (const end = Date.now() + 5000; !cond(); ) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 2));
  }
}

/** A target's operations that run until released or stopped: `release(i)` ends run i with exit 0. */
function gatedOps() {
  const gates: (() => void)[] = [];
  return {
    release: (i: number) => gates[i]!(),
    ops: {
      exec: (_command: string, _cwd: string, o: { onData(d: Buffer): void; signal?: AbortSignal }) =>
        new Promise<{ exitCode: number }>((resolve, reject) => {
          o.onData(Buffer.from("0123456789"));
          o.onData(Buffer.from("0123456789"));
          if (o.signal?.aborted) return reject(new Error("aborted"));
          o.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
          gates.push(() => resolve({ exitCode: 0 }));
        }),
    },
  };
}

function runOf(shell: ReturnType<typeof piShell>, command: string, o: { private?: boolean; signal?: AbortSignal; maxBytes?: number } = {}) {
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

  test("two commands at once: stopping one by its signal stops it alone, recorded as cancelled; the other ends on its own", async () => {
    const g = gatedOps();
    const { s, shell, bash } = await session([(api: any) => api.on("user_bash", () => ({ operations: g.ops }))]);
    const stopA = new AbortController();
    const a = runOf(shell, "serve", { signal: stopA.signal });
    const b = runOf(shell, "build");
    await until(() => a.seen.started === 1 && b.seen.started === 1, "both to start");
    stopA.abort();
    const ra = await a.done;
    assert.ok(!("refused" in ra));
    assert.equal(ra.cancelled, true);
    assert.equal(ra.limited, undefined);
    g.release(1);
    const rb = await b.done;
    assert.ok(!("refused" in rb));
    assert.deepEqual([rb.cancelled, rb.exitCode], [false, 0], "the other ran to its end");
    assert.deepEqual(bash().map((e) => [e.message.command, e.message.cancelled]), [["serve", true], ["build", false]]);
    s.dispose();
  });

  test("a run whose output passes its limit is stopped and says limited; a run stopped before it starts never starts", async () => {
    const g = gatedOps();
    const { s, shell, bash } = await session([(api: any) => api.on("user_bash", () => ({ operations: g.ops }))]);
    const r = await runOf(shell, "yes", { maxBytes: 15 }).done;
    assert.ok(!("refused" in r));
    assert.deepEqual([r.cancelled, r.limited, r.output], [true, true, "0123456789"], "stopped at the chunk that passed it");
    const gone = new AbortController();
    gone.abort();
    const early = runOf(shell, "rm -rf build", { signal: gone.signal });
    const e = await early.done;
    assert.ok("refused" in e && e.why === "stopped");
    assert.equal(early.seen.started, 0);
    assert.equal(bash().length, 1, "only the limited run was recorded");
    s.dispose();
  });

  test("a malformed worker scope refuses the command, as it refuses the session's own tools; it never widens it", async () => {
    const { s, shell, bash } = await session([(api: any) => api.events.emit("sandbox:state", { version: 1, on: true, scope: { worktreeRoots: [], invalid: "bad --sandbox-parent" } })]);
    const { seen, done } = runOf(shell, "ls");
    const r = await done;
    assert.ok("refused" in r);
    assert.deepEqual([r.why, r.refused], ["sandbox", "The sandbox couldn't be prepared, so nothing ran: bad --sandbox-parent"]);
    assert.equal(seen.started, 0);
    assert.deepEqual(bash(), []);
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

  test("two identical commands that end during one reply: each run's saved is its own entry, in their order", async () => {
    const ran: string[] = [];
    const { s, shell, bash, model } = await session([(api: any) => api.on("user_bash", () => ({ operations: remoteOps(ran) }))], { model: true });
    const release = model!.hold();
    model!.reply({ text: "done" });
    const turn = s.prompt("go");
    await until(() => s.isStreaming, "the reply to start");
    // Same command, same output, same privacy twice; then the same command again as `!!`.
    const first = await runOf(shell, "ls").done;
    const second = await runOf(shell, "ls").done;
    const third = await runOf(shell, "ls", { private: true }).done;
    for (const r of [first, second, third]) assert.ok(!("refused" in r));
    assert.equal(bash().length, 0, "all three wait for the reply");
    release();
    await turn;
    const saved = await Promise.all([first, second, third].map((r) => (r as Exclude<typeof r, { refused: string }>).saved));
    const written = bash();
    assert.equal(written.length, 3);
    assert.deepEqual(saved.map((h) => h?.id), written.map((e) => e.id), "each run's saved is the entry written for it, oldest first");
    assert.deepEqual(saved.map((h) => (h as { private?: boolean } | null)?.private === true), [false, false, true]);
    s.dispose();
  });
});
