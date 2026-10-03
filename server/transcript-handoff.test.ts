// Run: npx tsx --test server/transcript-handoff.test.ts
// /compact-handoff's run rows (§chat.slash-commands/compact-handoff-row): one row per run id, the
// newest entry's status, and nothing for the note entry or the hidden note message.
import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeEntries } from "./transcript";

const T = "2026-10-03T12:00:00.000Z";
const run = (id: string, runId: string, data: Record<string, unknown>) => ({ type: "custom", id, timestamp: T, customType: "compact-handoff-run", data: { v: 1, id: runId, at: T, ...data } });

test("a running row: info, the run carried, the focus in its line", () => {
  const rows = normalizeEntries([run("e1", "r1", { status: "running", focus: "keep the API" })]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.kind, "info");
  assert.deepEqual(rows[0]!.handoffRun, { id: "r1", status: "running", focus: "keep the API" });
  assert.equal(rows[0]!.text, "Writing a handoff note: keep the API");
});

test("per run id only the newest entry renders, where it was appended; other runs keep theirs", () => {
  const rows = normalizeEntries([
    run("e1", "r1", { status: "running" }),
    run("e2", "r2", { status: "running" }),
    { type: "custom", id: "n1", customType: "compact-handoff", data: { v: 1, path: "/a/s.md", note: "N", at: T, leafId: null } },
    run("e3", "r1", { status: "saved", path: "/a/compact-handoffs/s.md" }),
    run("e4", "r2", { status: "failed", error: "the fork failed (429)" }),
  ]);
  assert.deepEqual(rows.map((r) => [r.id, r.handoffRun?.status, r.text]), [
    ["e3", "saved", "Handoff note saved: /a/compact-handoffs/s.md"],
    ["e4", "failed", "Handoff note failed: the fork failed (429)"],
  ]);
});

test("cancelled and interrupted read as such; an explain run with the same id is a different run", () => {
  const rows = normalizeEntries([
    run("e1", "x", { status: "cancelled" }),
    { type: "custom", id: "x1", customType: "explain-doc", data: { id: "x", topic: "t", summary: "", createdAt: T, parentSessionId: "s", status: "running" } },
    run("e2", "y", { status: "interrupted" }),
  ]);
  assert.deepEqual(rows.map((r) => (r.handoffRun ? r.text : r.report?.source)), ["Handoff cancelled", "explain-doc", "Handoff interrupted"]);
});

test("entries this version can't read render nothing, and the hidden note message stays hidden", () => {
  const rows = normalizeEntries([
    run("e1", "r", { status: "done" }),
    { type: "custom", id: "e2", customType: "compact-handoff-run", data: { v: 2, id: "r", status: "running", at: T } },
    { type: "custom_message", id: "m1", customType: "compact-handoff-note", display: false, content: "<handoff>N</handoff>" },
  ]);
  assert.deepEqual(rows, []);
});
