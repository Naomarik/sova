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

test("every archive marks the session first, then closes its chat quietly: a tab reconnecting during the close is refused as archived", async () => {
  const { markArchived } = await import("./sessions-index");
  const { isArchived } = await import("./archived-sessions");
  const id = "archive-quiet-2";
  const path = canonicalPath(join(sessionsDir, `2026-09-24T00-00-01-000Z_${id}.jsonl`));
  const marked: boolean[] = [];
  setChatRouter({
    ready: async () => {},
    get: () => undefined,
    all: () => [],
    acquire: async () => assert.fail("archiving never opens the chat"),
    close: async (_p, _message, opts) => (marked.push(isArchived(id)), assert.deepEqual(opts, { quiet: "archived" }), true),
  });
  await markArchived(id, path);
  assert.deepEqual(marked, [true], "already archived when its chat is closed");
});

test("every way of archiving goes through markArchived (a project overseer's dropped conversation, the Overseer's history, the Archive button)", async () => {
  const { readdirSync, readFileSync } = await import("node:fs");
  const dir = new URL(".", import.meta.url).pathname;
  const hits: string[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(".ts") && !e.name.includes(".test.")) {
        readFileSync(p, "utf8").split("\n").forEach((line, i) => {
          if (/setArchived\([^)]*true/.test(line)) hits.push(`${p.slice(dir.length)}:${i + 1}`);
        });
      }
    }
  };
  walk(dir);
  assert.equal(hits.length, 1, `only markArchived sets the mark: ${hits.join(", ")}`);
  assert.match(hits[0]!, /^sessions-index\.ts:/);
  const src = readFileSync(join(dir, "sessions-index.ts"), "utf8");
  const body = src.slice(src.indexOf("export async function markArchived"));
  assert.ok(body.indexOf("setArchived(id, true)") < body.indexOf("closeChat(") && body.indexOf("closeChat(") < body.indexOf("sessionArchived(id)"), "the mark, then the quiet close, then its workers and links");
});
