// Ready means the app runs (§app.transport/agent): after arrival the chat's running copy is started by Sova's server
// (the services the source ran for it, each on its tree here; else the chat's own tree's copy), each service waited
// ready, then the entry page wants an HTTP success. The transport is Ready only once all of that holds, read again
// after the agent's turns; a project with no definition starts no copy and is checked as before.
import { dropScratchAgentDir } from "../testing/scratch-agent-dir";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { scratchRoot } from "../test-scratch";
import { onboardModels } from "../projects/onboard";
import { afterArrival, agentOf, agentTurnEnded, type AgentDeps, copyLogs, type PrepareRequest, startCopy } from "./agent";
import { type CopyDeps, type CopyUp, type CopyView, entryOk, oneAtATime } from "./arrival-copy";
import { runningOn } from "./source";

after(dropScratchAgentDir);

const REMOTE = "git@github.com:acme/motors.git";
const tick = () => new Promise<void>((r) => setImmediate(r));

/** The project's services as the fake engine runs them: whether `up` gets every service ready, and what the entry page answers. */
interface Engine {
  up: CopyUp["error"] | null;
  entry: number | null;
  calls: { tree: string; services?: string[] }[];
  entries: number;
}

const engine = (): Engine => ({ up: null, entry: 200, calls: [], entries: 0 });

/** The copy deps over `e`: every tree has a definition opening web.http at /app (unless `noDef`). */
function copyDeps(e: Engine, noDef = false): CopyDeps {
  return {
    copyUp: async (tree, services) => {
      e.calls.push({ tree, ...(services ? { services } : {}) });
      return e.up
        ? { ok: false, instance: "inst-1", services: [{ name: "web", scope: "checkout", state: "failed", ports: { http: 4100 } }], steps: [{ id: "setup:migrate", kind: "setup", result: "failed", detail: e.up.message }], error: e.up }
        : { ok: true, instance: "inst-1", services: [{ name: "web", scope: "checkout", state: "ready", ports: { http: 4100 } }], steps: [] };
    },
    copyDef: () => (noDef ? null : { open: { endpoint: "web.http", path: "/app" } }),
    entryAnswers: async () => (e.entries++, e.entry),
    logs: async (_i, what) => [`log of ${what.step ?? what.service ?? "all"}`],
  };
}

/** A device where the project's setup checks all pass, with a recorder of the agent's chat. */
function device(root: string, e: Engine, over: Partial<AgentDeps> = {}) {
  const told: string[] = [];
  const started: string[] = [];
  const views: CopyView[] = [];
  let busy = 0;
  let clock = 0;
  const deps: AgentDeps = {
    stateRoot: () => join(root, "state"),
    home: () => root,
    protectedRoots: () => [join(root, "state")],
    device: () => "laptop-b",
    which: async (ps) => new Set(ps),
    git: async (args) => (args[0] === "remote" ? { code: 0, stdout: `origin\t${REMOTE} (fetch)\n` } : { code: 0, stdout: "" }),
    doctor: async () => null,
    offeredModels: async () => [...onboardModels()],
    claudeUsable: () => true,
    agentHidden: async () => [],
    confine: async () => null,
    startChat: async ({ prompt }) => (started.push(prompt), (busy = 2), { id: "agent-1", path: join(root, "agent-1.jsonl") }),
    link: async () => ({ linkId: "lk_1" }),
    tell: async (_p, text) => void (told.push(text), (busy = 2)),
    busy: () => busy-- > 0,
    sleep: tick,
    now: () => (clock += 5_000),
    copy: copyDeps(e),
    onCopy: (_t, v) => void views.push(v),
    ...over,
  };
  return { deps, told, started, views };
}

function request(root: string, tid: string): PrepareRequest & { privateFiles: string[]; sourceValues: string[] } {
  const path = join(root, "webapps", "motors");
  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, "README.md"), "motors\n");
  const tree = join(root, "webapps", ".worktrees", "motors-feat");
  mkdirSync(tree, { recursive: true });
  return {
    tid,
    sourcePeer: "sova-laptop",
    sourceLabel: "laptop",
    sourceChatId: "chat-1",
    title: "Motors",
    project: { remotes: [REMOTE], path },
    worktrees: [{ name: "motors-feat", branch: "feat/x" }],
    fromSource: true,
    trees: [tree],
    ownTree: tree,
    ownName: "feat/x",
    privateFiles: [],
    sourceValues: [],
  };
}

