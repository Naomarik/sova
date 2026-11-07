// Run: pnpm test -- server/team-member-tools.test.ts. The tool set each kind of worker really gets, end to end:
// the real subagents extension starts a real team (and its monitor's successor) on a fake worker host; each
// recorded WorkerStart then loads what a worker chat loads from it, its own extensions, the extension files its
// spec lists and the tools the server serves it, into a recording pi. A monitor has exactly its team tools and
// project_verbs and no spec tool; every other worker keeps spec (§chat.mode-menu/workers, §app.spec-lookup).
// A throwaway PI_CODING_AGENT_DIR; ~/.pi is never read or written.
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import type { WorkerStart } from "../shared/chat-runtime";

const root = realpathSync(mkdtempSync(join(tmpdir(), "team-member-tools-")));
const agentDir = join(root, "agent");
mkdirSync(agentDir);
process.env.PI_CODING_AGENT_DIR = agentDir; // before chat-manager computes its paths
const was = process.env.PI_SUBAGENTS_TEAM_MEMBER;

// By computed paths: the manager is pi-config's own code, outside Sova's type check (agents/extensions/overview.md).
const pulled = (file: string): Promise<any> => import(new URL(`../pi-config/extensions/subagents/${file}`, import.meta.url).href);
const { registerSubagents } = await pulled("index.ts");
const { FakeWorkerHost } = await pulled("tests/fake-worker-host.ts");
const { MEMBER_ENV, decodeMemberContext, encodeMemberContext } = await import("../pi-config/extensions/subagents/mailbox.ts");
const { workerServed } = await import("./chat-host");
const { setServedTools, workerExtensionFactories } = await import("./chat-manager");

after(() => {
  setServedTools(null);
  if (was === undefined) delete process.env[MEMBER_ENV];
  else process.env[MEMBER_ENV] = was;
  rmSync(root, { recursive: true, force: true });
});

/** A pi stand-in that records the tools an extension registers and accepts everything else. */
function recordingPi(tools: string[]) {
  const events = new EventEmitter();
  const pi: Record<string | symbol, unknown> = {
    registerTool: (t: { name: string }) => void tools.push(t.name),
    events: { on: (n: string, fn: (d: unknown) => void) => (events.on(n, fn), () => void events.off(n, fn)), emit: (n: string, d: unknown) => void events.emit(n, d) },
    getActiveTools: () => [],
    getFlag: () => undefined,
  };
  return new Proxy(pi, { get: (t, k) => t[k] ?? (() => undefined) }) as never;
}

/** The tools one start's chat ends up with: its built-ins, its spec's extension files, its own factories, served as the server serves them. */
async function toolSetOf(start: WorkerStart): Promise<{ builtins: string[] | null; tools: string[] }> {
  const path = join(root, `${start.spec.parent.workerId}.jsonl`);
  const tools: string[] = [];
  const pi = recordingPi(tools);
  const member = start.spec.env[MEMBER_ENV];
  if (member === undefined) delete process.env[MEMBER_ENV];
  else process.env[MEMBER_ENV] = member; // member.ts reads its identity from its process's environment
  for (const file of start.spec.extensions) {
    const mod = (await import(file)) as { default?: (p: never) => unknown };
    await mod.default?.(pi);
  }
  setServedTools(workerServed(start.spec, path));
  for (const f of workerExtensionFactories(start.spec, path)) f.factory(pi);
  return { builtins: start.spec.builtins, tools: [...new Set(tools)].sort() };
}

const DEFAULTS = {
  version: 1,
  coordinator: { enabled: true, role: "coordinator", primary: { backend: "claude-code", model: "claude-opus-5-5", effort: "medium" }, fallback: null, instructions: "" },
  monitor: { enabled: true, role: "monitor", primary: { backend: "claude-code", model: "claude-haiku-4-5", effort: "medium" }, fallback: null, contextPct: 60, everyMinutes: 10, usage: { enabled: false, pausePct: 90, resumeMarginMinutes: 5 }, instructions: "" },
  handover: { retireTimeoutMinutes: 10 },
};
writeFileSync(join(agentDir, "team-defaults.json"), JSON.stringify(DEFAULTS));

/** The real extension on a fake host; `spawn` as the parent's tools take it. */
function parent() {
  const host = new FakeWorkerHost();
  const bus = new EventEmitter();
  const events = { on: (n: string, fn: (d: unknown) => void) => (bus.on(n, fn), () => void bus.off(n, fn)), emit: (n: string, d: unknown) => void bus.emit(n, d) };
  const off = host.announceOn(events);
  const tools = new Map<string, { execute: (...a: unknown[]) => Promise<{ content: { text: string }[] }> }>();
  const hooks = new Map<string, (e: unknown, c: unknown) => unknown>();
  const session = join(root, "parent.jsonl");
  const ctx = {
    cwd: root, mode: "rpc", hasUI: false, thinkingLevel: "high", isIdle: () => true,
    model: { provider: "test", id: "model" },
    sessionManager: { getEntries: () => [], getBranch: () => [], getSessionFile: () => session, getSessionId: () => "0199aaaa-0000-7000-8000-00000000c0de" },
    modelRegistry: { find: (p: string, m: string) => (p === "test" && m === "model" ? { provider: p, id: m } : { provider: p, id: m }), getAvailable: () => [], hasConfiguredAuth: () => true },
    ui: { setStatus() {}, notify() {}, setWidget() {} },
  };
  registerSubagents(
    {
      events,
      registerTool: (t: never) => tools.set((t as { name: string }).name, t),
      on: (e: string, f: (e: unknown, c: unknown) => unknown) => hooks.set(e, f),
      registerCommand() {},
      registerShortcut() {},
      appendEntry() {},
      getAgentDir: () => agentDir,
      getActiveTools: () => ["read", "bash", "agent_spawn"],
      sendMessage() {},
      sendUserMessage() {},
    } as never,
    undefined,
    { policyFile: join(root, "no-policy.json"), agentDir, mailboxRoot: join(root, "mail"), mailboxPollMs: 10_000 },
  );
  const call = (name: string, params: unknown) => tools.get(name)!.execute("t", params, undefined, () => {}, ctx);
  return { host, call, start: () => hooks.get("session_start")!({}, ctx), close: async () => { await hooks.get("session_shutdown")?.({}, ctx); off(); } };
}

