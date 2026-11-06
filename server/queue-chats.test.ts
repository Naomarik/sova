// Run: pnpm test server/queue-chats.test.ts
// The merge queue's own chats (its thread, each reviewer) are marked by the Sova profile they were started on,
// read from the file alone, and every server list and act leaves them out: Needs you, the push/decision
// eligibility, the quiet-team signal, the Overseer's and project overseers' session lists, session_list/
// session_send, mesh links, auto-titles, readiness and Clean Up. A chat that merely carries the same title,
// or a user profile with the same id, is ordinary.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

const agentDir = mkdtempSync(join(tmpdir(), "sova-queue-chats-"));
process.env.PI_CODING_AGENT_DIR = agentDir;
const sessionsDir = join(agentDir, "sessions", "--tmp-queue-chats--");
const liveDir = join(agentDir, "sessions", "live");
mkdirSync(sessionsDir, { recursive: true });
mkdirSync(liveDir, { recursive: true });
after(() => rmSync(agentDir, { recursive: true, force: true }));

const { getSessionSummary, cleanupSessions, archiveSession, fullSummaries } = await import("./sessions-index");
const { getAgentsInsight, getSessionInsight } = await import("./insights");
const { canonicalPath } = await import("./paths");
const { sessionItems } = await import("./attention");
const { exclusionReason, quietTeam } = await import("./attention-signals");
const { writableRefusal, hiddenFromProfiles, QUEUE_CHAT_REFUSAL } = await import("./session-guards");
const { configureRefusal } = await import("./sessions-configure");
const { queueChatRole } = await import("../shared/merge-queue");
const { addWebSession } = await import("./web-sessions");