test("the services the source ran for the chat are the ones started, each on its tree here; with none, the chat's own tree's whole copy", async () => {
  const root = scratchRoot("transport-copy-");
  const e = engine();
  const d = device(root, e);
  const req = request(root, "tr_copy001");
  const api = join(root, "webapps", ".worktrees", "motors-api");
  await afterArrival({ ...req, copies: [{ tree: req.ownTree!, name: "feat/x", services: ["web", "worker"] }, { tree: api, name: "api", services: ["api"] }] }, d.deps);
  assert.deepEqual(e.calls, [
    { tree: req.ownTree, services: ["web", "worker"] },
    { tree: api, services: ["api"] },
  ]);
  const e2 = engine();
  const d2 = device(root, e2);
  await afterArrival({ ...request(root, "tr_copy002") }, d2.deps);
  assert.deepEqual(e2.calls, [{ tree: req.ownTree }], "no copy ran there: the project's own copy of the chat's tree, its default services");
  assert.equal(d2.started.length, 0, "it runs and answers: no agent starts");
  assert.equal(d2.views.at(-1)?.state, "running");
  assert.deepEqual(d2.views.at(-1)?.copies[0]?.entry, { endpoint: "web.http", port: 4100, path: "/app" }, "the card's Open App links to its entry");
});

test("the switch records which services ran on which of the chat's trees, only the copies your click saw", () => {
  const copies = () => [
    { id: "i1", name: "feat/x", checkout: "/w/motors-feat", services: ["web", "worker"] },
    { id: "i2", name: "api", checkout: "/w/motors-api", services: ["api"] },
    { id: "i3", name: "other", checkout: "/elsewhere", services: ["web"] },
  ];
  const trees = [
    { name: "motors-feat", path: "/w/motors-feat" },
    { name: "motors-api", path: "/w/motors-api" },
  ];
  assert.deepEqual(runningOn({ copies }, trees, new Set(["i1", "i3"])), [{ tree: "motors-feat", name: "feat/x", services: ["web", "worker"] }]);
  assert.deepEqual(runningOn({ copies }, trees, null).map((x) => x.tree), ["motors-feat", "motors-api"], "a copy on no tree of the chat's isn't its");
});

