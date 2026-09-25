// Run: npx tsx --test server/decide-llm.test.ts — pi and Claude Code providers over a fake runtime
// and a fake spawn (no model is ever called).
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { PassThrough } from "node:stream";
import { describe, test } from "node:test";
import { DecisionError, type Question } from "./decide";
import { answerSchema, buildPrompt, claudeArgs, createLlmProvider, textFailure, type LlmRuntime } from "./decide-llm";

const qs: Record<string, Question> = {
  asks: { type: "boolean", instructions: "Does it ask?" },
  outcome: { type: "choice", instructions: "Outcome?", options: { done: "finished", blocked_on_user: "waits on the user" } },
  stuck: { type: "score", instructions: "Stuck?", levels: ["progress", "some repetition", "looping"] },
};
const good = { asks: { p: 0.8 }, outcome: { probabilities: { done: 0.1, blocked_on_user: 0.9 } }, stuck: { probabilities: [0.9, 0.1, 0] } };
const req = { purpose: "attention" as const, state: { assistant_last: "Shall I push?" }, questions: qs };

async function failure(p: Promise<unknown>): Promise<DecisionError> {
  try {
    await p;
  } catch (err) {
    assert.ok(err instanceof DecisionError, String(err));
    return err;
  }
  assert.fail("expected a DecisionError");
}

function fakeRuntime(reply: (opts: Record<string, unknown>) => Awaited<ReturnType<LlmRuntime["completeSimple"]>> | Promise<never>, opts: { model?: object | null; auth?: boolean } = {}) {
  const calls: { context: unknown; options: Record<string, unknown> }[] = [];
  const runtime: LlmRuntime = {
    getModel: () => (opts.model === undefined ? { id: "m", reasoning: false } : opts.model),
    hasConfiguredAuth: () => opts.auth ?? true,
    completeSimple: async (_m: never, context: unknown, options?: unknown) => {
      calls.push({ context, options: options as Record<string, unknown> });
      return reply(options as Record<string, unknown>);
    },
  };
  return { runtime: async () => runtime, calls };
}
const text = (t: string) => ({ content: [{ type: "text", text: t }], stopReason: "stop", usage: { input: 100, output: 20 } });
const pi = { backend: "pi" as const, model: "prov/model-x", effort: "off" };

describe("prompt", () => {
  test("every option key verbatim, the state inside the fence, levels numbered", () => {
    const p = buildPrompt(req);
    for (const k of ["done", "blocked_on_user"]) assert.ok(p.includes(JSON.stringify(k)), k);
    const fenced = p.split("```")[1] ?? "";
    assert.ok(fenced.includes('"assistant_last": "Shall I push?"'));
    assert.ok(p.includes("2. looping"));
  });
  test("a state containing ``` uses a different fence", () => {
    const p = buildPrompt({ ...req, state: "look: ```code```" });
    assert.ok(p.includes("~~~~\nlook: ```code```\n~~~~"));
  });
});

describe("pi backend", () => {
  test("fenced JSON → answers with confidence computed in code; temperature 0, no cache", async () => {
    const f = fakeRuntime(() => text("```json\n" + JSON.stringify(good) + "\n```"));
    const r = await createLlmProvider(pi, { runtime: f.runtime }).decide(req);
    assert.equal(r.provider, "pi");
    assert.equal(r.model, "prov/model-x");
    assert.deepEqual(r.answers.asks, { type: "boolean", p: 0.8 });
    assert.ok(r.answers.outcome?.type === "choice" && Math.abs(r.answers.outcome.confidence - 0.8) < 1e-9);
    assert.equal(f.calls[0]!.options.temperature, 0);
    assert.equal(f.calls[0]!.options.cacheRetention, "none");
    assert.equal("reasoning" in f.calls[0]!.options, false);
    assert.deepEqual(r.usage, { inputTokens: 100, outputTokens: 20 });
  });
  test("JSON with prose around it still parses", async () => {
    const f = fakeRuntime(() => text(`Here you go: ${JSON.stringify(good)} hope that helps`));
    assert.equal((await createLlmProvider(pi, { runtime: f.runtime }).decide(req)).answers.asks?.type, "boolean");
  });
  test("an effort on a reasoning model is passed as `reasoning`", async () => {
    const f = fakeRuntime(() => text(JSON.stringify(good)), { model: { id: "m", reasoning: true } });
    await createLlmProvider({ ...pi, effort: "low" }, { runtime: f.runtime }).decide(req);
    assert.equal(f.calls[0]!.options.reasoning, "low");
  });
  test("junk → malformed-answer; stopReason error naming a rate limit → rate-limit", async () => {
    assert.equal((await failure(createLlmProvider(pi, { runtime: fakeRuntime(() => text("I think yes")).runtime }).decide(req))).failure, "malformed-answer");
    const err = fakeRuntime(() => ({ content: [], stopReason: "error", errorMessage: "429 rate limit exceeded" }));
    const e = await failure(createLlmProvider(pi, { runtime: err.runtime }).decide(req));
    assert.equal(e.failure, "rate-limit");
    assert.equal(e.provider, "pi");
  });
  test("registry miss → unavailable; no auth → auth; policy denial → unavailable, and nothing is called", async () => {
    const miss = fakeRuntime(() => text("{}"), { model: null });
    assert.equal((await failure(createLlmProvider(pi, { runtime: miss.runtime }).decide(req))).failure, "unavailable");
    const noAuth = fakeRuntime(() => text("{}"), { auth: false });
    assert.equal((await failure(createLlmProvider(pi, { runtime: noAuth.runtime }).decide(req))).failure, "auth");
    const denied = fakeRuntime(() => text("{}"));
    assert.equal((await failure(createLlmProvider(pi, { runtime: denied.runtime, denial: () => "prov is turned off" }).decide(req))).failure, "unavailable");
    assert.equal(miss.calls.length + noAuth.calls.length + denied.calls.length, 0);
  });
  test("our deadline → timeout", async () => {
    const hang = fakeRuntime((o) => new Promise<never>((_r, reject) => (o.signal as AbortSignal).addEventListener("abort", () => reject(new Error("aborted")))));
    assert.equal((await failure(createLlmProvider(pi, { runtime: hang.runtime, timeoutMs: 20 }).decide(req))).failure, "timeout");
  });
  test("textFailure", () => {
    assert.equal(textFailure("Your credit balance is too low"), "quota");
    assert.equal(textFailure("overloaded_error"), "overloaded");
    assert.equal(textFailure("prompt is too long: context length"), "too-large");
    assert.equal(textFailure("401 Unauthorized"), "auth");
    assert.equal(textFailure("something odd"), "server");
  });
});