const dutyOf = (s: WorkerStart) => decodeMemberContext(s.spec.env[MEMBER_ENV]);
const MONITOR_TOOLS = ["project_verbs", "team_inbox", "team_msg", "team_roster", "wake_nudge"];

test("a team's monitor has its team tools and project_verbs, no built-ins and no spec; its coordinator and members keep spec", async () => {
  const p = parent();
  await p.start();
  try {
    await p.call("team_create", { name: "Crew", objective: "Ship", members: [{ role: "dev", prompt: "build", backend: "claude-code", model: "claude-sonnet-5-5" }, { role: "quiet", prompt: "listen", backend: "claude-code", model: "claude-sonnet-5-5", tools: [] }] });
    const of = (role: string) => {
      const s = p.host.starts.find((x: WorkerStart) => dutyOf(x)?.role === role);
      assert.ok(s, `${role} started`);
      return s!;
    };
    const monitor = of("monitor");
    assert.equal(dutyOf(monitor)?.duty, "monitor");
    assert.deepEqual(await toolSetOf(monitor), { builtins: [], tools: MONITOR_TOOLS }, "exactly what a monitor had before the spec tool came");

    for (const role of ["coordinator", "dev", "quiet"]) {
      const { tools } = await toolSetOf(of(role));
      assert.ok(tools.includes("spec"), `${role} keeps spec: ${tools}`);
      assert.ok(tools.includes("project_verbs") && tools.includes("team_msg"), `${role}: ${tools}`);
    }
    assert.deepEqual(of("quiet").spec.builtins, [], "no built-ins, like a monitor, and still not one: having no file tools isn't what takes spec away");
    const coordinator = await toolSetOf(of("coordinator"));
    for (const t of ["team_report", "team_succeed", "team_roster", "background_job"]) assert.ok(coordinator.tools.includes(t), `coordinator: ${t}`);

    // A plain worker, in or out of a team, keeps it too; with no tools as well.
    await p.call("agent_spawn", { prompt: "plain", backend: "claude-code", model: "claude-sonnet-5-5" });
    await p.call("agent_spawn", { prompt: "plain, no tools", backend: "claude-code", model: "claude-sonnet-5-5", tools: [] });
    for (const start of p.host.starts.slice(-2)) {
      assert.equal(dutyOf(start), undefined);
      assert.ok((await toolSetOf(start)).tools.includes("spec"), start.spec.parent.workerId);
    }

    // A monitor's successor starts through the same path, with team_ready on top and still no spec.
    await p.call("agent_kill", { id: monitor.spec.parent.workerId });
    await p.call("team_succeed", { team: "Crew", role: "monitor" });
    const successor = p.host.starts.at(-1)!;
    assert.equal(dutyOf(successor)?.duty, "monitor", "the successor is the last start");
    assert.deepEqual(await toolSetOf(successor), { builtins: [], tools: [...MONITOR_TOOLS, "team_ready"].sort() }, "a successor monitor has no spec either");
  } finally {
    await p.close();
  }
});

test("only a valid monitor identity takes spec away: a malformed member identity keeps it", () => {
  const names = (env: Record<string, string>) => workerExtensionFactories({ kind: "worker", builtins: [], env }, join(root, "w.jsonl")).map((f) => f.name);
  const member = (duty?: string, successorOf?: string) =>
    encodeMemberContext({ version: 1, teamId: "team_01", teamName: "Crew", workerId: "ag_09", role: "x", orchestrator: false, dir: join(root, "m"), ...(duty ? { duty: duty as "monitor" } : {}), ...(successorOf ? { successorOf } : {}) });
  assert.ok(!names({ [MEMBER_ENV]: member("monitor") }).includes("sova-spec"));
  assert.ok(!names({ [MEMBER_ENV]: member("monitor", "monitor") }).includes("sova-spec"));
  assert.ok(names({ [MEMBER_ENV]: member("coordinator") }).includes("sova-spec"));
  assert.ok(names({ [MEMBER_ENV]: member() }).includes("sova-spec"));
  assert.ok(names({}).includes("sova-spec"));
  assert.ok(names({ [MEMBER_ENV]: "{not json" }).includes("sova-spec"));
});
