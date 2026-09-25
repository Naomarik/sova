// Run: npx tsx --test server/worker-context.test.ts
// A worker's context fill (the subagents pane): the per-line rules of both backends, the tail read
// and its mtime gate, the claude-code window rule and where its model comes from, the watch tally.
import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import type { WorkerInfo } from "../shared/protocol";
import { claudeContextOf, summarizeClaudeEntries } from "../pi-config/extensions/claude-code/transcript-adapter.ts";
import { piContextOf, summarizePiEntries } from "../pi-config/extensions/subagents/adapters/pi.ts";
import { contextForBranch, messageContextTokens } from "./transcript";
import {
  claudeCodeContextWindow,
  claudeSpawnModel,
  claudeSpawnModels,
  contextTally,
  readTailFill,
  WorkerContextReader,
  withSpawnVariant,
  withWorkerContext,
  workerWindow,
} from "./worker-context";

const root = mkdtempSync(join(tmpdir(), "sova-worker-context-test-"));
after(() => rmSync(root, { recursive: true, force: true }));

const jsonl = (...lines: unknown[]) => lines.map((l) => JSON.stringify(l)).join("\n") + "\n";
let n = 0;
const file = (text: string) => {
  const p = join(root, `f${n++}.jsonl`);
  writeFileSync(p, text);
  return p;
};

// ---- pi lines ----
const piReply = (input: number, extra: Record<string, unknown> = {}, id = `a${n++}`) => ({
  type: "message", id, parentId: null,
  message: { role: "assistant", provider: "zai", model: "glm-5.3", content: [{ type: "text", text: "ok" }],
    usage: { input, output: 50, cacheRead: 1000, cacheWrite: 10 }, stopReason: "stop", ...extra },
});
const piCompaction = { type: "compaction", id: "c", parentId: null, summary: "…" };

// ---- claude lines ----
const ccReply = (id: string, input: number, extra: Record<string, unknown> = {}, msg: Record<string, unknown> = {}) => ({
  type: "assistant", uuid: `${id}-${n++}`,
  message: { id, role: "assistant", model: "claude-opus-5-5", content: [{ type: "text", text: "ok" }],
    usage: { input_tokens: input, output_tokens: 99, cache_read_input_tokens: 3000, cache_creation_input_tokens: 200 }, ...msg },
  ...extra,
});
const ccCompact = { type: "system", subtype: "compact_boundary", uuid: "cb" };

describe("the claude-code window rule", () => {
  test("is the extension's own rule: [1m] is 1M, anything else 200k", () => {
    // The extension's provider module pulls the CLI bridge and pi-ai, so it can't be imported here;
    // its contextWindowFor body is run as written instead. A rename or reshape fails this loudly.
    const src = readFileSync(new URL("../pi-config/extensions/claude-code/provider/index.ts", import.meta.url), "utf8");
    const m = /export function contextWindowFor\(id: string\): number \{([\s\S]*?)\n\}/.exec(src);
    assert.ok(m, "contextWindowFor(id: string): number is still in provider/index.ts");
    const extension = new Function("id", m[1]!) as (id: string) => number;
    for (const id of ["opus[1m]", "claude-opus-5-5[1m]", "sonnet[1m]", "opus", "claude-opus-5-5", "haiku", "opus[1M]", "[1m]opus", ""]) {
      assert.equal(claudeCodeContextWindow(id), extension(id), id);
    }
    assert.equal(claudeCodeContextWindow("claude-opus-5-5[1m]"), 1_000_000);
    assert.equal(claudeCodeContextWindow("claude-opus-5-5"), 200_000);
  });

  test("a claude-code worker's window follows its spawn model; a pi worker's asks the resolver", () => {
    const resolve = (ref: string) => (ref === "zai/glm-5.3" ? 128_000 : null);
    assert.equal(workerWindow({ backend: "claude-code", model: "claude-opus-5-5[1m]" }, resolve), 1_000_000);
    assert.equal(workerWindow({ backend: "claude-code", model: "claude-opus-5-5" }, resolve, "claude-opus-5-5[1m]"), 1_000_000, "spawn model wins over the row's bare id");
    assert.equal(workerWindow({ backend: "claude-code" }, resolve), null, "no model: unknown, not 200k");
    assert.equal(workerWindow({ backend: "pi", model: "zai/glm-5.3" }, resolve), 128_000);
    assert.equal(workerWindow({ backend: "pi", model: "who/knows" }, resolve), null);
  });

  test("the spawn model: the manifest's spec, else the snapshot's biggest row, never the transcript", () => {
    assert.equal(claudeSpawnModel({ spec: { cwd: "/", model: "opus[1m]", taskPreview: "", wake: false } }), "opus[1m]");
    const row = (model: string, input: number) => ({ model, input, output: 0, cacheRead: 0, cacheWrite: 0, turns: 1 });
    const usageSnapshot = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, source: "snapshot" as const,
      byModel: [row("claude-haiku-4-5", 5), row("claude-opus-5-5[1m]", 500)] };
    assert.equal(claudeSpawnModel({ usageSnapshot }), "claude-opus-5-5[1m]");
    assert.equal(claudeSpawnModel({ usageSnapshot: { ...usageSnapshot, byModel: [row("claude/claude-opus-5-5[1m]", 1)] } }), "claude-opus-5-5[1m]");
    assert.equal(claudeSpawnModel({}), undefined);
    const of = claudeSpawnModels([
      { type: "custom", id: "m1", customType: "subagents-worker-manifest", data: { v: 1, kind: "worker-manifest", at: 1, workerId: "ag_01", backend: "claude-code",
        spec: { cwd: "/", model: "claude-opus-5-5[1m]", taskPreview: "", wake: false } } },
      { type: "custom", id: "m2", customType: "subagents-worker-manifest", data: { v: 1, kind: "worker-manifest", at: 1, workerId: "ag_02", backend: "pi",
        spec: { cwd: "/", model: "zai/glm-5.3", taskPreview: "", wake: false } } },
    ]);
    assert.equal(of("ag_01"), "claude-opus-5-5[1m]");
    assert.equal(of("ag_02"), undefined, "pi windows come from the reply's own model");
  });
});

