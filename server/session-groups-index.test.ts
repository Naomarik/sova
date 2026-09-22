// Run: npx tsx --test server/session-groups-index.test.ts
// Uses a throwaway PI_CODING_AGENT_DIR in the OS temp dir; ~/.pi is never read or written.
//
// The wiring between the group store and the session index: what a summary carries, what a listing
// prunes, and what Archive cleanup does with an assignment. The store's own rules are covered by
// session-groups.test.ts; the routes' input validation is covered by the pieces they call
// (resolveSessionPath, assignSession) — the Hono handlers themselves are still untested.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

const agentDir = mkdtempSync(join(tmpdir(), "pi-web-groups-index-"));
process.env.PI_CODING_AGENT_DIR = agentDir; // before the modules below compute their paths
const sessionsDir = join(agentDir, "sessions", "--tmp-groups-index--");
mkdirSync(sessionsDir, { recursive: true });
mkdirSync(join(agentDir, "sessions", "live"), { recursive: true });

const { assignSession, createGroup, readAssignments, readGroups } = await import("./session-groups");
const { cleanupSessions, getSessionSummary, listSessions } = await import("./sessions-index");
const { canonicalPath } = await import("./paths");

after(() => rmSync(agentDir, { recursive: true, force: true }));

const ID_A = "01234567-89ab-7cde-8f01-234567890abc";
const ID_B = "01234567-89ab-7cde-8f01-234567890abd";
const ID_C = "01234567-89ab-7cde-8f01-234567890abe";
const ID_OLD = "01234567-89ab-7cde-8f01-234567890abf";

const header = (id: string) =>
  JSON.stringify({ type: "session", version: 3, id, timestamp: "2026-09-21T00:00:00.000Z", cwd: "/tmp" });
const userMessage = (text: string) =>
  JSON.stringify({ type: "message", id: "m1", parentId: null, timestamp: "2026-09-21T00:00:01.000Z", message: { role: "user", content: text } });

/** A session file with a user message (so it is listed, not a husk). */
function session(id: string, title: string): string {
  const path = join(sessionsDir, `2026-09-21T00-00-00-000Z_${id}.jsonl`);
  writeFileSync(path, `${[header(id), userMessage(title)].join("\n")}\n`);
  return canonicalPath(path);
}

/** A header-only husk: cleanup's business. */
function husk(id: string): string {
  const path = join(sessionsDir, `2026-09-21T00-00-00-000Z_${id}.jsonl`);
  writeFileSync(path, `${header(id)}\n`);
  return canonicalPath(path);
}

const grouped = () => {
  const r = createGroup("Favorites");
  assert.ok(r.ok);
  return r.group.id;
};

test("a listing carries groupId only for grouped rows, and KEEPS the assignment of a member whose file is gone", async () => {
  const group = grouped();
  const a = session(ID_A, "Grouped session");
  const b = session(ID_B, "Soon deleted outside pi-web");
  assignSession(ID_A, group);
  assignSession(ID_B, group);

  const listed = await listSessions();
  const byId = new Map(listed.map((s) => [s.id, s]));
  assert.equal(byId.get(ID_A)!.groupId, group);
  assert.equal(byId.get(ID_B)!.groupId, group, "both rows are grouped while both files exist");

  // Deleted by someone other than pi-web's cleanup. The assignment SURVIVES: the workspace's
  // "This session's file is gone" pane is that assignment rendered (spec 14-workspaces "Gone
  // from disk"), and a listing-pass prune would race the pane's own Remove From Group gesture —
  // the member would vanish silently instead of showing its state. Only Archive cleanup prunes,
  // and only the ids it deleted itself.
  unlinkSync(b);
  await listSessions();
  assert.deepEqual(readAssignments(), { [ID_A]: group, [ID_B]: group }, "the gone member's assignment survived the listing");
  const named = readGroups().find((g) => g.id === group)!;
  assert.ok((named.members ?? []).some((m) => m.id === ID_B), "so the group still names it and a pane can render");

  // And removal with no file on disk is exactly the assign gesture the ghost pane offers
  // (POST /api/session-groups/assign { id, groupId: null } — store level needs no file).
  assert.deepEqual(assignSession(ID_B, null), { ok: true });
  assert.deepEqual(readAssignments(), { [ID_A]: group }, "only the removed member's assignment went");

  // Ungrouped is an absent field, not null: what shared/protocol.ts promises.
  assignSession(ID_A, null);
  const cleared = (await listSessions()).find((s) => s.id === ID_A)!;
  assert.ok(!("groupId" in cleared));
  assert.equal((await getSessionSummary(a))!.groupId, undefined);
});

test("a summary flags an older session format (legacyFormat) and never a current one", async () => {
  // The fanout dialog pre-disables Create for an old-format source; the server computes the
  // flag so the client never compares version numbers itself. Absent = current, unreadable
  // head, or an older server — only `true` ever blocks a fork.
  const old = join(sessionsDir, `2026-09-21T00-00-00-000Z_${ID_OLD}.jsonl`);
  writeFileSync(old, `${[JSON.stringify({ type: "session", version: 2, id: ID_OLD, timestamp: "2026-09-21T00:00:00.000Z", cwd: "/tmp" }), userMessage("old format")].join("\n")}\n`);
  assert.equal((await getSessionSummary(canonicalPath(old)))?.legacyFormat, true);
  const current = await getSessionSummary(session(ID_A, "current format"));
  assert.ok(current && !("legacyFormat" in current), "absent when current — the same absence an older server sends");
});

test("cleanup prunes the ids it deleted, and a dry run changes nothing", async () => {
  const group = grouped();
  const path = husk(ID_C);
  assignSession(ID_C, group);
  // Old enough for the husk sweep to take it (a just-written file is skipped as "recent").
  const old = new Date(Date.now() - 40 * 86_400_000);
  utimesSync(path, old, old);

  const dry = await cleanupSessions({ mode: "husks", dryRun: true });
  assert.deepEqual(dry.deletedIds, [ID_C]);
  assert.deepEqual(readAssignments(), { [ID_C]: group }, "a dry run writes nothing");

  const real = await cleanupSessions({ mode: "husks", dryRun: false });
  assert.deepEqual(real.deletedIds, [ID_C]);
  assert.deepEqual(readAssignments(), {}, "the deleted session's assignment is gone");
});
