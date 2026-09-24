// Run: npx tsx --test server/transcript-context.test.ts
// The head's context meter: which assistant reply's usage is the context fill.
import assert from "node:assert/strict";
import { test } from "node:test";
import { contextForBranch, messageContextTokens } from "./transcript";
import { messageContextTokens as clientMessageContextTokens } from "../src/lib/context";

const usage = (input: number, cacheRead = 0, cacheWrite = 0) => ({ input, output: 5, cacheRead, cacheWrite });
const assistant = (u: unknown, stopReason = "stop", extra: Record<string, unknown> = {}) => ({
  type: "message",
  message: { role: "assistant", provider: "anthropic", model: "claude-x", usage: u, stopReason, ...extra },
});
const user = { type: "message", message: { role: "user", content: "hi" } };

test("the last reply with a usage is the fill", () => {
  assert.deepEqual(contextForBranch([user, assistant(usage(100, 900, 50))]), { tokens: 1050, model: "anthropic/claude-x" });
});

test("a zero-usage error reply after a real one leaves the real one's fill", () => {
  const branch = [user, assistant(usage(1000, 20_000)), user, assistant(usage(0), "error", { errorMessage: "Claude was handed a session id already in use" })];
  assert.deepEqual(contextForBranch(branch), { tokens: 21_000, model: "anthropic/claude-x" });
});

test("error and aborted replies are passed over even with a usage; a zero usage on a stop too", () => {
  const branch = [user, assistant(usage(10)), assistant(usage(500), "aborted"), assistant(usage(700), "error"), assistant(usage(0))];
  assert.equal(contextForBranch(branch)?.tokens, 10);
});

test("nothing before a compaction counts, and a lone error reply gives no fill", () => {
  assert.equal(contextForBranch([assistant(usage(10)), { type: "compaction" }, assistant(usage(0), "error")]), null);
  assert.equal(contextForBranch([user, assistant(usage(0), "error")]), null);
});

test("server and client apply the same per-message rule", () => {
  const cases: unknown[] = [
    undefined, null, "x", { role: "user", usage: usage(5) }, { role: "assistant" },
    { role: "assistant", usage: usage(0) }, { role: "assistant", usage: usage(0, 0, 3) },
    { role: "assistant", usage: usage(7), stopReason: "error" }, { role: "assistant", usage: usage(7), stopReason: "aborted" },
    { role: "assistant", usage: usage(7), stopReason: "toolUse" }, { role: "assistant", usage: usage(1, 2, 3), stopReason: "stop" },
  ];
  for (const m of cases) assert.equal(messageContextTokens(m), clientMessageContextTokens(m), JSON.stringify(m));
  assert.equal(messageContextTokens({ role: "assistant", usage: usage(1, 2, 3) }), 6);
});