describe("per-line rules", () => {
  test("pi: the adapter's rule is the session head's, entry for entry", () => {
    const cases: unknown[] = [
      piReply(100),
      piReply(100, { stopReason: "error" }),
      piReply(100, { stopReason: "aborted" }),
      piReply(100, { stopReason: "length" }),
      { type: "message", message: { role: "assistant", usage: { input: 0, cacheRead: 0, cacheWrite: 0, output: 9 } } },
      { type: "message", message: { role: "assistant" } },
      { type: "message", message: { role: "user", usage: { input: 5 } } },
      { type: "usage", kind: "cache_warm", usage: { input: 5 } },
      piCompaction,
      { type: "message", message: { role: "compactionSummary" } },
    ];
    for (const e of cases) {
      const head = contextForBranch([e as never]);
      const mine = piContextOf(e);
      const isCompaction = (e as any).type === "compaction" || (e as any).message?.role === "compactionSummary";
      if (isCompaction) assert.equal(mine, "compacted");
      else assert.equal(mine, head?.tokens ?? null, JSON.stringify(e));
      if (typeof mine === "number") assert.equal(mine, messageContextTokens((e as any).message));
    }
    assert.equal(piContextOf(piReply(100)), 100 + 1000 + 10, "input + cacheRead + cacheWrite, output never");
  });

  test("claude: input + cache read + cache creation; failed, synthetic, nested and zero say nothing", () => {
    assert.equal(claudeContextOf(ccReply("m1", 4)), 4 + 3000 + 200);
    assert.equal(claudeContextOf(ccReply("m1", 4, { isApiErrorMessage: true })), null);
    assert.equal(claudeContextOf(ccReply("m1", 4, {}, { model: "<synthetic>" })), null);
    assert.equal(claudeContextOf(ccReply("m1", 4, { isSidechain: true })), null, "a nested agent's context is its own");
    assert.equal(claudeContextOf(ccReply("m1", 0, {}, { usage: { input_tokens: 0, output_tokens: 5 } })), null);
    assert.equal(claudeContextOf(ccCompact), "compacted");
    assert.equal(claudeContextOf({ type: "system", subtype: "other" }), null);
    assert.equal(claudeContextOf({ type: "user", message: { role: "user", content: "go" } }), null);
  });

  test("summaries carry lastContextTokens: the last reply that reports one, null after a compaction", () => {
    const ref = { v: 1 as const, backend: "pi", kind: "pi-session-file" as const, locator: "/x.jsonl" };
    const header = { type: "session", version: 3, id: "s", timestamp: "2026-09-25T00:00:00Z", cwd: "/" };
    const chain = (...es: Record<string, unknown>[]) => es.map((e, i) => ({ ...e, id: `e${i}`, parentId: i ? `e${i - 1}` : null }));
    assert.equal(summarizePiEntries([header, ...chain(piReply(1), piReply(2), piReply(3, { stopReason: "error" }))], ref).lastContextTokens, 2 + 1010);
    assert.equal(summarizePiEntries([header, ...chain(piReply(1), piCompaction)], ref).lastContextTokens, null);
    assert.equal(summarizePiEntries([header, ...chain(piReply(1), piCompaction, piReply(7))], ref).lastContextTokens, 7 + 1010);
    assert.ok(!("lastContextTokens" in summarizePiEntries([header], ref)), "no reply yet: absent, never 0");

    const cref = { v: 1 as const, backend: "claude-code", kind: "claude-session-id" as const, locator: "x" };
    assert.equal(summarizeClaudeEntries([ccReply("a", 1), ccReply("b", 2), ccReply("s", 50, { isSidechain: true })], [], cref).lastContextTokens, 2 + 3200);
    assert.equal(summarizeClaudeEntries([ccReply("a", 1), ccCompact], [], cref).lastContextTokens, null);
    assert.ok(!("lastContextTokens" in summarizeClaudeEntries([], [], cref)));
  });
});

