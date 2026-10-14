// Run: pnpm test -- server/harness/pi/reader-retention.test.ts. The session list's two incremental scans
// (alignments, server/align-state.ts; tracked worktrees, server/merge-readiness.ts) keep a compact item per
// line for as long as the server runs. An item must not keep its whole source line, or any big string
// read from it, alive: in Bun a regex capture or a slice is a view into the string it came from, so a
// kept `id` once pinned a whole 100 KB line (the server held over a gigabyte of old lines), and a kept
// reply tail its whole reply. Bun only (it reads the engine's heap); skipped on Node.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";

const agentDir = mkdtempSync(join(tmpdir(), "sova-reader-retention-"));
process.env.PI_CODING_AGENT_DIR = agentDir; // before the modules below compute their paths
after(() => rmSync(agentDir, { recursive: true, force: true }));

const { readAlignScan } = await import("../../align-state");
const { readReadinessScan } = await import("../../merge-readiness");

const isBun = typeof (globalThis as { Bun?: unknown }).Bun !== "undefined";
const LINES = 500;
const LINE_BYTES = 100 * 1024;
/** Assistant replies the worktree scan keeps a tail of, each LINE_BYTES of text. */
const REPLIES = 200;
/** One user prompt both scans parse (and keep only a mark of). */
const PROMPT_BYTES = 8 * 1024 * 1024;
const ENTRIES = 3 + 1 + REPLIES + LINES;
const MB = 1024 * 1024;

/** A session holding both scans' markers, a big user prompt both scans parse, REPLIES big assistant
    replies the worktree scan keeps a tail of, then LINES big tool results neither scan wants (each
    keeps only the line's place in the tree). */
function writeSession(): string {
  const path = join(agentDir, "big.jsonl");
  const ts = "2026-10-14T10:00:00.000Z";
  const out: string[] = [
    JSON.stringify({ type: "session", version: 3, id: "s0", timestamp: ts, cwd: "/tmp/retention" }),
    JSON.stringify({ type: "custom", id: "w0", parentId: null, timestamp: ts, customType: "worktrees", data: { worktrees: [] } }),
    JSON.stringify({
      type: "message",
      id: "a0",
      parentId: "w0",
      timestamp: ts,
      message: { role: "toolResult", toolCallId: "call-a0", toolName: "align", content: [{ type: "text", text: "ok" }], details: {}, isError: false, timestamp: 0 },
    }),
  ];
  out.push(
    JSON.stringify({ type: "message", id: "u0", parentId: "a0", timestamp: ts, message: { role: "user", content: [{ type: "text", text: "p".repeat(PROMPT_BYTES) }], timestamp: 0 } }),
  );
  let parent = "u0";
  for (let i = 0; i < REPLIES; i++) {
    const id = `r${i.toString(16).padStart(7, "0")}`;
    const text = `Reply ${i}. ` + "y".repeat(LINE_BYTES);
    out.push(JSON.stringify({ type: "message", id, parentId: parent, timestamp: ts, message: { role: "assistant", content: [{ type: "text", text }], stopReason: "stop", timestamp: 0 } }));
    parent = id;
  }
  for (let i = 0; i < LINES; i++) {
    const id = `b${i.toString(16).padStart(7, "0")}`;
    const head = { type: "message", id, parentId: parent, timestamp: ts };
    const message = { role: "toolResult", toolCallId: `call-${id}`, toolName: "bash", content: [{ type: "text", text: "" }], isError: false, timestamp: 0 };
    const empty = JSON.stringify({ ...head, message });
    message.content[0]!.text = "x".repeat(Math.max(0, LINE_BYTES - empty.length));
    out.push(JSON.stringify({ ...head, message }));
    parent = id;
  }
  writeFileSync(path, out.join("\n") + "\n");
  return path;
}

describe("the session list's scans keep compact items, never whole lines", { skip: isBun ? false : "reads Bun's heap (bun:jsc)" }, () => {
  // The engine's heap after a full collection; it counts a big string's characters (its extra memory) too.
  const retained = async (): Promise<number> => {
    const { heapStats } = (await import("bun:jsc" as string)) as { heapStats: () => { heapSize: number } };
    const bun = (globalThis as unknown as { Bun: { gc: (sync: boolean) => void } }).Bun;
    for (let i = 0; i < 5; i++) {
      bun.gc(true);
      await new Promise((r) => setTimeout(r, 10));
    }
    return heapStats().heapSize;
  };
  let path = "";
  let size = 0;

  test("setup: a 78 MB session with both markers, a big prompt and big replies", () => {
    path = writeSession();
    size = statSync(path).size;
    assert.ok(size > (LINES + REPLIES) * LINE_BYTES + PROMPT_BYTES);
  });

  test("the alignment scan (align-state) keeps under 5 MB of a 78 MB session", async () => {
    const before = await retained();
    const scan = await readAlignScan(path, size, null);
    const grew = (await retained()) - before;
    assert.equal(scan.found, true);
    assert.equal(scan.entries?.length, ENTRIES);
    assert.equal(scan.entries?.filter((e) => e.userPrompt).length, 1, "the prompt was parsed, not skipped");
    assert.ok(grew < 5 * MB, `the alignment scan kept ${(grew / MB).toFixed(1)} MB`);
  });

  test("the tracked-worktree scan (merge-readiness) keeps under 5 MB of a 78 MB session", async () => {
    const before = await retained();
    const { scan } = await readReadinessScan(path, size, null);
    const grew = (await retained()) - before;
    assert.equal(scan.found, true);
    assert.equal(scan.entries?.length, ENTRIES);
    assert.equal(scan.entries?.filter((e) => e.userPrompt).length, 1, "the prompt was parsed, not skipped");
    const replies = scan.entries?.filter((e) => e.reply) ?? [];
    assert.equal(replies.length, REPLIES, "every reply's tail is kept");
    assert.ok(replies.every((e) => e.reply!.text.length > 0 && e.reply!.text.length <= 1500), "a tail, never the whole reply");
    assert.ok(grew < 5 * MB, `the tracked-worktree scan kept ${(grew / MB).toFixed(1)} MB`);
  });
});
