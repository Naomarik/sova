// Run: pnpm test -- server/usage-recording.test.ts
// The server's one-shots write one usage-ledger record each, for the session their caller names
// (review check b2: concurrent side calls with fresh routing ids never take each other's owner).
// Fake runtime, fake spawn, fake fetch: no model is ever called.
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, test } from "node:test";
import { withUsageContext } from "../pi-config/extensions/llm-inflight/attribution.ts";
import { instrumentModelRuntime } from "../pi-config/extensions/llm-inflight/runtime.ts";
import { parseUsageLine, usageRoot, type UsageRecord } from "../pi-config/extensions/llm-inflight/usage-record.ts";
import { DecisionError, type Question } from "./decide";
import { createJevProvider } from "./decide-jev";
import { claudeRun, createLlmProvider, type LlmRuntime } from "./decide-llm";

const qs: Record<string, Question> = { asks: { type: "boolean", instructions: "Does it ask?" } };
const good = JSON.stringify({ asks: { p: 0.8 } });
const fail = (failure: string, message: string) => new DecisionError(failure as never, message);

function records(agentDir: string): UsageRecord[] {
  const out: UsageRecord[] = [];
  let days: string[] = [];
  try {
    days = readdirSync(usageRoot(agentDir));
  } catch {
    return out;
  }
  for (const day of days)
    for (const f of readdirSync(join(usageRoot(agentDir), day)))
      for (const line of readFileSync(join(usageRoot(agentDir), day, f), "utf8").split("\n"))
        if (line) out.push(parseUsageLine(line)!);
  return out;
}

/** A runtime shaped like pi's: completeSimple goes through streamSimple, which the ledger wraps. Replies wait on `release`. */
function gatedRuntime() {
  const waiting: { sessionId: unknown; resolve: () => void }[] = [];
  const rt = {
    getModel: (provider: string, id: string) => ({ provider, id, api: "fake", reasoning: false }),
    hasConfiguredAuth: () => true,
    stream: () => assert.fail("not used"),
    streamSimple(model: { provider: string; id: string }, _ctx: unknown, options: { sessionId?: unknown; onPayload?: (p: unknown) => unknown }) {
      let settle!: (m: unknown) => void;
      const result = new Promise((r) => (settle = r));
      const n = waiting.length;
      waiting.push({
        sessionId: options?.sessionId,
        resolve: () =>
          settle({
            role: "assistant", provider: model.provider, model: model.id, api: "fake", stopReason: "stop", timestamp: 1_800_000_000_000 + n,
            content: [{ type: "text", text: good }],
            usage: { input: 100 + n, output: 20 + n, cacheRead: 5, cacheWrite: 0, totalTokens: 0, cost: { total: 0 } },
          }),
      });
      void options?.onPayload?.({});
      return { result: () => result };
    },
    async completeSimple(this: { streamSimple: (...a: unknown[]) => { result(): Promise<unknown> } }, model: unknown, ctx: unknown, options: unknown) {
      return this.streamSimple(model, ctx, options).result();
    },
  };
  assert.equal(instrumentModelRuntime(rt), "instrumented");
  return { runtime: async () => rt as unknown as LlmRuntime, waiting };
}

function fakeClaude(envelope: (argv: string[]) => object) {
  const children: (EventEmitter & { stdout: PassThrough; finish(): void })[] = [];
  const spawn = ((_bin: string, argv: string[]) => {
    const child = new EventEmitter() as EventEmitter & { stdin: PassThrough; stdout: PassThrough; stderr: PassThrough; kill(): void; pid: number; finish(): void };
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.pid = 4242;
    child.kill = () => undefined;
    child.finish = () => {
      child.stdout.write(JSON.stringify(envelope(argv)));
      setImmediate(() => {
        child.emit("exit", 0);
        child.emit("close", 0);
      });
    };
    children.push(child);
    return child;
  }) as unknown as typeof import("node:child_process").spawn;
  return { spawn, children };
}

const until = async (cond: () => boolean) => {
  for (let i = 0; i < 200 && !cond(); i++) await new Promise((r) => setTimeout(r, 5));
  assert.ok(cond());
};

