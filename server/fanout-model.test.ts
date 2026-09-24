// Run: npx tsx --test server/fanout-model.test.ts
// Gate: a fanout member's session FILE must record the model the dialog chose for it — the whole
// point of a fanout is N models answering one prompt, and a member that runs the server default
// instead is the P0 this suite pins. The bug was a memory/disk divergence (fresh() appended the
// model_change AFTER hand-writing the header, and the SDK's _persist drops appends to a file it
// has not flushed while the session has no assistant message), so every assertion here reads
// FILE BYTES. A check on SessionManager.getEntries() passes today — the manager holds the entry
// in memory while the member's file does not — and would reinstate the bug with the suite green.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

const agentDir = mkdtempSync(join(tmpdir(), "sova-fanout-model-"));
process.env.PI_CODING_AGENT_DIR = agentDir;
const memberCwd = mkdtempSync(join(tmpdir(), "sova-fanout-model-cwd-"));
after(() => {
  rmSync(agentDir, { recursive: true, force: true });
  rmSync(memberCwd, { recursive: true, force: true });
});

const { planMembers, realFanoutDeps } = await import("./fanout");

/** Parse a session file from disk — the suite's only source of truth. */
function fileEntries(path: string): Record<string, unknown>[] {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

/** Every model_change in the file, as the [provider, modelId] pair the dialog chose between. */
const modelChanges = (entries: Record<string, unknown>[]): [string, string][] =>
  entries.filter((e) => e.type === "model_change").map((e) => [e.provider as string, e.modelId as string]);

test("fresh() writes each member's chosen model into its file — the pair, not just some model_change", async () => {
  const planned = planMembers([
    { ref: "deepseek/deepseek-flash", count: 1 },
    { ref: "zai/glm-5.3", count: 1 },
  ]);
  assert.equal(planned.length, 2, "one planned member per ref");
  const deepseek = planned[0]!;
  const zai = planned[1]!;
  const paths = [await realFanoutDeps.fresh(memberCwd, deepseek), await realFanoutDeps.fresh(memberCwd, zai)];
  for (const [path, member] of [
    [paths[0]!, deepseek] as const,
    [paths[1]!, zai] as const,
  ]) {
    const entries = fileEntries(path);
    assert.equal(entries[0]?.type, "session", "line 1 is the header");
    // The full pair, exactly once: a member recording the server default (the shipped bug) or
    // another member's model fails here as loudly as recording nothing.
    assert.deepEqual(
      modelChanges(entries),
      [[member.provider, member.modelId]],
      `${path} must record the requested provider AND modelId, and nothing else`,
    );
  }
});

test("fork() still records its own member model beside the copied branch", async () => {
  // The source's assistant names a DIFFERENT provider than the member, so the source's own model
  // leaking into the member file cannot satisfy the assertion by accident.
  const sourceDir = join(agentDir, "sessions", "--tmp-fanout-model-src--");
  mkdirSync(sourceDir, { recursive: true });
  const sourcePath = join(sourceDir, "2026-09-22T00-00-00-000Z_01a0-fanoutsrc.jsonl");
  const LEAF = "entry-assistant-1";
  writeFileSync(
    sourcePath,
    [
      { type: "session", version: 3, id: "01a0-fanoutsrc", timestamp: "2026-09-22T00:00:00.000Z", cwd: memberCwd },
      { type: "message", id: "entry-user-1", parentId: null, timestamp: "2026-09-22T00:00:01.000Z", message: { role: "user", content: [{ type: "text", text: "hello" }] } },
      { type: "message", id: LEAF, parentId: "entry-user-1", timestamp: "2026-09-22T00:00:02.000Z", message: { role: "assistant", content: [{ type: "text", text: "hi" }], provider: "anthropic", model: "opus" } },
    ]
      .map((l) => JSON.stringify(l))
      .join("\n") + "\n",
  );

  const member = planMembers([{ ref: "zai/glm-5.3", count: 1 }])[0]!;
  const memberPath = await realFanoutDeps.fork(sourcePath, LEAF, member);
  const entries = fileEntries(memberPath);
  // The copied branch must still be there (the fork is not just a model stub)...
  assert.ok(entries.some((e) => e.id === LEAF), "the branch was copied with entry ids intact");
  // ...and the member's own model is the only model_change in it.
  assert.deepEqual(modelChanges(entries), [[member.provider, member.modelId]]);
});
