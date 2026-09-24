// Run: npx tsx --test server/transcript-usage.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { claudeUsageTally, piUsageTally, totalOf } from "./transcript-usage";

const jsonl = (...entries: unknown[]) => entries.map((e) => JSON.stringify(e)).join("\n") + "\n";
const piMessage = (id: string, usage: unknown, parentId?: string) =>
  ({ id, parentId, type: "message", message: { role: "assistant", content: [{ type: "text", text: "hi" }], usage } });
const piUsage = (input: number, output: number, cacheRead: number, cacheWrite: number, cost: number) =>
  ({ input, output, cacheRead, cacheWrite, reasoning: 7, totalTokens: input + cacheRead + cacheWrite + output,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: cost } });
const ccAssistant = (id: string, usage: unknown, extra: Record<string, unknown> = {}) =>
  ({ type: "assistant", uuid: `u-${id}-${Math.random()}`, message: { id, role: "assistant", content: [], usage }, ...extra });
const ccUsage = (input: number, output: number, cacheRead: number, cacheWrite: number) =>
  ({ input_tokens: input, output_tokens: output, cache_read_input_tokens: cacheRead, cache_creation_input_tokens: cacheWrite });

test("pi tally sums assistant usage, accumulates across appends and resets on a snapshot", () => {
  const tally = piUsageTally();
  const first = tally(jsonl({ type: "session", id: "s" }, piMessage("a", piUsage(100, 10, 900, 50, 0.25)),
    { type: "message", message: { role: "user", content: [] } }), "snapshot");
  assert.deepEqual(totalOf(first), { input: 100, output: 10, cacheRead: 900, cacheWrite: 50, cost: 0.25 });
  const second = tally(jsonl(piMessage("b", piUsage(20, 5, 100, 0, 0.05), "a")), "append");
  assert.deepEqual(totalOf(second), { input: 120, output: 15, cacheRead: 1000, cacheWrite: 50, cost: 0.3 });
  // The same entry re-read (a rewritten tail) is not counted twice.
  assert.deepEqual(totalOf(tally(jsonl(piMessage("b", piUsage(20, 5, 100, 0, 0.05), "a")), "append")), totalOf(second));
  // A rewritten file starts over.
  assert.deepEqual(totalOf(tally(jsonl(piMessage("c", piUsage(1, 1, 1, 1, 0))), "snapshot")),
    { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 });
});

test("pi tally ignores non-assistant, usage-less and malformed entries", () => {
  const tally = piUsageTally();
  const text = jsonl(
    { type: "message", id: "u1", message: { role: "user", content: [], usage: piUsage(9, 9, 9, 9, 9) } },
    piMessage("a1", undefined),
    piMessage("a2", piUsage(-5, Number.NaN, 10, 0, 0)),
    { type: "compaction", id: "c1" },
  ) + "not json\n\n";
  assert.deepEqual(totalOf(tally(text, "snapshot")), { input: 0, output: 0, cacheRead: 10, cacheWrite: 0 });
  assert.equal(totalOf(tally(jsonl(piMessage("a3", undefined)), "snapshot")), undefined, "nothing counted yet");
});

test("claude tally deduplicates one message repeated across lines and across appends", () => {
  const tally = claudeUsageTally();
  const usage = ccUsage(2, 308, 7171, 4376);
  const snapshot = tally(jsonl(ccAssistant("msg_1", usage), ccAssistant("msg_1", usage),
    { type: "user", message: { role: "user", content: [] } }), "snapshot");
  assert.deepEqual(totalOf(snapshot), { input: 2, output: 308, cacheRead: 7171, cacheWrite: 4376 });
  // The straddling line: the same message id arriving in the next append adds nothing.
  assert.deepEqual(totalOf(tally(jsonl(ccAssistant("msg_1", usage)), "append")), totalOf(snapshot));
  const next = tally(jsonl(ccAssistant("msg_2", ccUsage(1, 40, 11_000, 0), { isSidechain: true })), "append");
  assert.deepEqual(totalOf(next), { input: 3, output: 348, cacheRead: 18_171, cacheWrite: 4376 },
    "a sidechain agent's tokens are the worker's spend too");
  assert.equal(totalOf(next)!.cost, undefined, "CC's JSONL carries no cost");
});

test("pi tally counts top-level usage entries once, across appends, and resets on a snapshot", () => {
  const tally = piUsageTally();
  const warm = (id: string) => ({ id, parentId: "a", type: "usage", kind: "cache_warm", provider: "anthropic", model: "m",
    usage: piUsage(0, 0, 50_000, 0, 0.015) });
  const first = tally(jsonl(piMessage("a", piUsage(100, 10, 900, 50, 0.25)), warm("w1")), "snapshot");
  assert.deepEqual(totalOf(first), { input: 100, output: 10, cacheRead: 50_900, cacheWrite: 50, cost: 0.265 });
  // The same usage entry arriving again in an append adds nothing.
  assert.deepEqual(totalOf(tally(jsonl(warm("w1")), "append")), totalOf(first));
  // An unknown kind is still usage.
  const next = tally(jsonl({ ...warm("w2"), kind: "something-new" }), "append");
  assert.deepEqual(totalOf(next), { input: 100, output: 10, cacheRead: 100_900, cacheWrite: 50, cost: 0.28 });
  assert.deepEqual(totalOf(tally(jsonl(warm("w3")), "snapshot")),
    { input: 0, output: 0, cacheRead: 50_000, cacheWrite: 0, cost: 0.015 });
});

test("pi tally keeps a forked session's copied usage: no fork cut-off for main sessions", () => {
  const tally = piUsageTally();
  const text = jsonl(
    { type: "session", version: 3, id: "fork", timestamp: "2026-09-24T12:00:00.000Z", parentSession: "/tmp/parent.jsonl" },
    // Copied from the parent: stamped before the fork, and no worker marker follows.
    { ...piMessage("p1", piUsage(100, 10, 0, 0, 0.1)), timestamp: "2026-09-24T11:00:00.000Z" },
    { ...piMessage("f1", piUsage(1, 1, 0, 0, 0.01), "p1"), timestamp: "2026-09-24T12:05:00.000Z" },
  );
  assert.deepEqual(totalOf(tally(text, "snapshot")), { input: 101, output: 11, cacheRead: 0, cacheWrite: 0, cost: 0.11 });
});
