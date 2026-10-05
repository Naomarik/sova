// Run: pnpm test -- server/harness/pi/usage.test.ts. The pi worker adapter's context rule as its summaries
// carry it (moved from server/worker-context.test.ts: only the adapter imports
// pi-config/extensions/subagents/adapters/pi.ts).
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { summarizePiEntries } from "../../../pi-config/extensions/subagents/adapters/pi.ts";

const piReply = (input: number, extra: Record<string, unknown> = {}) => ({
  type: "message",
  message: { role: "assistant", provider: "zai", model: "glm-5.3", content: [{ type: "text", text: "ok" }],
    usage: { input, output: 50, cacheRead: 1000, cacheWrite: 10 }, stopReason: "stop", ...extra },
});
const piCompaction = { type: "compaction", summary: "…" };

describe("the pi worker adapter", () => {
  test("summaries carry lastContextTokens: the last reply that reports one, null after a compaction", () => {
    const ref = { v: 1 as const, backend: "pi", kind: "pi-session-file" as const, locator: "/x.jsonl" };
    const header = { type: "session", version: 3, id: "s", timestamp: "2026-09-25T00:00:00Z", cwd: "/" };
    const chain = (...es: Record<string, unknown>[]) => es.map((e, i) => ({ ...e, id: `e${i}`, parentId: i ? `e${i - 1}` : null }));
    assert.equal(summarizePiEntries([header, ...chain(piReply(1), piReply(2), piReply(3, { stopReason: "error" }))], ref).lastContextTokens, 2 + 1010);
    assert.equal(summarizePiEntries([header, ...chain(piReply(1), piCompaction)], ref).lastContextTokens, null);
    assert.equal(summarizePiEntries([header, ...chain(piReply(1), piCompaction, piReply(7))], ref).lastContextTokens, 7 + 1010);
    assert.ok(!("lastContextTokens" in summarizePiEntries([header], ref)), "no reply yet: absent, never 0");
  });
});