const NOW = "2026-11-03T10:00:00.000Z";
function session(name: string, profile: Record<string, unknown> | null, title = "Review · feat/x · abc1234"): string {
  const path = join(sessionsDir, `2026-11-03T00-00-00-000Z_${name}.jsonl`);
  const lines = [
    { type: "session", version: 3, id: name, timestamp: NOW, cwd: "/tmp/proj" },
    ...(profile ? [{ type: "custom", customType: "sova-profile", id: "p1", parentId: null, data: { v: 1, profile } }] : []),
    { type: "message", id: "u1", parentId: profile ? "p1" : null, message: { role: "user", content: "Review the branch." } },
    { type: "session_info", id: "t1", parentId: "u1", name: title },
  ];
  writeFileSync(path, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  const old = new Date(Date.parse(NOW) - 90 * 86_400_000);
  utimesSync(path, old, old);
  return canonicalPath(path);
}
const sova = (id: string) => ({ id, label: id, icon: "branch", source: "sova" });
/** A live record for `path`: a TUI's, as the Agents board reads it. */
function live(name: string, path: string): string {
  const file = join(liveDir, `p${process.pid}-${name}.json`);
  writeFileSync(file, JSON.stringify({ heartbeat: Date.now(), session: { sessionFile: path, pid: process.pid, mode: "tui", status: "idle" } }));
  return file;
}

test("queueChatRole: Sova's merge-thread and merge-reviewer profiles only, never by title or a user profile", () => {
  assert.equal(queueChatRole({ id: "merge-thread", source: "sova" }), "thread");
  assert.equal(queueChatRole({ id: "merge-reviewer", source: "sova" }), "reviewer");
  assert.equal(queueChatRole({ id: "merge-reviewer", builtin: true }), "reviewer", "an older entry's builtin reads as sova");
  assert.equal(queueChatRole({ id: "merge-reviewer", source: "user" }), undefined);
  assert.equal(queueChatRole({ id: "merge-reviewer", source: "project" }), undefined);
  assert.equal(queueChatRole({ id: "reviewer", source: "sova" }), undefined);
  assert.equal(queueChatRole(undefined), undefined);
});

test("SessionSummary.queueChat comes from the file's own profile entry", async () => {
  assert.deepEqual((await getSessionSummary(session("thread", sova("merge-thread"))))?.queueChat, { role: "thread" });
  assert.deepEqual((await getSessionSummary(session("rev", sova("merge-reviewer"))))?.queueChat, { role: "reviewer" });
  assert.equal((await getSessionSummary(session("titled", null)))?.queueChat, undefined, "a title alone marks nothing");
  assert.equal((await getSessionSummary(session("userprof", { ...sova("merge-reviewer"), source: "user" })))?.queueChat, undefined);
});

test("every server list and act leaves a queue chat out; the same chat without the mark is in", async () => {
  const marked = (await getSessionSummary(session("rev2", sova("merge-reviewer"))))!;
  const plain = { ...marked, queueChat: undefined };
  const row = (s: typeof marked) => ({ ...s, live: null, archived: false, origin: "web" as const, busy: false, activity: { state: "needs-input" as const } });
  // Needs you: an ordinary chat waiting on input is an item; the queue chat never is.
  const att = (s: typeof marked) => ({ summary: row(s), dialogs: [], failedWorkers: 0 }) as never;
  assert.ok(sessionItems(att(plain), Date.parse(NOW)).length > 0, "the control is a Needs you item");
  assert.deepEqual(sessionItems(att(marked), Date.parse(NOW)), []);
  // Push/decision eligibility and the quiet-team signal.
  const settings = { attention: { enabled: true } } as never;
  assert.equal(exclusionReason(row(marked), settings, true), "merge queue chat");
  assert.equal(quietTeam(row(marked), [], new Map(), { at: Date.parse(NOW), stopReason: "stop" }, Date.parse(NOW)), null);
  // The Overseer's acts and session_send, session_list (hiddenFromProfiles), the configure route.
  assert.equal(writableRefusal(row(marked)), QUEUE_CHAT_REFUSAL);
  assert.equal(writableRefusal(row(plain)), null);
  assert.equal(hiddenFromProfiles(row(marked)), true);
  assert.equal(hiddenFromProfiles(row(plain)), false);
  assert.ok(configureRefusal(row(marked), false, 0));
});

test("the Agents board leaves a queue chat out, read from its file when no listing has cached it yet", async () => {
  // Neither file has been summarized: both are cache misses here.
  const rev = session("board-rev", sova("merge-reviewer"));
  const plain = session("board-plain", null);
  const records = [live("rev", rev), live("plain", plain)];
  try {
    const onBoard = (await getAgentsInsight()).sessions.map((s) => s.path);
    assert.ok(onBoard.includes(plain), `the control is on the board: ${onBoard}`);
    assert.ok(!onBoard.includes(rev), `the queue chat is not: ${onBoard}`);
  } finally {
    for (const f of records) rmSync(f);
  }
});

test("an Agents poll builds no full summary, at 2 live records or at 20", async () => {
  const fullSummariesOfAPoll = async (n: number) => {
    const records = Array.from({ length: n }, (_, i) => live(`poll${i}`, session(`poll${i}`, i ? null : sova("merge-thread"))));
    try {
      const before = fullSummaries();
      const { sessions } = await getAgentsInsight();
      return { rows: sessions.length, fullSummaries: fullSummaries() - before };
    } finally {
      for (const f of records) rmSync(f);
    }
  };
  assert.deepEqual(await fullSummariesOfAPoll(2), { rows: 1, fullSummaries: 0 });
  assert.deepEqual(await fullSummariesOfAPoll(20), { rows: 19, fullSummaries: 0 });
});

test("Clean Up never sweeps a queue chat by age or as a husk, and refuses it by path; the History's clear may", async () => {
  const kept = session("old-rev", sova("merge-reviewer"));
  session("old-plain", null, "An old chat");
  const dry = await cleanupSessions({ mode: "age", minAgeDays: 30, dryRun: true });
  assert.ok(dry.deletedIds.includes("old-plain"), `the control is swept: ${dry.deletedIds}`);
  assert.ok(!dry.deletedIds.includes("old-rev"), `the queue chat is kept: ${dry.deletedIds}`);
  addWebSession("old-rev");
  assert.equal((await archiveSession(kept, true)).ok, true);
  const byPath = await cleanupSessions({ mode: "paths", paths: [kept], dryRun: true });
  assert.match(JSON.stringify(byPath.refused ?? []), /merge queue's own chats/);
  assert.deepEqual(byPath.deletedIds, []);
  const cleared = await cleanupSessions({ mode: "paths", paths: [kept], dryRun: true }, { queueChats: true });
  assert.deepEqual(cleared.refused ?? [], [], JSON.stringify(cleared));
  assert.deepEqual(cleared.deletedIds, ["old-rev"]);
});

test("a queue chat's Worktrees section leaves out the trees it created itself (its conflicts' scratch copies); an ordinary chat's lists them", async () => {
  const made = join(agentDir, "wt", "proj-resolve-mq_1");
  const attached = join(agentDir, "wt", "proj-attached");
  const withTrees = (name: string, profile: Record<string, unknown> | null): string => {
    const path = session(name, profile);
    const tree = (p: string, how: string) => ({ path: p, branch: `feat/${how}`, base: "m", status: "active", session: name, how, at: 1 });
    const entry = { type: "custom", customType: "worktrees", id: "w1", parentId: "t1", data: { version: 1, trees: [tree(made, "created"), tree(attached, "attached")] } };
    writeFileSync(path, `${JSON.stringify(entry)}\n`, { flag: "a" });
    return path;
  };
  const rows = async (path: string) => ((await getSessionInsight(path)).worktrees ?? []).map((w) => w.path);
  assert.deepEqual(await rows(withTrees("plain-trees", null)), [made, attached], "the control lists both");
  assert.deepEqual(await rows(withTrees("thread-trees", sova("merge-thread"))), [attached], "the thread's own scratch copy is gone; one it only attached stays");
});
