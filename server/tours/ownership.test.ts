import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { tourEditionAssetsFixture, tourEditionFixture } from "../../shared/tour-fixtures";
import { extraSessionRoots, setExtraSessionRoots, SESSIONS_DIR } from "../paths";
import { rememberTourOwner, scanTourOwnerFiles, type TourOwnerScanOptions } from "./ownership";
import { TourStore } from "./store";
import { sweepMissingTourOwners, tourOwnerStates } from "./sweep";

const at = "2026-01-02T03:04:05.000Z";
async function setup() {
  const base = mkdtempSync(join(tmpdir(), "tour-owner-safety-")), root = join(base, "state"), sessions = join(base, "sessions");
  mkdirSync(sessions);
  const roots = [{ path: sessions, flat: true }], edition = tourEditionFixture(), id = edition.sessionId;
  const store = new TourStore(join(root, "tours")); store.publishEdition(edition, tourEditionAssetsFixture());
  const file = join(sessions, `fixture_${id}.jsonl`);
  const header = JSON.stringify({ type: "session", version: 3, id, timestamp: at, cwd: base }) + "\n";
  writeFileSync(file, header);
  assert.equal(await rememberTourOwner(id, file, { root, sessionRoots: roots }), true);
  unlinkSync(file);
  // Every adversarial case starts with affirmative cleanup authority. Missing provenance would
  // make both a broken scanner and a correct one return UNKNOWN, hiding the regression.
  assert.equal((await tourOwnerStates([id], roots, root)).get(id), "missing");
  const picture = join(store.root, id, edition.manifest.id, "editions", edition.manifest.editionId, "desktop.png"), bytes = readFileSync(picture);
  let removed = 0;
  const cleanup = async (sid: string) => { removed++; store.deleteSession(sid); };
  const intact = () => { assert.equal(removed, 0); assert.deepEqual(readFileSync(picture), bytes); assert.ok(store.readEdition(id, edition.manifest.id, edition.manifest.editionId)); };
  return { base, root, sessions, roots, edition, id, store, file, header, picture, cleanup, intact, close: () => rmSync(base, { recursive: true, force: true }) };
}

test("a missing configured root blocks otherwise proven deletion and retains actual checked pictures", async () => {
  const f = await setup(); try {
    const roots = [...f.roots, { path: join(f.base, "configured-but-missing"), flat: true }];
    const result = await sweepMissingTourOwners({ root: f.root, sessionRoots: roots, cleanup: f.cleanup, warning: () => {} });
    assert.equal(result.checked, 1); assert.equal(result.unknown, 1); assert.equal(result.removed, 0);
    f.intact();
  } finally { f.close(); }
});

test("linked or nonplain entries cannot erase an edition even with an otherwise valid absent-owner record", async () => {
  for (const kind of ["live-jsonl-link", "dangling-jsonl-link", "flat-non-transcript-link", "directory-as-transcript", "linked-project-directory"] as const) {
    const f = await setup(); try {
      if (kind === "directory-as-transcript") mkdirSync(join(f.sessions, "uncertain.jsonl"));
      else if (kind === "linked-project-directory") {
        const target = join(f.base, "project-target"); mkdirSync(target);
        writeFileSync(join(target, `moved_${f.id}.jsonl`), f.header);
        symlinkSync(target, join(f.sessions, "project-link"));
      } else {
        const target = join(f.base, "owner-target.jsonl");
        if (kind !== "dangling-jsonl-link") writeFileSync(target, f.header);
        symlinkSync(target, join(f.sessions, kind === "flat-non-transcript-link" ? "unrelated-link" : "uncertain.jsonl"));
      }
      const roots = [{ path: f.sessions, flat: kind !== "linked-project-directory" }];
      const result = await sweepMissingTourOwners({ root: f.root, sessionRoots: roots, cleanup: f.cleanup, warning: () => {} });
      assert.equal(result.unknown, 1, kind); assert.equal(result.removed, 0, kind); f.intact();
    } finally { f.close(); }
  }
});

