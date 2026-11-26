// The chat homes backup (scripts/chat-homes/backup.mjs) and --from-backup restore, with the system's
// tar: the homes root's .superseded and .incoming siblings travel in a backup and come back. A
// throwaway agent dir and homes root.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
// @ts-expect-error plain JS, no types
import { backup } from "./chat-homes/backup.mjs";
// @ts-expect-error plain JS, no types
import { rollback } from "./chat-homes/rollback.mjs";

const scratch = mkdtempSync(join(tmpdir(), "sova-backup-test-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

test("a backup holds <homes>.superseded and <homes>.incoming, and --from-backup puts them back", async () => {
  const homes = join(scratch, "homes");
  const env = { PI_CODING_AGENT_DIR: join(scratch, "agent"), SOVA_CHAT_HOMES: homes, SOVA_SHARED_BASE: join(scratch, "shared"), HOME: scratch };
  mkdirSync(join(scratch, "agent", "sova"), { recursive: true });
  mkdirSync(join(homes, "h1"), { recursive: true });
  writeFileSync(join(homes, "h1", "home.json"), "{}");
  mkdirSync(`${homes}.superseded`);
  writeFileSync(join(`${homes}.superseded`, "x-t1.tar.gz"), "kept");
  mkdirSync(join(`${homes}.incoming`, "t2"), { recursive: true });
  writeFileSync(join(`${homes}.incoming`, "t2", "part"), "staged");
  const { dir, manifest } = await backup({ out: join(scratch, "backups"), env, log: () => {} });
  assert.deepEqual(
    manifest.parts.map((p: { name: string }) => p.name),
    ["agent.tar.gz", "homes.tar.gz", "homes-superseded.tar.gz", "homes-incoming.tar.gz"],
  );
  // Gone since the backup: the restore brings both back as they were.
  rmSync(`${homes}.superseded`, { recursive: true });
  rmSync(`${homes}.incoming`, { recursive: true });
  await rollback({ fromBackup: dir, env, log: () => {} });
  assert.equal(readFileSync(join(`${homes}.superseded`, "x-t1.tar.gz"), "utf8"), "kept");
  assert.equal(readFileSync(join(`${homes}.incoming`, "t2", "part"), "utf8"), "staged");
  assert.ok(existsSync(join(homes, "h1", "home.json")));
  // Nothing was deleted: what the restore replaced is kept aside.
  assert.ok(readdirSync(scratch).some((n) => n.startsWith("homes.before-restore-")));
});
