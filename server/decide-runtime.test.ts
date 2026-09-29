// Run: npx tsx --test server/decide-runtime.test.ts — the call ledger (<stateRoot>/decisions-calls.jsonl).
// A throwaway PI_CODING_AGENT_DIR and HOME; fetch is a fake Jev; the real key is never read.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";

const root = realpathSync(mkdtempSync(join(tmpdir(), "sova-decide-runtime-")));
process.on("exit", () => rmSync(root, { recursive: true, force: true }));
process.env.HOME = join(root, "home"); // the redactor reads credential files under HOME: never the real ones
process.env.PI_CODING_AGENT_DIR = join(root, "agent");
delete process.env.SOVA_JEV_KEY;
after(() => rmSync(root, { recursive: true, force: true }));

const { appendCall, callsFile, createDecisionRuntime, MAX_STATE_CHARS } = await import("./decide-runtime");
const { decisionDefaults } = await import("./decide-settings");
import type { Question } from "./decide";

const KEY = "tsk-fake-" + "k".repeat(60);
const qs: Record<string, Question> = { asks_user: { type: "boolean", instructions: "asks?" } };
const settings = () => ({ ...decisionDefaults(), jev: { enabled: true } });
const noLlm = { runtime: async () => { throw new Error("no model runtime in tests"); }, denial: () => null } as never;

function jevFetch(status: number) {
  return (async () =>
    new Response(JSON.stringify(status === 200 ? { model: "jev-1.13.0", answers: { asks_user: { noul: 0.9 } }, usage: { input_tokens: 812, output_tokens: 0 } } : { detail: "busy" }), { status })) as unknown as typeof fetch;
}

const lines = (file: string) => (existsSync(file) ? readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);

describe("the call ledger", () => {
  test("an answer: purpose, provider, model, latency and usage, never the state, questions, answers or key", async () => {
    const file = join(root, "calls-ok.jsonl");
    const rt = createDecisionRuntime({ settings, key: () => ({ key: KEY, source: "file" }), fetch: jevFetch(200), llm: noLlm, callsFile: file });
    await rt.provider.decide({ purpose: "attention", state: { assistant_last: "Should I merge SECRET-STATE?" }, questions: qs, dedupeKey: "s1:t1" });
    const [l] = lines(file);
    assert.equal(l.purpose, "attention");
    assert.equal(l.ok, true);
    assert.equal(l.provider, "jev");
    assert.equal(l.model, "jev-1.13.0");
    assert.equal(typeof l.latencyMs, "number");
    assert.deepEqual(l.usage, { inputTokens: 812, outputTokens: 0 });
    assert.equal(typeof l.at, "number");
    const raw = readFileSync(file, "utf8");
    for (const secret of ["SECRET-STATE", "asks?", "s1:t1", KEY, "0.9"]) assert.equal(raw.includes(secret), false, secret);
  });

  test("a failure: its name and provider; a state over the cap: too-large with no provider", async () => {
    const file = join(root, "calls-fail.jsonl");
    const rt = createDecisionRuntime({ settings, key: () => ({ key: KEY, source: "file" }), fetch: jevFetch(529), llm: noLlm, callsFile: file });
    await assert.rejects(rt.provider.decide({ purpose: "tags", state: "x", questions: qs }));
    await assert.rejects(rt.provider.decide({ purpose: "worker", state: "y".repeat(MAX_STATE_CHARS + 1), questions: qs }));
    const [fail, big] = lines(file);
    assert.equal(fail.ok, false);
    assert.equal(fail.purpose, "tags");
    assert.equal(fail.failure, "overloaded");
    assert.equal(big.failure, "too-large");
    assert.equal(big.provider, undefined);
  });

  test("the file moves to .1 when a line would pass the cap; a failed write never fails anything", () => {
    const file = join(root, "calls-rot.jsonl");
    writeFileSync(file, "x".repeat(90) + "\n");
    appendCall(file, { at: 1, purpose: "tags", ok: true, latencyMs: 5 }, 100);
    assert.equal(readFileSync(`${file}.1`, "utf8").length, 91);
    assert.equal(lines(file).length, 1);
    appendCall(join(root, "no-dir", "\0bad"), { at: 1, purpose: "tags", ok: true, latencyMs: 5 });
  });

  test("the default file is under the state root", () => {
    assert.equal(callsFile(), join(root, "agent", "sova", "decisions-calls.jsonl"));
  });
});
