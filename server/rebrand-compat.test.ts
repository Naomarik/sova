// Run: npx tsx --test server/rebrand-compat.test.ts (or npm test)
// The rebrand's compatibility surfaces, exercised end to end against scratch state:
//   - attachments written under the legacy pi-web/ root serve + delete from the moved sova/ root
//     (old absolute paths live in transcripts forever and are never rewritten);
//   - uploads are named sova-<uuid> now, while legacy pi-web-<uuid> and pi's own names parse;
//   - rewind/fanout-member markers read in BOTH spellings and are WRITTEN legacy-named until the
//     bridge closes (a rollback must never meet a marker old code can't read);
//   - a remote placeholder under the legacy root still classifies as remote (never local),
//     and an old repo-path cwd resolves through path-map.json.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

const agentDir = mkdtempSync(join(tmpdir(), "sova-rebrand-test-"));
process.env.PI_CODING_AGENT_DIR = agentDir; // before the modules below compute their paths

const { attachmentsRoot, checkTmpImage, deleteAttachment, saveUploadedImage, sessionAttachmentsDir } = await import("./attachments");
const { findTmpImagePaths, isPiClipboardName } = await import("../shared/tmp-paths");
const { stateRoot, legacyStateRoot } = await import("./state-root");
const { parseTargetCwd } = await import("./targets");
const { movedPath } = await import("./path-map");
const { REWIND_ENTRY, REWIND_ENTRIES, FANOUT_MEMBER_ENTRY, FANOUT_MEMBER_ENTRIES, resolveOpenCwd, ConfigError } = await import("./chat-manager");

after(() => {
  rmSync(agentDir, { recursive: true, force: true });
  for (const d of freshAgentDirs) rmSync(d, { recursive: true, force: true });
});

/** A fresh agent dir per FS-heavy test (the path helpers read PI_CODING_AGENT_DIR per call). */
const freshAgentDirs: string[] = [];
function withAgentDir(fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "sova-rebrand-x-"));
  freshAgentDirs.push(dir);
  const prev = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  try {
    fn(dir);
  } finally {
    process.env.PI_CODING_AGENT_DIR = prev;
  }
}

const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63fcffff3f030005fe02fea72d814d0000000049454e44ae426082", "hex");
const UUID = "a58752a9-8229-46d3-a816-07ef24919b10";
const SID = "01a0c8d1-a967-75d9-9b47-f335e2f21ac1";

test("uploads are named sova-<uuid> under the new root", () => {
  const saved = saveUploadedImage(new Uint8Array(PNG), "image/png", sessionAttachmentsDir(SID)!);
  assert.match(saved.name, /^sova-[0-9a-f-]{36}\.png$/);
  assert.ok(saved.path.startsWith(join(attachmentsRoot(), SID) + "/"));
  assert.equal(attachmentsRoot(), join(stateRoot(), "attachments"));
  assert.equal(isPiClipboardName(saved.name), true, "new names are generated names (stripped on fork)");
  // Legacy + pi names still parse as generated.
  assert.equal(isPiClipboardName(`pi-web-${UUID}.png`), true);
  assert.equal(isPiClipboardName(`pi-clipboard-${UUID}.png`), true);
  assert.equal(isPiClipboardName(`sova-notauuid.png`), false);
  assert.equal(isPiClipboardName("my-screenshot.png"), false);
});

test("an attachment path stored under the LEGACY root serves + deletes from the moved tree", () =>
  withAgentDir((dir) => {
    // Pre-move: a pre-rebrand upload wrote under the legacy root …
    const legacyDir = join(dir, "pi-web", "attachments", SID);
    mkdirSync(legacyDir, { recursive: true });
    const legacyPath = join(legacyDir, `pi-web-${UUID}.png`);
    writeFileSync(legacyPath, PNG);
    // … the move is the rename, and nothing else (no symlink, no transcript rewrite):
    renameSync(join(dir, "pi-web"), join(dir, "sova"));
    assert.ok(!existsSync(join(dir, "pi-web")), "old root gone after the rename");

    const readBack = checkTmpImage(legacyPath);
    assert.equal(readBack.ok, true, "old-rooted transcript path re-anchors at the moved root");
    if (readBack.ok) assert.equal(readBack.realPath, join(dir, "sova", "attachments", SID, `pi-web-${UUID}.png`));
    // The transcript's TEXT recognition covers both tails, so the chip is even offered.
    const text = `broken border here\n${legacyPath}`;
    assert.deepEqual(findTmpImagePaths(text).map((m) => m.path), [legacyPath], "legacy tail still attaches");

    // Deleting through the old path removes the moved file (composer chip remove on an old draft).
    assert.equal(deleteAttachment(legacyPath).ok, true);
    assert.ok(!existsSync(join(dir, "sova", "attachments", SID, `pi-web-${UUID}.png`)));
  }));

