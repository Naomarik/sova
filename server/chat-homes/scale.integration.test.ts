// Run: pnpm test:int server/chat-homes/scale.integration.test.ts
// The many-chats bench as a landing check (§app.chat-homes/change-log): 5,000 homes, and the costs that grew with every
// home stay flat. Budgets are counts of what was read (machine-independent); the times are printed for the record.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { benchHomes } from "../../scripts/bench-chat-homes/bench";

const scratch = mkdtempSync(join(tmpdir(), "sova-homes-scale-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

test("5,000 homes, 150 active: a second of list activity, a new chat, a full list and 500 stray names read no home that didn't change; the sweep stats active homes only", async () => {
  const r = await benchHomes({ homes: 5000, active: 150, scratch });
  console.log(`[homes-scale] ${JSON.stringify({ check: r.checkMs, newChat: r.newChatMs, listFiles: r.listFilesMs, start: r.startMs, strays: r.straysMs, sweep: r.sweepMs, io: r.io })}`);
  assert.ok(r.io, "the counters exist");
  assert.equal(r.io.checkStats, 0, "a look at the homes after the 1 s trust stats no home (it was one stat per home)");
  assert.ok(r.io.newChatFolders <= 2, `a new chat reads its own home's cards and offers folders only (read ${r.io.newChatFolders}; it was two per home)`);
  assert.equal(r.io.newChatFull, 0, "no open-record index is rebuilt whole for a new chat");
  assert.equal(r.io.listReaddirs, 0, "a full list build reads no home folder nothing said changed (it was one per home)");
  assert.equal(r.io.strayManifestReads, 0, "a name known not to be a home is not read again");
  assert.ok(r.io.sweepStats <= 150 + 20, `the backstop sweep stats the active homes only (stat'ed ${r.io.sweepStats}; 5,000 homes)`);
});
