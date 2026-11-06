// Run: pnpm test -- server/sessions-shell-only.test.ts. A chat that holds only commands run from shell mode
// (§chat.shell-mode/card) is no empty husk: it is listed (still "Untitled": a command never titles a chat),
// it opens with its command's row, and the empty-husk cleanup keeps it, `!` and `!!` alike, while a
// header-only stub is still left out and deleted. In-process, in a throwaway agent dir.
import assert from "node:assert/strict";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import type { SessionSummary, TranscriptItem } from "../shared/protocol";

const agentDir = mkdtempSync(join(tmpdir(), "sova-shell-only-"));
process.env.PI_CODING_AGENT_DIR = agentDir;
const sessionsDir = join(agentDir, "sessions", "--tmp-shell-only--");
mkdirSync(sessionsDir, { recursive: true });
mkdirSync(join(agentDir, "sessions", "live"), { recursive: true });

const { testApp } = await import("./mesh/app-test-fixtures");
const app = await testApp();
const { addWebSession } = await import("./web-sessions");
const { canonicalPath } = await import("./paths");
const { archiveSession, cleanupSessions, isZeroInput } = await import("./sessions-index");
const { setChatRouter } = await import("./chat-handle");

after(() => {
  setChatRouter(null);
  rmSync(agentDir, { recursive: true, force: true });
});

let n = 0;
/** A web session file with these entries after its header, last written an hour ago (past the
    just-written guard): its id and path. */
function sessionWith(entries: Record<string, unknown>[]): { id: string; path: string } {
  const id = `0000000${++n}-aaaa-7bbb-8ccc-0123456789ab`;
  const path = join(sessionsDir, `2026-11-06T00-00-0${n}-000Z_${id}.jsonl`);
  const lines = [{ type: "session", version: 3, id, timestamp: "2026-11-06T00:00:00.000Z", cwd: "/tmp" }, ...entries];
  writeFileSync(path, `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`);
  addWebSession(id);
  const then = new Date(Date.now() - 3_600_000);
  utimesSync(path, then, then);
  return { id, path: canonicalPath(path) };
}
const bash = (o: Record<string, unknown> = {}) => ({
  type: "message",
  id: "b1",
  parentId: null,
  timestamp: "2026-11-06T00:00:01.000Z",
  message: { role: "bashExecution", command: "echo hi", output: "hi\n", exitCode: 0, cancelled: false, truncated: false, timestamp: 1, ...o },
});

test("a chat whose only entries are commands is listed, opens with its row, and survives the empty-husk cleanup", async () => {
  const stub = sessionWith([]);
  const shared = sessionWith([bash()]);
  const kept = sessionWith([bash({ command: "env", excludeFromContext: true })]);
  for (const s of [shared, kept]) assert.equal(await isZeroInput(s.path, 4096), false, "a command is something written in it");
  assert.equal(await isZeroInput(stub.path, 4096), true, "the control: a header-only file is a husk");

  const listed = (await (await app.request("/api/sessions")).json()) as SessionSummary[];
  const row = (id: string) => listed.find((s) => s.id === id);
  assert.equal(row(stub.id), undefined, "a stub is still left out");
  for (const s of [shared, kept]) {
    assert.ok(row(s.id), "listed, so a reload finds it");
    assert.equal(row(s.id)!.title, "Untitled", "a command never titles a chat");
  }

  const items = (await (await app.request(`/api/transcript?path=${encodeURIComponent(shared.path)}&wire=2`)).json()) as { items: TranscriptItem[] };
  assert.deepEqual(items.items.map((i) => [i.kind, i.shell?.command]), [["shell", "echo hi"]], "it opens with its command's card");

  const r = await cleanupSessions({ mode: "husks", dryRun: false });
  assert.deepEqual(r.deletedIds, [stub.id], "only the stub goes");
  assert.equal(existsSync(stub.path), false);
  for (const s of [shared, kept]) assert.ok(existsSync(s.path), "its commands are kept");
});

/** Chats this server holds, by path: whether a command runs in it, and what its close writes (a command
    it stopped, saved as its chat closes). */
function holdChats(chats: Map<string, { shell: boolean; onClose?: () => void }>): string[] {
  const closed: string[] = [];
  setChatRouter({
    ready: async () => {},
    get: (path) => (chats.has(path) ? ({ path, mirror: { running: false, shell: chats.get(path)!.shell, dialogs: [] } } as never) : undefined),
    all: () => [],
    acquire: async () => {
      throw new Error("not in this test");
    },
    close: async (path) => {
      closed.push(path);
      chats.get(path)?.onClose?.();
      return chats.has(path);
    },
  });
  return closed;
}

test("a chat whose only content is a command still running is no husk: the cleanup keeps it, and archiving it keeps the command its close saves", async () => {
  const running = sessionWith([]);
  const racing = sessionWith([]);
  const stub = sessionWith([]);
  const closeSaves = () => appendFileSync(racing.path, `${JSON.stringify(bash({ command: "sleep 60", output: "", exitCode: undefined, cancelled: true }))}\n`);
  const closed = holdChats(new Map([
    [running.path, { shell: true }],
    // The server hasn't heard of its command yet (the mirror lags), but its close saves one.
    [racing.path, { shell: false, onClose: closeSaves }],
  ]));
  const r = await cleanupSessions({ mode: "husks", dryRun: false });
  assert.ok(!r.deletedIds.includes(running.id), "a running command keeps its chat");
  assert.ok(existsSync(running.path));
  assert.ok(!r.deletedIds.includes(racing.id), "nor is one whose close saved a command deleted");
  assert.ok(existsSync(racing.path));
  assert.ok(r.deletedIds.includes(stub.id), "the control: a stub nobody holds still goes");

  // Archive: the one whose close saves a command is archived, not deleted, its command kept.
  const fresh = sessionWith([]);
  const saveOnClose = () => appendFileSync(fresh.path, `${JSON.stringify(bash({ command: "sleep 60", output: "", exitCode: undefined, cancelled: true }))}\n`);
  holdChats(new Map([[fresh.path, { shell: false, onClose: saveOnClose }]]));
  const a = await archiveSession(fresh.path, true);
  assert.ok(a.ok);
  assert.equal((a as { summary: { deleted?: boolean } }).summary.deleted, undefined, "archived, not deleted");
  assert.ok(existsSync(fresh.path));
  assert.match(readFileSync(fresh.path, "utf8"), /"bashExecution"/, "its command is kept");
  void closed;
});
