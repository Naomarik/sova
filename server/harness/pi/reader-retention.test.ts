// Run: pnpm test -- server/harness/pi/reader-retention.test.ts. The session list's two incremental scans
// (alignments, server/align-state.ts; tracked worktrees, server/merge-readiness.ts) keep a compact item per
// line for as long as the server runs. An item must not keep its whole source line alive: in Bun a regex
// capture is a view into the string it came from, so a kept `id` once pinned a whole 100 KB line, and
// the server held over a gigabyte of old lines. Bun only (it reads the engine's heap); skipped on Node.
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
const MB = 1024 * 1024;

/** A session holding both scans' markers, then LINES big tool results neither scan wants (each keeps
    only the line's place in the tree). */
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
  let parent = "a0";
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

  test("setup: a 50 MB session with both markers", () => {
    path = writeSession();
    size = statSync(path).size;
    assert.ok(size > LINES * LINE_BYTES * 0.95);
  });

  test("the alignment scan (align-state) keeps under 5 MB of a 50 MB session", async () => {
    const before = await retained();
    const scan = await readAlignScan(path, size, null);
    const grew = (await retained()) - before;
    assert.equal(scan.found, true);
    assert.equal(scan.entries?.length, LINES + 3);
    assert.ok(grew < 5 * MB, `the alignment scan kept ${(grew / MB).toFixed(1)} MB`);
  });

  test("the tracked-worktree scan (merge-readiness) keeps under 5 MB of a 50 MB session", async () => {
    const before = await retained();
    const { scan } = await readReadinessScan(path, size, null);
    const grew = (await retained()) - before;
    assert.equal(scan.found, true);
    assert.equal(scan.entries?.length, LINES + 3);
    assert.ok(grew < 5 * MB, `the tracked-worktree scan kept ${(grew / MB).toFixed(1)} MB`);
  });
});