test("attachment texts under the NEW root are recognised too", () => {
  const newPath = join(stateRoot(), "attachments", SID, `sova-${UUID}.png`);
  assert.deepEqual(findTmpImagePaths(`see ${newPath}`).map((m) => m.path), [newPath]);
  // Lookalikes stay text: wrong dir name, no session id, nested deeper.
  for (const bad of [
    join(stateRoot(), "uploads", SID, `sova-${UUID}.png`),
    join(stateRoot(), "attachments", `sova-${UUID}.png`),
    join(stateRoot(), "attachments", SID, "deeper", `sova-${UUID}.png`),
  ]) assert.deepEqual(findTmpImagePaths(`see ${bad}`), [], bad);
});

test("remote placeholders classify under EITHER root — an old one never becomes a local folder", () => {
  for (const root of [join(stateRoot(), "targets"), join(legacyStateRoot(), "targets")]) {
    assert.deepEqual(parseTargetCwd(join(root, "box", "srv", "app")), { target: "box", remoteCwd: "/srv/app" });
    assert.deepEqual(parseTargetCwd(join(root, "box")), { target: "box", remoteCwd: "/" });
  }
  assert.equal(parseTargetCwd(join(agentDir, "pi-web2", "targets", "box")), null);
  assert.equal(parseTargetCwd("/home/u/webapps/pi-web"), null, "plain local path is neither");
});

test("the repo-rename map moves old project cwds; state roots are refused as map entries", () => {
  mkdirSync(stateRoot(), { recursive: true });
  writeFileSync(
    join(stateRoot(), "path-map.json"),
    JSON.stringify({ version: 1, moved: [{ from: "/home/u/webapps/pi-web", to: "/home/u/webapps/sova" }, { from: legacyStateRoot(), to: stateRoot() }] }),
  );
  assert.equal(movedPath("/home/u/webapps/pi-web"), "/home/u/webapps/sova");
  assert.equal(movedPath("/home/u/webapps/pi-web/src"), "/home/u/webapps/sova/src");
  assert.equal(movedPath(join(legacyStateRoot(), "targets", "box")), join(legacyStateRoot(), "targets", "box"), "state root unmoved by the map");
});

test("markers: reads accept both spellings, writes stay legacy-named while the bridge is open", () => {
  assert.equal(REWIND_ENTRY, "pi-web-rewind", "write name unchanged until bridge closure");
  assert.equal(FANOUT_MEMBER_ENTRY, "pi-web-fanout-member");
  assert.ok(REWIND_ENTRIES.has("sova-rewind") && REWIND_ENTRIES.has("pi-web-rewind"));
  assert.ok(FANOUT_MEMBER_ENTRIES.has("sova-fanout-member") && FANOUT_MEMBER_ENTRIES.has("pi-web-fanout-member"));
  assert.equal(REWIND_ENTRIES.size, 2);
  assert.equal(FANOUT_MEMBER_ENTRIES.size, 2);
});

test("open boundary: an old-rooted placeholder cwd opens at the moved root (resolveOpenCwd)", () =>
  withAgentDir((dir) => {
    // Pre-move: the placeholder exists under the legacy root …
    mkdirSync(join(dir, "pi-web", "targets", "box", "srv", "app"), { recursive: true });
    // … the move …
    renameSync(join(dir, "pi-web"), join(dir, "sova"));
    // … and the old-rooted stored cwd opens at the moved placeholder. Tools run on the target as
    // before; the placeholder was only ever identity.
    const legacyPlaceholder = join(dir, "pi-web", "targets", "box", "srv", "app");
    const open = resolveOpenCwd("/sessions/x.jsonl", legacyPlaceholder);
    assert.equal(open, join(dir, "sova", "targets", "box", "srv", "app"));
    // With nothing at either root, the error still names the STORED cwd (what the user knows):
    assert.throws(
      () => resolveOpenCwd("/sessions/x.jsonl", join(dir, "sova", "targets", "gone", "srv")),
      (e: unknown) => e instanceof ConfigError && /working directory does not exist/.test(String(e)),
    );
  }));

