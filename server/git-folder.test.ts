// The git folder's reading for the new session card (server/git-folder.ts): sizes by stat, the
// two warnings and the line between them, the entry cap, the cache. Real files in a temp folder
// shaped like a git folder (the summary that carries it: git-folder.integration.test.ts).
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, test } from "node:test";
import { clearGitFolderCache, GIT_FOLDER_TTL_MS, gitFolderReading, measureGitFolder, OVERDUE_LOOSE, OVERDUE_PACKS, STUCK_LOCK_MS } from "./git-folder";

const tmp = realpathSync(mkdtempSync(join(tmpdir(), "sova-gitfolder-")));
after(() => rmSync(tmp, { recursive: true, force: true }));
beforeEach(() => clearGitFolderCache());
let n = 0;
const NOW = Date.UTC(2026, 9, 26, 12);

/** A git-folder-shaped tree: `packs` pack files of 1,000 bytes, `loose` loose objects of 10 bytes, a 100-byte config. */
function folder(o: { packs?: number; loose?: number; locks?: Record<string, number> } = {}): string {
  const dir = join(tmp, `g${n++}`, ".git");
  mkdirSync(join(dir, "objects", "pack"), { recursive: true });
  mkdirSync(join(dir, "objects", "info", "commit-graphs"), { recursive: true });
  writeFileSync(join(dir, "config"), "x".repeat(100));
  for (let i = 0; i < (o.packs ?? 0); i++) writeFileSync(join(dir, "objects", "pack", `pack-${i}.pack`), "p".repeat(1000));
  for (let i = 0; i < (o.loose ?? 0); i++) {
    const fan = join(dir, "objects", (i % 256).toString(16).padStart(2, "0"));
    mkdirSync(fan, { recursive: true });
    writeFileSync(join(fan, `obj${i}`), "l".repeat(10));
  }
  for (const [rel, ageMs] of Object.entries(o.locks ?? {})) {
    const p = join(dir, rel);
    writeFileSync(p, "");
    utimesSync(p, (NOW - ageMs) / 1000, (NOW - ageMs) / 1000);
  }
  return dir;
}

test("the size is every file's size, and a quiet folder carries no warning", async () => {
  const dir = folder({ packs: 3, loose: 5 });
  const r = await measureGitFolder(dir, NOW);
  assert.deepEqual(r, { path: dir, bytes: 3 * 1000 + 5 * 10 + 100, partial: false, packs: 3, loose: 5, warning: null, checkedAt: NOW });
  assert.equal(await measureGitFolder(join(tmp, "nothing-here"), NOW), null);
});

test("stuck: a cleanup lock more than an hour old, the oldest named; a fresh one is a cleanup running", async () => {
  const fresh = await measureGitFolder(folder({ locks: { "objects/pack/multi-pack-index.lock": STUCK_LOCK_MS - 60_000 } }), NOW);
  assert.equal(fresh?.warning, null);
  const dir = folder({ packs: OVERDUE_PACKS + 5, locks: { "objects/pack/multi-pack-index.lock": STUCK_LOCK_MS + 60_000, "objects/info/commit-graphs/commit-graph-chain.lock": 3 * STUCK_LOCK_MS } });
  const r = await measureGitFolder(dir, NOW);
  assert.deepEqual(r?.warning, { kind: "stuck", lock: "commit-graph-chain.lock", path: join(dir, "objects/info/commit-graphs/commit-graph-chain.lock"), since: NOW - 3 * STUCK_LOCK_MS }, "stuck wins over overdue");
});

test("overdue: more than 50 pack files or more than 6,700 loose objects, each count only when it is over", async () => {
  assert.equal((await measureGitFolder(folder({ packs: OVERDUE_PACKS }), NOW))?.warning, null, "exactly 50 is not over");
  assert.deepEqual((await measureGitFolder(folder({ packs: OVERDUE_PACKS + 1 }), NOW))?.warning, { kind: "overdue", packs: OVERDUE_PACKS + 1 });
  assert.deepEqual((await measureGitFolder(folder({ loose: OVERDUE_LOOSE + 1 }), NOW))?.warning, { kind: "overdue", loose: OVERDUE_LOOSE + 1 });
});

test("the entry cap makes the size a lower bound, and the pack count stays whole", async () => {
  const dir = folder({ packs: 4, loose: 40 });
  const r = await measureGitFolder(dir, NOW, 10);
  assert.equal(r?.partial, true);
  assert.equal(r?.packs, 4, "the pack folder is walked first");
  assert.ok(r!.bytes < 4 * 1000 + 40 * 10 + 100);
});

test("a reading is reused for 5 minutes per folder", async () => {
  const dir = folder({ packs: 1 });
  let now = NOW;
  const first = await gitFolderReading(dir, () => now);
  writeFileSync(join(dir, "objects", "pack", "pack-new.pack"), "p".repeat(1000));
  now += GIT_FOLDER_TTL_MS - 1;
  assert.equal(await gitFolderReading(dir, () => now), first, "cached");
  now += 2;
  assert.equal((await gitFolderReading(dir, () => now))?.packs, 2, "read again once stale");
});
