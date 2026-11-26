// Clean Up's deletes by age and of empty sessions never match a Moved row: its home is the safety copy (with the kept
// worktrees' archives), which only your own Delete of that row removes. An ordinary chat beside it still goes.
import { dropScratchAgentDir } from "./testing/scratch-agent-dir";
import assert from "node:assert/strict";
import { existsSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { chatHome, ensureChatHome, homeSessionsDir } from "./chat-homes/root";
import { setArchived } from "./archived-sessions";
import { cleanupSessions } from "./sessions-index";
import { markMoved } from "./transport/moved";

after(dropScratchAgentDir);

const header = (id: string) => JSON.stringify({ type: "session", version: 3, id, timestamp: "2026-09-01T00:00:00.000Z", cwd: "/tmp" });
const user = (text: string) => JSON.stringify({ type: "message", id: "m1", parentId: null, timestamp: "2026-09-01T00:00:01.000Z", message: { role: "user", content: text } });

/** A chat in a home of its own, a husk unless given a user message, last written `days` ago. */
function chat(id: string, days: number, text?: string): string {
  ensureChatHome(id);
  const path = join(homeSessionsDir(id), `2026-09-01T00-00-00-000Z_${id}.jsonl`);
  writeFileSync(path, `${[header(id), ...(text ? [user(text)] : [])].join("\n")}\n`);
  const t = new Date(Date.now() - days * 86_400_000);
  utimesSync(path, t, t);
  return path;
}

const moved = (id: string) => {
  markMoved(id, { tid: "tr_moved1", peer: "peer-1", to: "laptop-b", at: new Date().toISOString(), arrivedId: id });
  setArchived(id, true);
};

test("a Moved row is never swept by age or as an empty session, its home kept whole; the ordinary chats beside it still go", async () => {
  const movedHusk = "01a0aaaa-0000-7000-8000-000000000001"; // moved before its first message
  const movedOld = "01a0aaaa-0000-7000-8000-000000000002"; // moved 40 days ago
  const husk = "01a0aaaa-0000-7000-8000-000000000003";
  const old = "01a0aaaa-0000-7000-8000-000000000004";
  const paths = { movedHusk: chat(movedHusk, 1), movedOld: chat(movedOld, 40, "work"), husk: chat(husk, 1), old: chat(old, 40, "old work") };
  moved(movedHusk);
  moved(movedOld);

  // The dry run is the dialog's count: what the real run deletes.
  assert.deepEqual((await cleanupSessions({ mode: "husks", dryRun: true })).deletedIds, [husk]);
  assert.deepEqual((await cleanupSessions({ mode: "husks", dryRun: false })).deletedIds, [husk]);
  assert.deepEqual((await cleanupSessions({ mode: "age", minAgeDays: 7, dryRun: true })).deletedIds, [old]);
  assert.deepEqual((await cleanupSessions({ mode: "age", minAgeDays: 7, dryRun: false })).deletedIds, [old]);
  assert.equal(existsSync(paths.husk), false);
  assert.equal(existsSync(paths.old), false);
  for (const id of [movedHusk, movedOld]) assert.equal(existsSync(chatHome(id)), true, `${id}'s home, the safety copy, stays`);
  assert.equal(existsSync(paths.movedHusk) && existsSync(paths.movedOld), true);

  // Your own Delete of the archived Moved row still removes it.
  assert.deepEqual((await cleanupSessions({ mode: "paths", paths: [paths.movedOld], dryRun: true })).deletedIds, [movedOld]);

  // Compressed after its 7 days (the safety copy is compressed, never removed), it is still never swept by age.
  const packed = await cleanupSessions({ mode: "paths", paths: [paths.movedOld], action: "compress", dryRun: false });
  assert.deepEqual(packed.compressedIds, [movedOld], JSON.stringify(packed));
  assert.deepEqual((await cleanupSessions({ mode: "age", minAgeDays: 7, dryRun: true })).deletedIds, []);
  assert.deepEqual((await cleanupSessions({ mode: "age", minAgeDays: 7, dryRun: false })).deletedIds, []);
  assert.equal(existsSync(`${chatHome(movedOld)}.tar.gz`), true, "its compressed home, <homes>/<id>.tar.gz, stays");
});