test("open boundary: an old repo-path cwd resolves via path-map.json (repo rename, parent's session)", () => {
  const stagedSo = join(tmpdir(), `sova-open-cwd-${process.pid}`);
  mkdirSync(join(stagedSo, "renamed", "repo", "src"), { recursive: true });
  mkdirSync(stateRoot(), { recursive: true });
  writeFileSync(
    join(stateRoot(), "path-map.json"),
    JSON.stringify({ version: 1, moved: [{ from: join(stagedSo, "pi-web"), to: join(stagedSo, "renamed", "repo") }] }),
  );
  assert.equal(resolveOpenCwd("/sessions/y.jsonl", join(stagedSo, "pi-web")), join(stagedSo, "renamed", "repo"), "mapped, never folder-gone");
  assert.equal(resolveOpenCwd("/sessions/y.jsonl", join(stagedSo, "pi-web", "src")), join(stagedSo, "renamed", "repo", "src"));
  rmSync(stagedSo, { recursive: true, force: true });
});

/** Writes a path map at the CURRENT state root with a distinct mtime. path-map.ts caches on mtime
    alone, so two maps written in the same millisecond would serve the first one's entries to the
    second one's test — a stale read that looks exactly like a broken mapping. */
let mapStamp = 0;
function writePathMap(moved: { from: string; to: string }[]): void {
  mkdirSync(stateRoot(), { recursive: true });
  const file = join(stateRoot(), "path-map.json");
  writeFileSync(file, JSON.stringify({ version: 1, moved }));
  const t = new Date(Date.now() + ++mapStamp * 10_000);
  utimesSync(file, t, t);
}

// The two routes that take a FOLDER, not a session file: both are reached with a stored cwd (the
// @ menu with the open session's, the New Session picker with the selected session's), so both
// meet the old repo root for as long as pre-rename sessions exist — which is forever.
test("files boundary: an old repo-path cwd indexes the moved folder, remote cwds still refused", async () => {
  const staged = mkdtempSync(join(tmpdir(), "sova-files-map-"));
  freshAgentDirs.push(staged);
  mkdirSync(join(staged, "renamed", "src"), { recursive: true });
  writeFileSync(join(staged, "renamed", "src", "a.ts"), "x");
  writePathMap([{ from: join(staged, "old"), to: join(staged, "renamed") }]);
  const { listProjectFiles } = await import("./files");
  const r = await listProjectFiles(join(staged, "old"), { exec: async () => ({ code: 1, stdout: "", truncated: false }) });
  assert.ok(r.ok, "the old root must index, not 404");
  assert.deepEqual(r.index.files, ["src/a.ts"]);
  // The refusal runs first and on the UNMAPPED path: a placeholder is an identity, not a rename.
  const remote = await listProjectFiles(join(stateRoot(), "targets", "box", "srv"));
  assert.equal(remote.ok, false);
  assert.equal((remote as { status: number }).status, 501, "remote placeholders stay 501, never mapped to a local folder");
});

test("folders boundary: browsing the old repo root lists the moved one and reports its new path", async () => {
  const staged = mkdtempSync(join(tmpdir(), "sova-folders-map-"));
  freshAgentDirs.push(staged);
  mkdirSync(join(staged, "renamed", "server"), { recursive: true });
  writePathMap([{ from: join(staged, "old"), to: join(staged, "renamed") }]);
  const { listFolders } = await import("./folders");
  const r = await listFolders(join(staged, "old"));
  assert.ok(r.ok, "the old root must list, not 404");
  // The listing names the folder that EXISTS: the picker adopts this, so the cwd a new session is
  // created in is the moved one, not the name it was asked for.
  assert.equal(r.listing.path, join(staged, "renamed"));
  assert.deepEqual(r.listing.entries.map((e) => e.name), ["server"]);
});
