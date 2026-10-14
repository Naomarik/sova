// Run: pnpm test -- server/archive-quiet-close.test.ts. Archiving closes the session's chat with its
// tabs told it closed (`quiet`), never told to reconnect: a tab that reconnects would start the
// archived chat again (§app.chat-processes/idle-stop, §chat.transcript/instant-open). A throwaway
// PI_CODING_AGENT_DIR; the chat router is a stand-in that records the close.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

const agentDir = mkdtempSync(join(tmpdir(), "sova-archive-quiet-"));
process.env.PI_CODING_AGENT_DIR = agentDir; // before the modules below compute their paths
const sessionsDir = join(agentDir, "sessions", "--tmp-archive-quiet--");
mkdirSync(sessionsDir, { recursive: true });
mkdirSync(join(agentDir, "sessions", "live"), { recursive: true });

const { archiveSession } = await import("./sessions-index");
const { addWebSession } = await import("./web-sessions");
const { canonicalPath } = await import("./paths");
const { setChatRouter } = await import("./chat-handle");

after(() => {
  setChatRouter(null);
  rmSync(agentDir, { recursive: true, force: true });
});

test("archiving closes the held chat quietly: its tabs keep what they show and don't reconnect", async () => {
  const id = "archive-quiet-1";
  const path = join(sessionsDir, `2026-09-24T00-00-00-000Z_${id}.jsonl`);
  const lines = [
    { type: "session", version: 3, id, timestamp: "2026-09-24T00:00:00.000Z", cwd: "/tmp" },
    { type: "message", id: "m1", parentId: null, timestamp: "2026-09-24T00:00:01.000Z", message: { role: "user", content: "hi" } },
  ];
  writeFileSync(path, `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`);
  const old = new Date(Date.now() - 40 * 86_400_000);
  utimesSync(path, old, old);
  addWebSession(id);
  const closes: { path: string; opts: unknown }[] = [];
  setChatRouter({
    ready: async () => {},
    get: () => undefined,
    all: () => [],
    acquire: async () => assert.fail("archiving never opens the chat"),
    close: async (p, _message, opts) => (closes.push({ path: p, opts }), true),
  });
  const r = await archiveSession(canonicalPath(path), true);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(closes, [{ path: canonicalPath(path), opts: { quiet: "archived" } }]);
});