test("Ready is refused while the copy isn't up or its entry page fails, and given once it runs and answers", async () => {
  const root = scratchRoot("transport-copy-");
  const e = engine();
  e.up = { code: "hook-failed", message: "setup:migrate exited with 1", step: "setup:migrate" };
  const d = device(root, e);
  const req = request(root, "tr_copy003");
  const state = join(root, "state");
  await afterArrival(req, d.deps);
  // The copy didn't start: an agent starts for it, briefed with what failed, and its turn ending leaves it Needs you.
  assert.equal(d.started.length, 1);
  assert.match(d.started[0]!, /copy:feat\/x: Its running copy feat\/x didn't start: its step setup:migrate failed/);
  assert.match(d.started[0]!, /Ready means the app runs/);
  let a = agentOf(state, req.tid)!;
  assert.equal(a.state, "needs-you");
  assert.deepEqual(a.checks.filter((c) => !c.ok).map((c) => c.id), ["copy:feat/x"]);
  assert.equal(d.views.at(-1)?.state, "failed");

  // The agent fixes the step: the copy is up, but its entry page answers 502. Still not Ready.
  e.up = null;
  e.entry = 502;
  await agentTurnEnded(d.deps, a.path);
  a = agentOf(state, req.tid)!;
  assert.equal(a.state, "needs-you");
  assert.match(a.checks.find((c) => c.id === "copy:feat/x")!.detail, /entry page \/app \(port 4100\) answered 502/);
  assert.ok(d.told.some((t) => t.includes("answered 502") && t.includes("copy_logs")), "a new failure goes to the agent, with how to read its logs");

  // Nothing answers at all: still not Ready.
  e.entry = null;
  await agentTurnEnded(d.deps, a.path);
  assert.equal(agentOf(state, req.tid)!.state, "needs-you");

  // It answers: Ready, and the copy stays as it is (a later reading never starts it again).
  e.entry = 200;
  await agentTurnEnded(d.deps, a.path);
  a = agentOf(state, req.tid)!;
  assert.equal(a.state, "ready");
  assert.deepEqual(a.checks.filter((c) => !c.ok), []);
  assert.equal(d.views.at(-1)?.state, "running");
  const ups = e.calls.length;
  await agentTurnEnded(d.deps, a.path);
  assert.equal(e.calls.length, ups, "once it ran, a reading doesn't start it again");
  assert.equal(agentOf(state, req.tid)!.state, "ready");
});

test("the copy waits for what else is missing: never started while the setup checks fail", async () => {
  const root = scratchRoot("transport-copy-");
  const e = engine();
  let installed = false;
  const d = device(root, e, { which: async (ps) => new Set(installed ? ps : ps.filter((p) => p !== "cargo")) });
  const req = request(root, "tr_copy004");
  writeFileSync(join(req.project.path, "Cargo.toml"), "");
  const state = join(root, "state");
  await afterArrival(req, d.deps);
  assert.equal(e.calls.length, 0, "cargo is missing: the copy isn't started yet");
  assert.equal(d.views[0]?.state, "waiting");
  const a = agentOf(state, req.tid)!;
  assert.equal(a.state, "needs-you");
  assert.ok(a.checks.some((c) => c.id === "copy:feat/x" && !c.ok));
  installed = true;
  await agentTurnEnded(d.deps, a.path);
  assert.equal(e.calls.length, 1, "the rest passes: the copy starts");
  assert.equal(agentOf(state, req.tid)!.state, "ready");
});

test("a project with no running-copy definition starts no copy and is checked as before; the card says none was started", async () => {
  const root = scratchRoot("transport-copy-");
  const e = engine();
  const d = device(root, e, { copy: copyDeps(e, true) });
  const req = request(root, "tr_copy005");
  assert.deepEqual(await afterArrival(req, d.deps), []);
  assert.equal(e.calls.length, 0);
  assert.equal(d.started.length, 0);
  assert.deepEqual(d.views.map((v) => v.state), ["none"]);
});

test("the agent's start_copy and copy_logs: through the server, one copy start at a time per transport", async () => {
  const root = scratchRoot("transport-copy-");
  const e = engine();
  e.up = { code: "start-failed", message: "web exited", service: "web" };
  let inUp = 0;
  let most = 0;
  const base = copyDeps(e);
  const d = device(root, e, {
    copy: {
      ...base,
      copyUp: async (tree, services) => {
        most = Math.max(most, ++inUp);
        for (let i = 0; i < 4; i++) await tick();
        inUp--;
        return base.copyUp(tree, services);
      },
    },
  });
  const req = request(root, "tr_copy006");
  await afterArrival(req, d.deps);
  const sid = agentOf(join(root, "state"), req.tid)!.sessionId;
  const both = await Promise.all([startCopy(d.deps, sid), startCopy(d.deps, sid)]);
  assert.equal(most, 1, "never two starts at once");
  assert.ok(both.every((r) => r.ok && r.text.includes("service web")));
  const logs = await copyLogs(d.deps, sid, { service: "web" });
  assert.ok(logs.ok && logs.text.includes("log of web"));
  assert.equal((await copyLogs(d.deps, sid, { service: "web; rm -rf /" })).ok, false);
  assert.equal((await startCopy(d.deps, "someone-else")).ok, false, "only the transport's agent");
});

test("an HTTP success is 2xx or a redirect; one key's calls run one after another", async () => {
  assert.deepEqual([200, 302, 399, 400, 500, null].map(entryOk), [true, true, true, false, false, false]);
  const order: string[] = [];
  await Promise.all([
    oneAtATime("k", async () => (order.push("a<"), await tick(), order.push("a>"))),
    oneAtATime("k", async () => (order.push("b<"), await tick(), order.push("b>"))),
  ]);
  assert.deepEqual(order, ["a<", "a>", "b<", "b>"]);
});
