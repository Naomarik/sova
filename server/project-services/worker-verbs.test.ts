import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

/**
 * Workers and team members get `project_verbs` and the instance note, scoped as an ordinary session
 * (§app.project-services/callers); a hidden chat gets neither (§app.chat-processes/workers). And a bare
 * create/up/test from a worktree's cwd aims at that worktree, never the main checkout. Real git only.
 */

const agentDir = mkdtempSync(join(tmpdir(), "sova-worker-verbs-agent-"));
process.env.PI_CODING_AGENT_DIR = agentDir; // before chat-manager computes its paths

const { workerServed } = await import("../chat-host");
const { setChatHosts, setServedTools, workerExtensionFactories } = await import("../chat-manager");
const { cwdCheckout, sessionVerbsTool } = await import("./tools");
const { ProjectEngine } = await import("./engine");
const { FakeHost } = await import("./fake-host");
const { stateView } = await import("../harness/state-view");

const roots: string[] = [agentDir];
after(() => {
  setServedTools(null);
  setChatHosts({});
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

/** A pi stand-in that records what an extension registers. */
function fakePi() {
  const tools: string[] = [];
  const hooks = new Map<string, (event: unknown, ctx: unknown) => Promise<unknown>>();
  const pi = {
    registerTool: (t: { name: string }) => void tools.push(t.name),
    on: (event: string, fn: (event: unknown, ctx: unknown) => Promise<unknown>) => void hooks.set(event, fn),
    sendMessage: () => {},
  };
  return { pi, tools, hooks };
}

test("a worker or team member is served project_verbs; a hidden chat nothing", () => {
  const names = (kind: string) => workerServed({ kind }, join(agentDir, `${kind}.jsonl`)).map((d) => d.name);
  assert.deepEqual(names("worker"), ["project_verbs"]);
  for (const hidden of ["explain", "handoff", "btw"]) assert.deepEqual(names(hidden), [], hidden);
});

test("a worker chat loads project_verbs with its instance note; a hidden chat loads no extension of Sova's", async () => {
  const path = join(agentDir, "worker.jsonl");
  setServedTools(workerServed({ kind: "worker" }, path));
  setChatHosts({ instanceNote: async () => "Your copy: slot 1." });
  const factories = workerExtensionFactories({ kind: "worker" }, path);
  assert.deepEqual(factories.map((f) => f.name), ["sova-project-verbs"]);
  const { pi, tools, hooks } = fakePi();
  factories[0]!.factory(pi as never);
  assert.deepEqual(tools, ["project_verbs"]);
  const ctx = { cwd: agentDir, sessionManager: { getSessionId: () => "w1", getLeafId: () => null, getBranch: () => [], getSessionFile: () => path } };
  const out = (await hooks.get("before_agent_start")!({}, ctx)) as { message?: { content?: unknown; customType?: string } } | undefined;
  assert.ok(out?.message, "the note reaches the worker at its turn's start");
  assert.match(JSON.stringify(out.message), /Your copy: slot 1\./);
  for (const hidden of ["explain", "handoff", "btw"] as const) assert.deepEqual(workerExtensionFactories({ kind: hidden }, path), [], hidden);
});

test("a bare up from a worktree's cwd aims at that worktree; from the main checkout no checkout is filled", async () => {
  const parent = realpathSync(mkdtempSync(join(tmpdir(), "sova-worker-verbs-proj-")));
  roots.push(parent);
  const project = join(parent, "demo");
  mkdirSync(join(project, ".sova"), { recursive: true });
  writeFileSync(join(project, "web.mjs"), "");
  writeFileSync(join(project, ".sova", "project.json"), JSON.stringify({ version: 1, slots: { cap: 4 }, services: { web: { cmd: ["node", "web.mjs"], ports: { http: { base: 39_000 } } } } }));
  const git = (args: string[], cwd = project) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8" });
  git(["init", "-q", "-b", "main"]);
  git(["add", "-A"]);
  git(["commit", "-q", "-m", "fixture"]);
  const tree = join(parent, ".worktrees", "demo-mine");
  git(["worktree", "add", "-q", "-b", "mine", tree]);
  assert.equal(await cwdCheckout(join(tree, ".sova")), tree);
  assert.equal(await cwdCheckout(project), null, "the main checkout is never filled in");
  const engine = new ProjectEngine(new FakeHost().deps());
  const tool = sessionVerbsTool(() => engine);
  const ctxAt = (cwd: string) => ({ cwd, sessionId: "w1", state: () => stateView([]), branch: () => [], leafId: () => null, key: null });
  const run = async (cwd: string) => (await tool.execute("tc", { verb: "up" }, undefined, undefined, ctxAt(cwd) as never)).details as { result: { ok: boolean; checkout: string | null; slot: number | null; error?: { code: string } } };
  const fromTree = await run(tree);
  assert.equal(fromTree.result.ok, true, JSON.stringify(fromTree.result.error));
  assert.equal(fromTree.result.checkout, tree);
  assert.equal(fromTree.result.slot, 1);
  assert.equal((await run(project)).result.error?.code, "forbidden", "from the main checkout, with no tracked worktree: refused as before");
});