describe("the tail read", () => {
  test("pi: the last reply's fill and model, past a failed reply and non-reply lines", () => {
    const p = file(jsonl(piReply(10), piReply(20), piReply(99, { stopReason: "error" }), { type: "usage", usage: { input: 5 } }, { type: "custom", customType: "x" }));
    assert.deepEqual(readTailFill(p, readFileSync(p).length, "pi"), { tokens: 20 + 1010, model: "zai/glm-5.3" });
  });

  test("a compaction after the last reply is 'compacted'; a torn last line is skipped", () => {
    const p = file(jsonl(piReply(10), piCompaction) + '{"type":"message","message":{"role":"assist');
    assert.equal(readTailFill(p, readFileSync(p).length, "pi"), "compacted");
    const q = file(jsonl(ccReply("a", 1), ccCompact, { type: "attachment", attachment: {} }));
    assert.equal(readTailFill(q, readFileSync(q).length, "claude"), "compacted");
  });

  test("claude: a reply repeated per block reads once; sidechains and bookkeeping are passed over", () => {
    const p = file(jsonl(ccReply("a", 1), ccReply("b", 2), ccReply("b", 2), ccReply("s", 900, { isSidechain: true }), { type: "last-prompt" }));
    assert.deepEqual(readTailFill(p, readFileSync(p).length, "claude"), { tokens: 2 + 3200, model: null });
  });

  test("past a line longer than a chunk, and nothing at all within the cap", () => {
    const big = { type: "message", id: "big", message: { role: "toolResult", content: "x".repeat(40_000) } };
    const p = file(jsonl(piReply(10), big));
    assert.equal((readTailFill(p, readFileSync(p).length, "pi") as { tokens: number }).tokens, 10 + 1010);
    const q = file(jsonl({ type: "session" }, { type: "message", message: { role: "user", content: "go" } }));
    assert.equal(readTailFill(q, readFileSync(q).length, "pi"), null);
  });

  test("the reader re-reads only when the file moved, and says nothing for a file it may not read", () => {
    const p = file(jsonl(piReply(10)));
    let asked = 0;
    const reader = new WorkerContextReader((w) => {
      asked++;
      return w.id === "local" ? { file: p, format: "pi" } : w.id === "gone" ? { file: join(root, "missing.jsonl"), format: "pi" } : null;
    });
    const w = { id: "local", name: "x", status: "running", working: true } as WorkerInfo;
    const at = 1_750_000_000; // whole seconds: utimes can set it back exactly
    utimesSync(p, at, at);
    assert.equal((reader.fill(w) as { tokens: number }).tokens, 1010 + 10);
    // Same mtime and size: the cached answer, even though the bytes differ — the gate is real.
    writeFileSync(p, readFileSync(p, "utf8").replace('"input":10', '"input":20'));
    utimesSync(p, at, at);
    assert.equal((reader.fill(w) as { tokens: number }).tokens, 1010 + 10, "unmoved: not read again");
    appendFileSync(p, jsonl(piReply(30)));
    assert.equal((reader.fill(w) as { tokens: number }).tokens, 30 + 1010, "a moved file is read again");
    assert.equal(reader.fill({ ...w, id: "remote" }), undefined, "no local file: nothing, never 0");
    assert.equal(reader.fill({ ...w, id: "gone" }), undefined);
    assert.ok(asked > 0);
  });
});

