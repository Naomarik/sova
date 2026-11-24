// Run: pnpm test server/chat-homes/delete.test.ts
// A home outlives its chat's archiving; only the chat's own Delete removes it, and no Clean Up takes a
// helper's conversation out of it alone (§app.chat-homes/lifetime).
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

const root = realpathSync(mkdtempSync(join(tmpdir(), "sova-home-delete-")));
process.env.PI_CODING_AGENT_DIR = join(root, "agent");
process.env.SOVA_CHAT_HOMES = join(root, "homes");

const { ensureChatHome, chatHome } = await import("./root");
const { cleanupSessions, markArchived } = await import("../sessions-index");
const { setArchived } = await import("../archived-sessions");
const { chatSharedFolder } = await import("../../pi-config/extensions/sandbox/shared-folder.ts");

after(() => rmSync(root, { recursive: true, force: true }));

const LEAD = "019a0000-0000-7000-8000-0000000000a1";
const HELPER = "019a0000-0000-7000-8000-0000000000a2";

function conversation(home: string, id: string, days: number): string {
  const path = join(home, "sessions", `2026-09-01T00-00-00-000Z_${id}.jsonl`);
  const header = { type: "session", version: 3, id, timestamp: "2026-09-01T00:00:00.000Z", cwd: root };
  const user = { type: "message", id: "m1", parentId: null, timestamp: "2026-09-01T00:00:01.000Z", message: { role: "user", content: "hi" } };
  writeFileSync(path, `${JSON.stringify(header)}\n${JSON.stringify(user)}\n`);
  const t = new Date(Date.now() - days * 86_400_000);
  utimesSync(path, t, t);
  return path;
}

test("archive keeps the home and its shared folder; a helper's file is refused alone; the chat's Delete removes the home", async () => {
  const home = ensureChatHome(LEAD);
  const lead = conversation(home, LEAD, 40);
  const helper = conversation(home, HELPER, 40);
  const shared = chatSharedFolder(LEAD);
  assert.equal(shared, join(home, "shared"));
  mkdirSync(shared, { recursive: true });
  writeFileSync(join(shared, "brief.md"), "kept");

  await markArchived(LEAD, lead);
  assert.equal(existsSync(join(shared, "brief.md")), true, "archiving a homed chat keeps its shared folder");

  setArchived(HELPER, true);
  const alone = await cleanupSessions({ mode: "paths", paths: [helper], dryRun: false });
  assert.equal(alone.deletedCount, 0);
  assert.match(alone.refused?.[0]?.reason ?? "", /kept with its chat/);
  assert.equal(existsSync(helper), true);

  // A helper that still runs holds the home: the chat's Delete waits, as a live chat's does.
  mkdirSync(join(home, "workers"), { recursive: true });
  const record = join(home, "workers", `${HELPER}.json`);
  writeFileSync(record, JSON.stringify({ v: 1, chatId: HELPER, path: helper, state: "open" }));
  const held = await cleanupSessions({ mode: "paths", paths: [lead], dryRun: false });
  assert.equal(held.deletedCount, 0);
  assert.equal(held.skipped.busy, 1);
  assert.equal(existsSync(lead), true);
  writeFileSync(record, JSON.stringify({ v: 1, chatId: HELPER, path: helper, state: "ended" }));

  const gone = await cleanupSessions({ mode: "paths", paths: [lead], dryRun: false });
  assert.deepEqual(gone.deletedIds, [LEAD]);
  assert.equal(existsSync(chatHome(LEAD)), false, "the whole home goes: helpers, records and shared folder with it");
});
