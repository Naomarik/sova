// Run: npx tsx --test server/overseer-idea-tools.test.ts (or npm test). Uses a throwaway
// PI_CODING_AGENT_DIR in the OS temp dir; ~/.pi is never read or written.
//
// The ideas tools against a stub host: attended or not, and a stub subagents extension that
// records what the explorer routes hand it (agent_spawn / agent_steer / agent_list /
// agent_transcript), so launch, follow-up routing and the caps are checked without a worker.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, describe, test } from "node:test";
import type { SessionSummary, WorkerChoice } from "../shared/protocol";

const agentDir = mkdtempSync(join(tmpdir(), "sova-idea-tools-"));
process.env.PI_CODING_AGENT_DIR = agentDir;

const { overseerTools, TurnLimits, UNATTENDED_REFUSAL } = await import("./overseer-tools");
const { DEFAULT_CAPS, overseerActionsFile } = await import("./overseer-store");
const ideas = await import("./overseer-ideas");

after(() => rmSync(agentDir, { recursive: true, force: true }));

type Call = { tool: string; params: Record<string, unknown>; ctx: unknown };
let calls: Call[] = [];
let attended = true;
let overseerId = "ov-1";
let workers: Record<string, string> = {};
let nextWorker = 1;
let explorer: WorkerChoice = { backend: "claude-code", model: "opus[1m]", effort: "medium" };
let caps = { ...DEFAULT_CAPS };
let extensionLoaded = true;

const subagents: Record<string, (p: Record<string, unknown>) => { content: { type: string; text: string }[]; details?: unknown }> = {
  agent_spawn: () => {
    const id = `ag_${String(nextWorker++).padStart(2, "0")}`;
    workers[id] = "running";
    return { content: [{ type: "text", text: `Started ${id}` }], details: { spawned: [{ id, name: "x", backend: "claude-code" }] } };
  },
  agent_list: () => ({ content: [{ type: "text", text: "" }], details: { agents: Object.entries(workers).map(([id, status]) => ({ id, status })) } }),
  agent_steer: (p) => ({ content: [{ type: "text", text: `Accepted for ${p.id}` }], details: { id: p.id } }),
  agent_transcript: (p) => ({ content: [{ type: "text", text: `ag reply for ${p.id}\nPLAN:\n- step one` }], details: { id: p.id, status: workers[p.id as string] } }),
};

const host = {
  overseerId: () => overseerId,
  caps: () => caps,
  attended: () => attended,
  explorer: () => explorer,
  explorerCwd: () => join(agentDir, "sova", "overseer"),
  subagent: (name: string) =>
    extensionLoaded && subagents[name]
      ? {
          execute: async (_id: string, params: Record<string, unknown>, _signal: unknown, _u: unknown, ctx: unknown) => {
            calls.push({ tool: name, params, ctx });
            return subagents[name]!(params);
          },
        }
      : null,
  session: async (ref: string) => (ref === "s-1" ? ({ id: "s-1", path: "/p/s-1.jsonl", title: "Work", overseer: false } as unknown as SessionSummary) : null),
};

let limits = new TurnLimits();
const tools = () => overseerTools(host as never, limits);
const CTX = { marker: "the tool call's ctx" };
async function run(name: string, params: Record<string, unknown>): Promise<string> {
  const t = tools().find((x) => x.name === name)!;
  const r = await t.execute("tc1", params, undefined, undefined, CTX as never);
  return (r.content as { text: string }[]).map((c) => c.text).join("\n");
}
const refusal = (name: string, params: Record<string, unknown>) => run(name, params).then(() => "", (e: Error) => e.message);

beforeEach(() => {
  calls = [];
  attended = true;
  overseerId = "ov-1";
  caps = { ...DEFAULT_CAPS };
  limits = new TurnLimits();
  extensionLoaded = true;
});

