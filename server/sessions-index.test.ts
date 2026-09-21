// Run: npx tsx --test server/sessions-index.test.ts
// Uses a throwaway PI_CODING_AGENT_DIR in the OS temp dir; ~/.pi is never read or written.
//
// The paths mode of Archive cleanup (spec/02-session-list.md §2 "Deleting one session"): one
// archived session deleted for good, and everything that must be refused instead. The bulk modes'
// own rules are covered elsewhere — group pruning in session-groups-index.test.ts, husk detection
// in cleanup.test.ts. The route's input validation is covered by the pieces it calls
// (resolveSessionPath); these tests call cleanupSessions directly, which re-validates the same way.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

const agentDir = mkdtempSync(join(tmpdir(), "pi-web-sessions-index-"));
process.env.PI_CODING_AGENT_DIR = agentDir; // before the modules below compute their paths
const sessionsDir = join(agentDir, "sessions", "--tmp-sessions-index--");
const liveDir = join(agentDir, "sessions", "live");
mkdirSync(sessionsDir, { recursive: true });
mkdirSync(liveDir, { recursive: true });

const { cleanupSessions } = await import("./sessions-index");
const { isArchived, setArchived } = await import("./archived-sessions");
const { canonicalPath } = await import("./paths");

// A live record's pid must be alive for readLive to see it, like archived-sessions.test.ts fakes it.
const sleeper = spawn("sleep", ["60"], { stdio: "ignore" });
after(() => {
  sleeper.kill();
  rmSync(agentDir, { recursive: true, force: true });
});

const ID_A = "01234567-89ab-7cde-8f01-234567890abc";
const ID_B = "01234567-89ab-7cde-8f01-234567890abd";
const ID_C = "01234567-89ab-7cde-8f01-234567890abe";

const header = (id: string) =>
  JSON.stringify({ type: "session", version: 3, id, timestamp: "2026-09-21T00:00:00.000Z", cwd: "/tmp" });
const userMessage = (text: string) =>
  JSON.stringify({ type: "message", id: "m1", parentId: null, timestamp: "2026-09-21T00:00:01.000Z", message: { role: "user", content: text } });

/** A session file with a user message, aged past the just-written window so the bulk rules let it go. */
function session(id: string, title: string): string {
  const path = join(sessionsDir, `2026-09-21T00-00-00-000Z_${id}.jsonl`);
  writeFileSync(path, `${[header(id), userMessage(title)].join("\n")}\n`);
  const old = new Date(Date.now() - 40 * 86_400_000);
  utimesSync(path, old, old);
  return canonicalPath(path);
}

test("paths: deleting an archived session removes exactly that file, clears the mark, leaves neighbours", async () => {
  const a = session(ID_A, "delete me");
  const b = session(ID_B, "keep me");
  const c = session(ID_C, "never archived");
  setArchived(ID_A, true);
  setArchived(ID_B, true);

  const r = await cleanupSessions({ mode: "paths", paths: [a], dryRun: false });

  assert.deepEqual(r, {
    deletedCount: 1,
    deletedIds: [ID_A],
    skipped: { live: 0, busy: 0, recent: 0, failed: 0 },
    refused: [],
  });
  assert.ok(!existsSync(a), "the named file is gone");
  assert.ok(existsSync(b), "an archived neighbour stays");
  assert.ok(existsSync(c), "an unarchived neighbour stays");
  assert.equal(isArchived(ID_A), false, "the deleted session's archive mark is cleared");
  assert.equal(isArchived(ID_B), true, "the neighbour's mark stays");
});

test("paths: an unarchived session is refused with the archive-first reason, not deleted", async () => {
  const c = session(ID_C, "never archived");

  const r = await cleanupSessions({ mode: "paths", paths: [c], dryRun: false });

  assert.deepEqual(r, {
    deletedCount: 0,
    deletedIds: [],
    skipped: { live: 0, busy: 0, recent: 0, failed: 0 },
    refused: [{ path: c, reason: "Not archived — archive it first, then delete it." }],
  });
  assert.ok(existsSync(c));
});

