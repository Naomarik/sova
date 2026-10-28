// Run: pnpm test -- server/archive-reopen.test.ts. An archived chat reads only until it is unarchived
// (§chat.transcript/instant-open, "An archived chat"): nothing a tab, a script or a request does starts
// it, and nothing retries. The chat router is the real one over a fake driver whose processes never
// answer, so any start would show as a started unit; a throwaway PI_CODING_AGENT_DIR.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

const agentDir = mkdtempSync(join(tmpdir(), "sova-archive-reopen-"));
process.env.PI_CODING_AGENT_DIR = agentDir; // before the modules below compute their paths
const sessionsDir = join(agentDir, "sessions", "--tmp-archive-reopen--");
mkdirSync(sessionsDir, { recursive: true });
mkdirSync(join(agentDir, "sessions", "live"), { recursive: true });

const { ChatHostRouter } = await import("./chat-host");
const { FakeDriver } = await import("./chat-runtime/fake-driver");
const { ArchivedError, setChatRouter } = await import("./chat-handle");
const { archiveSession } = await import("./sessions-index");
const { addWebSession } = await import("./web-sessions");
const { ARCHIVED_REFUSAL, isArchived } = await import("./archived-sessions");
const { canonicalPath } = await import("./paths");
const { deliverFrames, recordFrame } = await import("./ws");
const { readDrafts } = await import("./drafts");
const { promptSession } = await import("./session-prompt");
const { beforeChat } = await import("./chat-actions");
const { CHAT_CLOSED_CLOSE_CODE } = await import("../shared/protocol");

const driver = new FakeDriver();
const supDir = mkdtempSync(join(agentDir, "sup-"));
const router = new ChatHostRouter(7_000, "b1", {
  driver,
  // Any start reaches this: none may.
  connect: (async () => {
    throw new Error("an archived chat's process was started");
  }) as never,
  supervisor: { registryDir: () => join(supDir, "registry"), deathsFile: () => join(supDir, "deaths.jsonl"), socketPath: (id: string) => join(supDir, `${id}.sock`), isChatProcess: () => false },
  bun: () => process.execPath,
  resumeCrashed: () => {},
});
// Installed as the server installs it (chat-host.ts): the router's own open, close and take-back.
setChatRouter({
  ready: () => router.ready(),
  get: (p) => router.get(p),
  all: () => router.all(),
  acquire: (p, force) => router.acquire(p, force),
  close: (p, message, opts) => router.close(p, message, opts),
  takenBack: (p) => router.settled(p),
});

after(() => {
  router.detach();
  setChatRouter(null);
  rmSync(agentDir, { recursive: true, force: true });
});

let n = 0;
/** A web session with a conversation, older than the foreign-write window, archived by hand. */
async function archived(): Promise<{ path: string; id: string }> {
  const id = `01a0-arch${n}`;
  const path = join(sessionsDir, `2026-10-20T00-00-0${n}-000Z_${id}.jsonl`);
  n++;
  const lines = [
    { type: "session", version: 3, id, timestamp: "2026-10-20T00:00:00.000Z", cwd: agentDir },
    { type: "message", id: "u1", parentId: null, timestamp: "2026-10-20T00:00:01.000Z", message: { role: "user", content: [{ type: "text", text: "first ask" }] } },
    { type: "message", id: "a1", parentId: "u1", timestamp: "2026-10-20T00:00:02.000Z", message: { role: "assistant", content: [{ type: "text", text: "first answer" }], provider: "zai", model: "glm-5.3", stopReason: "stop" } },
  ];
  writeFileSync(path, `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`);
  const old = new Date(Date.now() - 10 * 60_000);
  utimesSync(path, old, old);
  addWebSession(id);
  const r = await archiveSession(canonicalPath(path), true);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(isArchived(id), true);
  return { path: canonicalPath(path), id };
}

const settle = () => new Promise((r) => setTimeout(r, 50));

test("right after Archive, opening the chat starts nothing: refused as archived, with the one refusal text", async () => {
  const s = await archived();
  await assert.rejects(router.acquire(s.path, false), (err: unknown) => err instanceof ArchivedError && err.message === ARCHIVED_REFUSAL);
  // Again (a reload, another tab, a tab brought to the front): the same, never a start.
  await assert.rejects(router.acquire(s.path, false), ArchivedError);
  assert.equal(driver.started.length, 0, "no process started");
});

test("a tab's /ws/chat on an archived chat (a new tab, a reconnect) is told `closed` (archived) with the code no tab retries; nothing starts", async () => {
  const s = await archived();
  for (let i = 0; i < 2; i++) {
    const frames: Record<string, unknown>[] = [];
    let closed = false;
    const rec = recordFrame(s.path, { type: "prompt", text: "never sent" } as never, (m) => void frames.push(m), () => void (closed = true));
    await settle();
    assert.deepEqual(frames, [{ type: "closed", reason: "archived" }], "no `error` (which a tab would retry or show as a failure), no hello");
    assert.equal(closed, true, "the socket was closed by the server");
    assert.equal(rec.emit(), false, "nothing goes over");
  }
  assert.equal(driver.started.length, 0);
  assert.ok(CHAT_CLOSED_CLOSE_CODE === 4422);
});

test("a message a closed tab handed the server for an archived chat goes back to the session's draft; nothing starts", async () => {
  const s = await archived();
  deliverFrames(s.path, [{ type: "prompt", text: "typed before it was archived", clientId: "c-arch-1" } as never]);
  await settle();
  assert.match(readDrafts()[s.id]?.text ?? "", /typed before it was archived/);
  assert.equal(driver.started.length, 0);
});

test("a message from a script, tour or schedule (POST /api/sessions/prompt) and a script's chat action are refused 409 with the one text", async () => {
  const s = await archived();
  const r = await promptSession(s.path, "hello from a tour");
  assert.deepEqual(r, { ok: false, status: 409, error: ARCHIVED_REFUSAL });
  assert.deepEqual(await beforeChat(s.path, { type: "compact" }), { status: 409, body: { error: ARCHIVED_REFUSAL, outcome: "refused", code: "archived" } });
  // Stop on a chat that isn't open answers as for any closed chat: nothing was running.
  assert.deepEqual(await beforeChat(s.path, { type: "abort" }), { status: 200, body: { outcome: "stopped", wasRunning: false } });
  assert.equal(driver.started.length, 0);
});

test("Unarchive opens the way again: the next open starts the chat", async () => {
  const s = await archived();
  const r = await archiveSession(s.path, false);
  assert.equal(r.ok, true);
  assert.equal(isArchived(s.id), false);
  // The stand-in process never answers, so the open fails, but it was tried: a start, no refusal.
  await assert.rejects(router.acquire(s.path, false), (err: unknown) => !(err instanceof ArchivedError));
  assert.ok(driver.started.length >= 1, "a process was started for the unarchived chat");
});