describe("withSpawnVariant", () => {
  test("adds the spawn model's variant to an id that names none; never changes the id", () => {
    assert.equal(withSpawnVariant("claude-opus-5-5", "opus[1m]"), "claude-opus-5-5[1m]");
    assert.equal(withSpawnVariant("claude-opus-5-5", "claude-opus-5-5[1m]"), "claude-opus-5-5[1m]");
    assert.equal(withSpawnVariant("claude-opus-5-5", "opus"), "claude-opus-5-5", "no variant spawned: none added");
    assert.equal(withSpawnVariant("claude-opus-5-5[1m]", "opus[1m]"), "claude-opus-5-5[1m]", "never twice");
    assert.equal(withSpawnVariant("claude-haiku-4-5", undefined), "claude-haiku-4-5");
  });
});

describe("withWorkerContext", () => {
  const resolve = (ref: string) => (ref === "zai/glm-5.3" ? 128_000 : ref === "zai/glm-5.1" ? 64_000 : null);

  test("stamps the window and the fill; the reply's own model names a pi window", () => {
    const pi = file(jsonl(piReply(10)));
    const cc = file(jsonl(ccReply("a", 1)));
    const reader = new WorkerContextReader((w) => (w.id === "pi" ? { file: pi, format: "pi" } : w.id === "cc" ? { file: cc, format: "claude" } : null));
    const base = { name: "x", status: "running" as const, working: true };
    const [p, c, none, kept] = withWorkerContext([
      { ...base, id: "pi", backend: "pi", model: "zai/glm-5.1" },
      { ...base, id: "cc", backend: "claude-code", model: "claude-opus-5-5" },
      { ...base, id: "none", backend: "pi", model: "zai/glm-5.3" },
      { ...base, id: "kept", backend: "pi", context: "compacted" as const },
    ], reader, resolve, (id) => (id === "cc" ? "claude-opus-5-5[1m]" : undefined));
    assert.equal(p!.contextWindow, 64_000, "its spawn model's window");
    assert.deepEqual(p!.context, { tokens: 1010 + 10, window: 128_000 }, "the reply ran on glm-5.3");
    assert.equal(c!.contextWindow, 1_000_000, "the [1m] spawn model, not the row's bare id");
    assert.deepEqual(c!.context, { tokens: 1 + 3200, window: 1_000_000 });
    assert.equal(none!.contextWindow, 128_000);
    assert.ok(!("context" in none!), "unknown is absent, never 0");
    assert.equal(kept!.context, "compacted", "a restored worker's summary stands");
  });

  test("a compacted transcript sends 'compacted' explicitly", () => {
    const f = file(jsonl(ccReply("a", 1), ccCompact));
    const reader = new WorkerContextReader(() => ({ file: f, format: "claude" }));
    const [w] = withWorkerContext([{ id: "cc", name: "x", status: "waiting", working: false, backend: "claude-code", model: "opus[1m]" }], reader, resolve);
    assert.equal(w!.context, "compacted");
    assert.equal(w!.contextWindow, 1_000_000);
  });
});

describe("the watch tally", () => {
  test("pi: snapshot follows the active branch; appends move it on; a compaction is said", () => {
    const tally = contextTally("pi", resolve);
    function resolve(ref: string) {
      return ref === "zai/glm-5.3" ? 128_000 : null;
    }
    const a = { ...piReply(10), id: "a", parentId: null };
    const b = { ...piReply(20), id: "b", parentId: "a" };
    const off = { ...piReply(90), id: "off", parentId: "a" };
    const leaf = { type: "custom", id: "l", parentId: "b", customType: "x" };
    // The file's last reply is on an abandoned branch; the active leaf is under b.
    assert.deepEqual(tally(jsonl({ type: "session", id: "s" }, a, off, b, leaf), "snapshot"), { tokens: 20 + 1010, window: 128_000 });
    assert.equal(tally(jsonl({ ...piCompaction, parentId: "l" }), "append"), "compacted");
    assert.equal(tally(jsonl({ type: "custom", id: "z" }), "append"), "compacted", "stays compacted until a reply");
    assert.deepEqual(tally(jsonl({ ...piReply(5), parentId: "c" }), "append"), { tokens: 5 + 1010, window: 128_000 });
    assert.equal(tally(jsonl({ type: "session", id: "s" }), "snapshot"), null, "a snapshot starts over: no reply yet");
  });

  test("claude: no window from the file; the client supplies the worker's", () => {
    const tally = contextTally("claude", () => 999);
    assert.equal(tally(jsonl({ type: "user", message: { role: "user", content: "go" } }), "snapshot"), null);
    assert.deepEqual(tally(jsonl(ccReply("a", 1)), "append"), { tokens: 3201, window: null });
    assert.equal(tally(jsonl(ccCompact), "append"), "compacted");
  });
});
