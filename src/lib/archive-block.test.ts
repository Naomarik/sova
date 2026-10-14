// Run: npx tsx --test src/lib/archive-block.test.ts
// Which rows may be archived, and the words for the ones that may not.
import assert from "node:assert/strict";
import { test } from "node:test";
import { archiveBlockReason, type ArchivableSession } from "./archive-block";

let n = 0;
const row = (over: Partial<ArchivableSession> = {}): ArchivableSession => ({
  path: `/s/${++n}.jsonl`,
  id: `id-${n}`,
  title: `Session ${n}`,
  archived: false,
  origin: "web",
  busy: false,
  live: null,
  ...over,
});

test("archiveBlockReason: the four blocks, and never for an archived row", () => {
  assert.equal(archiveBlockReason(row()), null);
  assert.equal(archiveBlockReason(row({ live: { pid: 7, status: "idle" } })), "open in a TUI");
  assert.equal(archiveBlockReason(row({ origin: "external" })), "not started in Sova");
  assert.equal(archiveBlockReason(row({ busy: true })), "mid-turn");
  assert.equal(archiveBlockReason(row({ workers: { working: 2, total: 3 } })), "with subagents working");
  assert.equal(archiveBlockReason(row({ workers: { working: 1, total: 1 } })), "with subagents working");
  assert.equal(archiveBlockReason(row({ live: { pid: 7, status: "idle", workers: { working: 1, total: 1 } } })), "open in a TUI");
  // Every block is about ARCHIVING. Unarchiving a TUI-live, busy, external row is fine.
  for (const over of [{ live: { pid: 7, status: "idle" } }, { origin: "external" as const }, { busy: true }, { workers: { working: 1, total: 1 } }]) {
    assert.equal(archiveBlockReason(row({ ...over, archived: true })), null);
  }
});