test("paths: a live session is skipped as live, not deleted (archived before a TUI opened it)", async () => {
  const a = session(ID_A, "live in a TUI");
  setArchived(ID_A, true);
  const rec = join(liveDir, "p-test.json");
  writeFileSync(rec, JSON.stringify({ session: { pid: sleeper.pid, sessionFile: a, mode: "tui" }, presence: { status: "idle" } }));
  try {
    const r = await cleanupSessions({ mode: "paths", paths: [a], dryRun: false });
    assert.equal(r.deletedCount, 0);
    assert.deepEqual(r.deletedIds, []);
    assert.deepEqual(r.skipped, { live: 1, busy: 0, recent: 0, failed: 0 });
    assert.deepEqual(r.refused, []);
    assert.ok(existsSync(a));
  } finally {
    rmSync(rec);
  }
});

test("paths: a path outside the sessions dir is refused, not deleted", async () => {
  const outside = join(tmpdir(), `pi-web-sessions-index-outside-${process.pid}.jsonl`);
  writeFileSync(outside, `${header(ID_A)}\n`);
  try {
    const r = await cleanupSessions({ mode: "paths", paths: [outside], dryRun: false });
    assert.equal(r.deletedCount, 0);
    assert.deepEqual(r.deletedIds, []);
    const [refusal] = r.refused ?? [];
    assert.ok(refusal, "one refusal, saying the rule");
    assert.equal(refusal.path, outside);
    assert.match(refusal.reason, /not a session file/i);
    assert.ok(existsSync(outside));
  } finally {
    rmSync(outside, { force: true });
  }
});

test("paths: dryRun reports the candidate without deleting anything", async () => {
  const b = session(ID_B, "dry run me");
  setArchived(ID_B, true);

  const r = await cleanupSessions({ mode: "paths", paths: [b], dryRun: true });

  assert.deepEqual(r, {
    deletedCount: 0,
    deletedIds: [ID_B],
    skipped: { live: 0, busy: 0, recent: 0, failed: 0 },
    refused: [],
  });
  assert.ok(existsSync(b), "a dry run deletes nothing");
  assert.equal(isArchived(ID_B), true, "and clears no mark either");
});

test("paths: a just-written session is skipped as recent, not deleted", async () => {
  const a = session(ID_A, "just written");
  setArchived(ID_A, true);
  utimesSync(a, new Date(), new Date());

  const r = await cleanupSessions({ mode: "paths", paths: [a], dryRun: false });

  assert.equal(r.deletedCount, 0);
  assert.deepEqual(r.skipped, { live: 0, busy: 0, recent: 1, failed: 0 });
  assert.ok(existsSync(a));
});

test("paths: a file whose header doesn't parse is refused, not deleted — even archived", async () => {
  const path = join(sessionsDir, `2026-09-21T00-00-00-000Z_${ID_A}.jsonl`);
  writeFileSync(path, '{"type":"sessi'); // truncated: no complete line anywhere
  const old = new Date(Date.now() - 40 * 86_400_000);
  utimesSync(path, old, old);
  const a = canonicalPath(path);
  setArchived(ID_A, true);

  const r = await cleanupSessions({ mode: "paths", paths: [a], dryRun: false });

  assert.equal(r.deletedCount, 0);
  assert.deepEqual(r.deletedIds, []);
  const [refusal] = r.refused ?? [];
  assert.ok(refusal, "one refusal, saying why");
  assert.equal(refusal.path, a);
  assert.match(refusal.reason, /couldn't read/i);
  assert.ok(existsSync(a), "never delete what can't be read as a session");
});

test("paths: a session file that is already gone is refused, not failed", async () => {
  const gone = join(sessionsDir, "2026-09-21T00-00-00-000Z_01234567-89ab-7cde-8f01-234567890abf.jsonl");

  const r = await cleanupSessions({ mode: "paths", paths: [gone], dryRun: false });

  assert.equal(r.deletedCount, 0);
  assert.deepEqual(r.skipped, { live: 0, busy: 0, recent: 0, failed: 0 });
  const [refusal] = r.refused ?? [];
  assert.ok(refusal, "one refusal, saying why");
  assert.match(refusal.reason, /not found/i);
});