describe("sova_idea: filing and growing ideas", () => {
  test("add, append, link and update go to the store; every call is in the audit log", async () => {
    assert.match(await run("sova_idea", { op: "add", id: "mesh/retry-backoff", title: "Retry peers with backoff", text: "Someday.", tags: ["reliability"] }), /Filed §mesh\/retry-backoff/);
    await run("sova_idea", { op: "add", id: "§mesh/health", title: "Peer health" });
    assert.match(await run("sova_idea", { op: "link", id: "mesh/health", add: ["mesh/retry-backoff"] }), /links to §mesh\/retry-backoff/);
    await run("sova_idea", { op: "append", id: "mesh/retry-backoff", text: "Also jitter." });
    assert.match(ideas.readProse("§mesh/retry-backoff"), /Someday\.\n\n_\d{4}-\d\d-\d\d_ — Also jitter\.\n/);
    assert.match(await run("sova_idea", { op: "update", id: "mesh/retry-backoff", session: "s-1" }), /started, session sova:\/\/s\/s-1/);
    const log = readFileSync(overseerActionsFile(), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.deepEqual(log.filter((l) => l.tool === "sova_idea").map((l) => l.args.op), ["add", "add", "link", "append", "update"]);
  });

  test("store refusals come back as the store words them", async () => {
    assert.match(await refusal("sova_idea", { op: "add", id: "mesh/retry-backoff", title: "dup" }), /already exists/);
    assert.match(await refusal("sova_idea", { op: "add", id: "Bad Id", title: "x" }), /not an idea id/);
    assert.match(await refusal("sova_idea", { op: "update", id: "mesh/health", session: "nope" }), /No session with id nope/);
  });

  test("in a turn the user did not start, every op refuses: filing, explore, tell", async () => {
    attended = false;
    for (const params of [
      { op: "add", id: "mesh/x", title: "x" },
      { op: "append", id: "mesh/health", text: "x" },
      { op: "explore", id: "mesh/health" },
      { op: "tell", id: "mesh/health", message: "x" },
    ])
      assert.equal(await refusal("sova_idea", params), UNATTENDED_REFUSAL, String(params.op));
    assert.equal(calls.length, 0, "no subagent was touched");
    assert.match(await run("sova_ideas", { op: "toc" }), /§mesh/, "reads stay allowed");
  });
});

describe("sova_ideas: reading the backlog", () => {
  test("toc, search (the similar scan), get, scope and impact", async () => {
    assert.match(await run("sova_ideas", { op: "toc" }), /§mesh \(1 open, 1 started\)\n {2}- §mesh\/health/);
    assert.match(await run("sova_ideas", { op: "search", query: "retry the peers with a backoff" }), /Similar ideas[^\n]*\n- §mesh\/retry-backoff/);
    assert.match(await run("sova_ideas", { op: "search", query: "dark theme" }), /No similar idea/);
    const got = await run("sova_ideas", { op: "get", id: "mesh/retry-backoff" });
    assert.match(got, /Linked from: §mesh\/health/);
    assert.match(got, /Also jitter/);
    const scope = await run("sova_ideas", { op: "scope", id: "mesh/health" });
    assert.match(scope, /2 ideas in the scope of §mesh\/health/);
    assert.match(scope, /Also jitter/, "with the linked idea's text");
    assert.match(await run("sova_ideas", { op: "impact", id: "mesh/retry-backoff" }), /- §mesh\/health/);
  });
});

describe("explorers: one subagent per idea, launched and addressed through the subagents extension", () => {
  test("explore spawns with the configured choice, read-only tools, the idea and its scope, and records the worker", async () => {
    explorer = { backend: "claude-code", model: "opus[1m]", effort: "medium" };
    const said = await run("sova_idea", { op: "explore", id: "mesh/health", brief: "What would it take?" });
    assert.match(said, /Launched ag_01 to explore §mesh\/health \(claude-code · opus\[1m\] · medium\)/);
    const spawn = calls.find((c) => c.tool === "agent_spawn")!;
    assert.equal(spawn.ctx, CTX, "called with the tool call's own context: the Overseer's session owns the worker");
    assert.equal(spawn.params.backend, "claude-code");
    assert.equal(spawn.params.model, "opus[1m]");
    assert.equal(spawn.params.effort, "medium");
    assert.deepEqual(spawn.params.tools, ["Read", "Glob", "Grep"], "no Edit, Write or Bash");
    assert.equal(spawn.params.wake, true);
    assert.match(String(spawn.params.name), /§mesh\/health/, "the wake names the idea");
    assert.match(String(spawn.params.prompt), /Idea §mesh\/health: Peer health[\s\S]*§mesh\/retry-backoff[\s\S]*Also jitter[\s\S]*What would it take\?/);
    assert.match(String(spawn.params.systemPrompt), /edit nothing[\s\S]*PLAN:/i);
    const idea = ideas.getIdea("mesh/health")!;
    assert.equal(idea.explorerId, "ag_01");
    assert.equal(idea.explorerOverseerId, "ov-1");
    assert.equal(idea.status, "exploring");
  });

  test("a pi explorer gets pi's read-only tools", async () => {
    explorer = { backend: "pi", model: "ollama-cloud/glm-5.3", effort: "low" };
    await run("sova_idea", { op: "add", id: "sova/panel", title: "Ideas panel" });
    await run("sova_idea", { op: "explore", id: "sova/panel" });
    const spawn = calls.find((c) => c.tool === "agent_spawn")!;
    assert.deepEqual(spawn.params.tools, ["read", "grep", "find", "ls"]);
    assert.equal(spawn.params.model, "ollama-cloud/glm-5.3");
  });

  test("a second explore for an idea with a live explorer refuses and points at tell", async () => {
    assert.match(await refusal("sova_idea", { op: "explore", id: "mesh/health" }), /already has an explorer, ag_01 \(running\)[\s\S]*tell/);
    assert.ok(!calls.some((c) => c.tool === "agent_spawn"));
  });

  test("multiplexing: each follow-up goes to its own idea's explorer", async () => {
    assert.match(await run("sova_idea", { op: "tell", id: "sova/panel", message: "Group it by project" }), /explorer ag_02/);
    assert.match(await run("sova_idea", { op: "tell", id: "mesh/health", message: "Use heartbeats" }), /explorer ag_01/);
    const steers = calls.filter((c) => c.tool === "agent_steer").map((c) => c.params);
    assert.deepEqual(steers, [
      { id: "ag_02", message: "Group it by project", mode: "followUp" },
      { id: "ag_01", message: "Use heartbeats", mode: "followUp" },
    ]);
  });

  test("explorer reads the idea's worker's latest reply, marked as a report", async () => {
    const out = await run("sova_ideas", { op: "explorer", id: "mesh/health" });
    assert.match(out, /<<the explorer's reply for §mesh\/health \(ag_01\)[\s\S]*PLAN:\n- step one[\s\S]*<<end of explorer reply>>/);
    assert.deepEqual(calls.at(-1)?.params, { id: "ag_01" });
  });

  test("tell and explorer refuse an idea whose explorer belongs to another conversation, or has ended", async () => {
    overseerId = "ov-2";
    assert.match(await refusal("sova_idea", { op: "tell", id: "mesh/health", message: "x" }), /earlier Overseer conversation/);
    assert.match(await refusal("sova_ideas", { op: "explorer", id: "mesh/health" }), /earlier Overseer conversation/);
    overseerId = "ov-1";
    workers.ag_01 = "done";
    assert.match(await refusal("sova_idea", { op: "tell", id: "mesh/health", message: "x" }), /ag_01 is done[\s\S]*explore/);
    assert.match(await refusal("sova_idea", { op: "tell", id: "mesh/retry-backoff", message: "x" }), /has no explorer/);
    assert.ok(!calls.some((c) => c.tool === "agent_steer"));
  });

  test("an ended explorer can be replaced; the cap counts launches per user message and a refusal launches nothing", async () => {
    caps = { ...DEFAULT_CAPS, explorePerTurn: 1 };
    assert.match(await run("sova_idea", { op: "explore", id: "mesh/health" }), /Launched ag_03/);
    await run("sova_idea", { op: "add", id: "mesh/third", title: "Third" });
    assert.match(await refusal("sova_idea", { op: "explore", id: "mesh/third" }), /at most 1 explorers launched per message from the user/);
    assert.equal(calls.filter((c) => c.tool === "agent_spawn").length, 1);
    limits.reset(); // the user's next message
    assert.match(await run("sova_idea", { op: "explore", id: "mesh/third" }), /Launched ag_04/);
  });

  test("tell counts against the prompts cap", async () => {
    caps = { ...DEFAULT_CAPS, promptsPerTurn: 1 };
    await run("sova_idea", { op: "tell", id: "mesh/third", message: "one" });
    assert.match(await refusal("sova_idea", { op: "tell", id: "mesh/third", message: "two" }), /Limit reached/);
  });

  test("without the subagents extension, explore says so and records nothing", async () => {
    extensionLoaded = false;
    await run("sova_idea", { op: "add", id: "mesh/fourth", title: "Fourth" });
    assert.match(await refusal("sova_idea", { op: "explore", id: "mesh/fourth" }), /subagents extension is not loaded/);
    assert.equal(ideas.getIdea("mesh/fourth")?.status, "open");
  });

  test("closed ideas are not explored", async () => {
    await run("sova_idea", { op: "update", id: "mesh/fourth", status: "dropped" });
    assert.match(await refusal("sova_idea", { op: "explore", id: "mesh/fourth" }), /is dropped/);
  });
});