/** A fake child process: records argv/cwd, writes `stdout`, exits with `code`. */
function fakeSpawn(stdout: string, code = 0) {
  const seen: { bin: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv; stdin: string }[] = [];
  const spawn = ((bin: string, args: string[], opts: { cwd: string; env: NodeJS.ProcessEnv }) => {
    const child = new EventEmitter() as EventEmitter & { stdin: PassThrough; stdout: PassThrough; stderr: PassThrough; kill: () => void };
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => {};
    const rec = { bin, args, cwd: opts.cwd, env: opts.env, stdin: "" };
    seen.push(rec);
    child.stdin.on("data", (c) => (rec.stdin += c));
    child.stdin.on("finish", () => {
      child.stdout.end(stdout);
      setImmediate(() => child.emit("close", code));
    });
    return child;
  }) as unknown as typeof import("node:child_process").spawn;
  return { spawn, seen };
}

describe("claude-code backend", () => {
  const cc = { backend: "claude-code" as const, model: "haiku", effort: "low" };
  test("structured_output envelope → answers; argv, private cwd (removed after), CLAUDECODE stripped", async () => {
    process.env.CLAUDECODE = "1";
    const f = fakeSpawn(JSON.stringify({ type: "result", is_error: false, result: "", structured_output: good, usage: { input_tokens: 50, output_tokens: 9 } }));
    const r = await createLlmProvider(cc, { spawn: f.spawn }).decide(req);
    delete process.env.CLAUDECODE;
    assert.equal(r.provider, "claude-code");
    assert.deepEqual(r.answers.asks, { type: "boolean", p: 0.8 });
    const s = f.seen[0]!;
    assert.equal(s.bin, "claude");
    assert.deepEqual(s.args, claudeArgs(cc, answerSchema(qs)));
    for (const flag of ["--tools", "--strict-mcp-config", "--no-session-persistence", "--json-schema", "--max-budget-usd"]) assert.ok(s.args.includes(flag), flag);
    assert.equal(s.args[s.args.indexOf("--effort") + 1], "low");
    assert.equal(s.env.CLAUDECODE, undefined);
    assert.ok(s.stdin.includes("Shall I push?"));
    assert.equal(existsSync(s.cwd), false);
  });
  test("a text `result` envelope parses too (the schema fallback)", async () => {
    const f = fakeSpawn(JSON.stringify({ is_error: false, result: "```json\n" + JSON.stringify(good) + "\n```" }));
    assert.equal((await createLlmProvider(cc, { spawn: f.spawn }).decide(req)).answers.stuck?.type, "score");
  });
  test("is_error envelope → mapped failure; empty output → failure from the exit", async () => {
    const f = fakeSpawn(JSON.stringify({ is_error: true, result: "API Error: 529 overloaded" }), 1);
    assert.equal((await failure(createLlmProvider(cc, { spawn: f.spawn }).decide(req))).failure, "overloaded");
    const g = fakeSpawn("", 1);
    assert.equal((await failure(createLlmProvider(cc, { spawn: g.spawn }).decide(req))).failure, "server");
  });
  test("schema: choice keys required, score arrays sized", () => {
    const s = answerSchema(qs) as { required: string[]; properties: Record<string, { properties: Record<string, { required?: string[]; minItems?: number }> }> };
    assert.deepEqual(s.required, ["asks", "outcome", "stuck"]);
    assert.deepEqual(s.properties.outcome!.properties.probabilities!.required, ["done", "blocked_on_user"]);
    assert.equal(s.properties.stuck!.properties.probabilities!.minItems, 3);
  });
});