test("directory-read failures and nonplain dirents remain UNKNOWN regardless of host permission privileges", async () => {
  for (const kind of ["unreadable-root", "unreadable-project", "nonplain-fifo"] as const) {
    const f = await setup(); try {
      const denied = kind === "unreadable-project" ? join(f.sessions, "denied-project") : join(f.base, "denied-root");
      mkdirSync(denied);
      const roots = kind === "unreadable-root" ? [...f.roots, { path: denied, flat: true }] : [{ path: f.sessions, flat: kind !== "unreadable-project" }];
      let exercised = 0;
      // Only the read-only syscall is controlled. Headers, birth provenance, checked editions,
      // all other filesystem reads and the destructive cleanup callback remain real.
      const scan: TourOwnerScanOptions = { readDirectory: async path => {
        if (kind !== "nonplain-fifo" && path === denied) {
          exercised++;
          throw Object.assign(new Error("Directory read denied."), { code: "EACCES" });
        }
        const entries = await readdir(path, { withFileTypes: true });
        if (kind === "nonplain-fifo" && path === f.sessions) {
          exercised++;
          return [...entries, { name: "socket-or-fifo", isFile: () => false, isDirectory: () => false, isSymbolicLink: () => false }];
        }
        return entries;
      } };
      const result = await sweepMissingTourOwners({ root: f.root, sessionRoots: roots, owners: (ids, capturedRoots) =>
        tourOwnerStates(ids, capturedRoots, f.root, rootsToRead => scanTourOwnerFiles(rootsToRead, scan)),
      cleanup: f.cleanup, warning: () => {} });
      assert.equal(exercised, 1, "the denial/nonplain branch must actually run, not pass from unrelated uncertainty");
      assert.equal(result.unknown, 1, kind); assert.equal(result.removed, 0, kind); f.intact();
    } finally { f.close(); }
  }
});

test("a changing registered-root provider never replaces the second confirmation snapshot or authorizes cleanup", async () => {
  const f = await setup(), original = extraSessionRoots();
  try {
    mkdirSync(SESSIONS_DIR, { recursive: true });
    let providerCalls = 0;
    setExtraSessionRoots(() => ++providerCalls === 1 ? [f.sessions] : []);
    const snapshots: (readonly { path: string; flat: boolean }[])[] = [];
    const result = await sweepMissingTourOwners({ root: f.root, owners: async (ids, roots) => {
      snapshots.push(roots);
      return tourOwnerStates(ids, roots, f.root);
    }, cleanup: f.cleanup, warning: () => {} });
    assert.equal(snapshots.length, 2); assert.equal(snapshots[0], snapshots[1], "both absence scans use exactly the captured root list");
    assert.ok(snapshots[1]!.some(root => root.path === f.sessions));
    assert.equal(providerCalls, 2, "one captured scan list, plus the final visibility-change guard; never a replacement second scan list");
    assert.equal(result.unknown, 1); assert.equal(result.removed, 0); f.intact();
  } finally { setExtraSessionRoots(() => original); f.close(); }
});

test("two confirmations share one immutable root snapshot and a plain proven absence still cleans", async () => {
  const f = await setup(); try {
    const snapshots: unknown[] = [];
    const result = await sweepMissingTourOwners({ root: f.root, sessionRoots: f.roots, owners: async (ids, roots) => {
      snapshots.push(roots);
      return tourOwnerStates(ids, roots, f.root);
    }, cleanup: f.cleanup, warning: () => {} });
    assert.equal(snapshots.length, 2); assert.equal(snapshots[0], snapshots[1]);
    assert.notEqual(snapshots[0], f.roots); assert.equal(Object.isFrozen(snapshots[0]), true);
    assert.equal(result.removed, 1); assert.equal(result.unknown, 0); assert.equal(existsSync(f.picture), false);
  } finally { f.close(); }
});