describe("usage records of Sova's one-shots", () => {
  let dir: string;
  let prev: string | undefined;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "usage-rec-"));
    prev = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = dir;
  });
  afterEach(() => {
    if (prev === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = prev;
    rmSync(dir, { recursive: true, force: true });
  });

  test("b2: two concurrent pi decisions with fresh routing ids keep their own owner, cwd and purpose", async () => {
    const f = gatedRuntime();
    const provider = createLlmProvider({ backend: "pi", model: "prov/model-x", effort: "off" }, { runtime: f.runtime, agentDir: () => dir });
    const a = withUsageContext({ owner: "sess-A", cwd: "/work/a" }, () => provider.decide({ purpose: "attention", state: "a", questions: qs }));
    const b = withUsageContext({ owner: "sess-B", cwd: "/work/b" }, () => provider.decide({ purpose: "reconcile", state: "b", questions: qs }));
    await until(() => f.waiting.length === 2);
    assert.notEqual(f.waiting[0]!.sessionId, f.waiting[1]!.sessionId, "each call has its own fresh routing id");
    // Answer in the other order: the owner was taken when each call was made.
    f.waiting[1]!.resolve();
    await b;
    f.waiting[0]!.resolve();
    await a;
    const recs = records(dir).sort((x, y) => x.input - y.input);
    assert.equal(recs.length, 2);
    assert.deepEqual(
      recs.map((r) => [r.owner, r.cwd, r.purpose, r.kind, r.src, r.provider, r.model, r.input, r.output, r.cacheRead]),
      [
        ["sess-A", "/work/a", "decide", "oneshot", "pi", "prov", "model-x", 100, 20, 5],
        ["sess-B", "/work/b", "reconcile", "oneshot", "pi", "prov", "model-x", 101, 21, 5],
      ],
    );
    assert.ok(recs.every((r) => !r.key.startsWith("pi:")), "a fresh routing id is no session: its key is the producer's own");
  });

  test("b2: two concurrent `claude -p` runs record their envelopes for their own callers", async () => {
    const f = fakeClaude((argv) => ({
      type: "result", subtype: "success", is_error: false, result: good, session_id: `env-${argv.includes("haiku") ? "h" : "s"}`,
      modelUsage: { [argv.includes("haiku") ? "claude-haiku-4-5-20251001" : "claude-sonnet-4-5"]: { inputTokens: 10, outputTokens: 3, cacheReadInputTokens: 7, cacheCreationInputTokens: 2 } },
    }));
    const deps = { spawn: f.spawn, agentDir: () => dir };
    const a = withUsageContext({ owner: "sess-A", cwd: "/work/a", purpose: "title", kind: "oneshot" }, () => claudeRun(["-p", "--model", "haiku"], "q", deps, 5_000, fail));
    const b = withUsageContext({ owner: "sess-B", cwd: "/work/b", purpose: "outline", kind: "oneshot" }, () => claudeRun(["-p", "--model", "sonnet"], "q", deps, 5_000, fail));
    await until(() => f.children.length === 2);
    f.children[1]!.finish();
    await b;
    f.children[0]!.finish();
    await a;
    const recs = records(dir).sort((x, y) => x.key.localeCompare(y.key));
    assert.deepEqual(
      recs.map((r) => [r.key, r.owner, r.cwd, r.purpose, r.src, r.provider, r.model, r.responseModel, r.input, r.output, r.cacheRead, r.cacheWrite]),
      [
        ["cp:env-h:claude-haiku-4-5-20251001", "sess-A", "/work/a", "title", "claude-p", "claude-code-cli", "haiku", "claude-haiku-4-5-20251001", 10, 3, 7, 2],
        ["cp:env-s:claude-sonnet-4-5", "sess-B", "/work/b", "outline", "claude-p", "claude-code-cli", "sonnet", "claude-sonnet-4-5", 10, 3, 7, 2],
      ],
    );
  });

  test("a reconcile call is the project's: no owner, its project, starter and purpose", async () => {
    const f = gatedRuntime();
    const provider = createLlmProvider({ backend: "pi", model: "prov/model-x", effort: "off" }, { runtime: f.runtime, agentDir: () => dir });
    const p = withUsageContext({ owner: null, project: "prj_abc", purpose: "reconcile", kind: "oneshot", starter: "overseer" }, () => provider.decide({ purpose: "reconcile", state: "x", questions: qs }));
    await until(() => f.waiting.length === 1);
    f.waiting[0]!.resolve();
    await p;
    const [r] = records(dir);
    assert.deepEqual([r!.owner, r!.project, r!.starter, r!.purpose, r!.kind], [null, "prj_abc", "overseer", "reconcile", "oneshot"]);
  });

  test("a decision no caller names a session for is owned by no one", async () => {
    const f = fakeClaude(() => ({ type: "result", subtype: "success", is_error: false, structured_output: { asks: { p: 0.5 } }, session_id: "e1", modelUsage: { "claude-haiku-4-5": { inputTokens: 4, outputTokens: 1 } } }));
    const p = createLlmProvider({ backend: "claude-code", model: "haiku", effort: "off" }, { spawn: f.spawn, agentDir: () => dir }).decide({ purpose: "attention", state: "x", questions: qs });
    await until(() => f.children.length === 1);
    f.children[0]!.finish();
    await p;
    const [r] = records(dir);
    assert.equal(r!.owner, null);
    assert.equal(r!.purpose, "decide");
    assert.equal(r!.kind, "oneshot");
  });

  test("a Jev answer is one record, for the session its caller named", async () => {
    const fetch = (async () =>
      new Response(JSON.stringify({ answers: { asks: { noul: 0.9 } }, model: "jev-2", usage: { input_tokens: 50, output_tokens: 4 } }), {
        status: 200,
        headers: { "x-typesafe-request-id": "req-1" },
      })) as unknown as typeof globalThis.fetch;
    const jev = createJevProvider({ key: () => "tsk-fake-key", fetch });
    await withUsageContext({ owner: "sess-J", cwd: "/work/j" }, () => jev.decide({ purpose: "attention", state: "x", questions: qs }));
    const [r] = records(dir);
    assert.deepEqual([r!.key, r!.src, r!.provider, r!.model, r!.responseModel, r!.owner, r!.cwd, r!.purpose, r!.input, r!.output], ["jev:req-1", "jev", "jev", "jev-latest", "jev-2", "sess-J", "/work/j", "decide", 50, 4]);
  });
});
