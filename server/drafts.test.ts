// Run: npx tsx --test server/drafts.test.ts
// Uses a throwaway PI_CODING_AGENT_DIR in the OS temp dir; ~/.pi is never read or written.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

const agentDir = mkdtempSync(join(tmpdir(), "pi-web-drafts-test-"));
process.env.PI_CODING_AGENT_DIR = agentDir; // before the modules below compute their paths
const sessionsDir = join(agentDir, "sessions", "--tmp-drafts-test--");
mkdirSync(sessionsDir, { recursive: true });
mkdirSync(join(agentDir, "sessions", "live"), { recursive: true });
const draftsFile = join(agentDir, "sova", "drafts.json");

const { draftForClient, draftPreview, dropDrafts, getDraft, readDrafts, setDraft } = await import("./drafts");
const { isPiClipboardName } = await import("../shared/tmp-paths");
const { cleanupSessions, listSessions } = await import("./sessions-index");
const { canonicalPath } = await import("./paths");
const { attachmentsRoot, deleteAttachment, saveUploadedImage, sessionAttachmentsDir } = await import("./attachments");

after(() => rmSync(agentDir, { recursive: true, force: true }));

type DiskAttachment = { path: string; name: string; mimeType: string; size: number };
const onDisk = () =>
  JSON.parse(readFileSync(draftsFile, "utf8")) as { version: number; drafts: Record<string, { text: string; updatedAt: string; attachments?: DiskAttachment[] }> };

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
/** A real upload into a session's attachments folder (POST /api/upload?draft=). */
const upload = (id: string) => saveUploadedImage(PNG, "image/png", sessionAttachmentsDir(id)!);

/** A session file: header only (a husk), or with one user message (titled). */
function session(id: string, userText?: string): string {
  const path = join(sessionsDir, `2026-09-19T00-00-00-000Z_${id}.jsonl`);
  const lines = [JSON.stringify({ type: "session", version: 3, id, timestamp: "2026-09-19T00:00:00.000Z", cwd: "/tmp" })];
  if (userText !== undefined) {
    lines.push(JSON.stringify({ type: "message", id: "m1", parentId: null, timestamp: "2026-09-19T00:00:01.000Z", message: { role: "user", content: userText } }));
  }
  writeFileSync(path, `${lines.join("\n")}\n`);
  return canonicalPath(path);
}

test("store: missing file reads as empty", () => {
  assert.deepEqual({ ...readDrafts() }, {});
  assert.equal(getDraft("nope"), null);
});

test("store: round-trip, versioned shape on disk, merged with other writers", () => {
  setDraft("a", "hello\nworld");
  const d = getDraft("a");
  assert.equal(d?.text, "hello\nworld");
  assert.ok(d && !Number.isNaN(Date.parse(d.updatedAt)));
  const disk = onDisk();
  assert.equal(disk.version, 1);
  assert.deepEqual(Object.keys(disk.drafts), ["a"]);
  // Another server instance writes a draft; our next write keeps it.
  writeFileSync(draftsFile, JSON.stringify({ version: 1, drafts: { ...disk.drafts, other: { text: "x", updatedAt: "2026-01-01T00:00:00.000Z" } } }));
  setDraft("b", "bee");
  assert.deepEqual(Object.keys(onDisk().drafts).sort(), ["a", "b", "other"]);
  assert.equal(getDraft("other")?.text, "x");
  dropDrafts(["a", "b", "other", "never-there"]);
  assert.deepEqual(onDisk().drafts, {});
});

test("store: empty or whitespace-only text deletes the entry", () => {
  setDraft("w", "keep me");
  setDraft("w", "  \n\t ");
  assert.equal(getDraft("w"), null);
  assert.equal("w" in onDisk().drafts, false);
  setDraft("w", "again");
  setDraft("w", "");
  assert.equal(getDraft("w"), null);
});

test("store: a corrupt file or malformed entries are tolerated", () => {
  writeFileSync(draftsFile, "{not json");
  assert.deepEqual({ ...readDrafts() }, {});
  setDraft("c", "fresh");
  assert.equal(onDisk().drafts.c?.text, "fresh");
  writeFileSync(draftsFile, JSON.stringify({ version: 1, drafts: { good: { text: "ok", updatedAt: "t" }, bad: { text: 5 }, worse: null } }));
  assert.deepEqual(Object.keys(readDrafts()), ["good"]);
  dropDrafts(["good"]);
});

test("draftPreview: first non-empty line, whitespace-collapsed, capped at 80 like a title", () => {
  assert.equal(draftPreview("\n  \n   fix   the\tbug  \nsecond line"), "fix the bug");
  assert.equal(draftPreview("\r\n\r\nwindows\r\nline"), "windows");
  assert.equal(draftPreview("   "), "");
  const long = "x".repeat(100);
  const p = draftPreview(long);
  assert.equal(p.length, 80);
  assert.equal(p, `${"x".repeat(79)}…`);
  assert.equal(draftPreview("y".repeat(80)), "y".repeat(80));
});

test("listSessions: a husk with a draft is listed with draftPreview; one without stays hidden", async () => {
  const withDraft = session("husk-draft");
  const bare = session("husk-bare");
  const titled = session("titled", "real question");
  setDraft("husk-draft", "\n  my unsent   idea\nmore");
  setDraft("husk-bare", "   "); // whitespace-only never stores, so still hidden
  setDraft("titled", "follow-up draft");
  const list = await listSessions();
  const row = list.find((s) => s.path === withDraft);
  assert.ok(row, "husk with a draft is listed");
  assert.equal(row.draftPreview, "my unsent idea");
  assert.equal(row.title, "Untitled");
  assert.equal(list.some((s) => s.path === bare), false);
  const t = list.find((s) => s.path === titled);
  assert.ok(t);
  assert.equal(t.draftPreview, undefined, "a titled session is never a draft row");
  // Clearing the draft hides the husk again.
  setDraft("husk-draft", "");
  assert.equal((await listSessions()).some((s) => s.path === withDraft), false);
});

test("cleanupSessions: deleting a husk drops its draft", async () => {
  const path = session("husk-gone");
  const old = new Date(Date.now() - 3_600_000);
  utimesSync(path, old, old); // past RECENT_WRITE_MS
  setDraft("husk-gone", "doomed");
  setDraft("keeper", "stays");
  const r = await cleanupSessions({ mode: "husks", dryRun: false });
  assert.ok(r.deletedIds.includes("husk-gone"));
  assert.equal(getDraft("husk-gone"), null);
  assert.equal(getDraft("keeper")?.text, "stays");
});

test("attachments: an upload lands in the session's folder with the sova-<uuid> name", () => {
  const a = upload("up-1");
  assert.equal(a.path, join(agentDir, "sova", "attachments", "up-1", a.name));
  assert.equal(attachmentsRoot(), join(agentDir, "sova", "attachments"));
  assert.match(a.name, /^sova-[0-9a-f-]{36}\.png$/);
  // RENAME BRIDGE: new uploads are sova-named, but a chip saved before the rename is still a
  // generated reference — it must keep being labelled and stripped as one, not shown as a name
  // the user typed. Both spellings answer to isPiClipboardName, forever.
  assert.equal(isPiClipboardName(a.name), true);
  assert.equal(isPiClipboardName(`pi-web-${a.name.slice("sova-".length)}`), true, "pre-rename upload names stay generated names");
  assert.deepEqual({ mimeType: a.mimeType, size: a.size }, { mimeType: "image/png", size: PNG.length });
  assert.equal(sessionAttachmentsDir("../escape"), null);
  assert.equal(sessionAttachmentsDir("a/b"), null);
});

test("store: attachments round-trip; the label is kept, mimeType/size come from the file", () => {
  const a = upload("att");
  const b = upload("att");
  setDraft("att", "look", [a, { ...b, name: "Screenshot 2026-09-21.png" }]);
  const kept = getDraft("att")?.attachments?.[1];
  assert.equal(kept?.name, "Screenshot 2026-09-21.png");
  assert.equal(kept?.mimeType, "image/png"); // from the file, not the body
  // A name that is a path, or carries a control character, falls back to the file's own name.
  setDraft("att", "look", [{ ...a, name: "evil/../name" }, { ...b, name: "bad\u0007.png" }]);
  assert.deepEqual(getDraft("att")?.attachments, [a, b]);
  // A wrong mimeType/size from the client is ignored either way.
  setDraft("att", "look", [{ ...a, mimeType: "text/html", size: 1 }, { ...b, mimeType: "text/html", size: 1 }]);
  assert.deepEqual(getDraft("att")?.attachments, [a, b]);
  assert.deepEqual(onDisk().drafts.att?.attachments, [a, b]);
  // Text-only rewrites drop them; no attachments means the field is absent on disk.
  setDraft("att", "look");
  assert.equal("attachments" in (onDisk().drafts.att ?? {}), false);
  dropDrafts(["att"]);
});

test("store: invalid attachment entries are dropped, the rest kept, capped at 8", () => {
  const good = upload("inv");
  const outside = join(agentDir, "elsewhere.png");
  writeFileSync(outside, PNG);
  setDraft("inv", "x", [
    null,
    "str",
    { name: "no path" },
    { path: "/etc/passwd", name: "passwd", mimeType: "image/png", size: 1 },
    { path: outside, name: "elsewhere.png", mimeType: "image/png", size: 12 },
    { path: `${attachmentsRoot()}/inv/../inv/${good.name}` }, // traversal, even though it lands on a real file
    { path: join(attachmentsRoot(), "inv", "missing.png") },
    good,
    good, // duplicate
  ]);
  assert.deepEqual(getDraft("inv")?.attachments, [good]);
  const many = Array.from({ length: 10 }, () => upload("inv"));
  setDraft("inv", "x", many);
  assert.deepEqual(getDraft("inv")?.attachments, many.slice(0, 8));
  // Not an array at all: treated as none.
  setDraft("inv", "x", { path: good.path });
  assert.equal(getDraft("inv")?.attachments, undefined);
  dropDrafts(["inv"]);
});

test("store: whitespace-only text with attachments keeps the entry; without them it goes", () => {
  const a = upload("ws");
  setDraft("ws", "  \n ", [a]);
  assert.equal(getDraft("ws")?.text, "  \n ");
  assert.deepEqual(getDraft("ws")?.attachments, [a]);
  setDraft("ws", "  \n ", []);
  assert.equal(getDraft("ws"), null);
  setDraft("ws", "", [{ path: "/nope/x.png" }]); // only invalid ones: same as none
  assert.equal(getDraft("ws"), null);
});

test("draftPreview: images-only drafts read \"1 image\" / \"N images\"; text wins", () => {
  assert.equal(draftPreview("", [{}]), "1 image");
  assert.equal(draftPreview(" \n\t", [{}, {}, {}]), "3 images");
  assert.equal(draftPreview("words", [{}, {}]), "words");
  assert.equal(draftPreview("", []), "");
});

test("GET /api/sessions/draft body: attachments whose file is gone are left out, [] when none", () => {
  const keep = upload("get-draft");
  const gone = upload("get-draft");
  setDraft("get-draft", "hi", [keep, gone]);
  rmSync(gone.path);
  const body = draftForClient("get-draft");
  assert.equal(body.text, "hi");
  assert.deepEqual(body.attachments, [keep]);
  assert.ok(body.updatedAt);
  assert.deepEqual(draftForClient("get-none"), { text: null, attachments: [], updatedAt: null });
  dropDrafts(["get-draft"]);
});

test("listSessions: an images-only husk draft is listed with an image-count preview", async () => {
  const path = session("husk-img");
  setDraft("husk-img", "", [upload("husk-img"), upload("husk-img")]);
  const row = (await listSessions()).find((s) => s.path === path);
  assert.equal(row?.draftPreview, "2 images");
  dropDrafts(["husk-img"]);
});

test("cleanupSessions: deleting a husk removes its attachments folder too", async () => {
  const path = session("husk-att");
  const a = upload("husk-att");
  const other = upload("other-att");
  setDraft("husk-att", "", [a]);
  const old = new Date(Date.now() - 3_600_000);
  utimesSync(path, old, old);
  const r = await cleanupSessions({ mode: "husks", dryRun: false });
  assert.ok(r.deletedIds.includes("husk-att"));
  assert.equal(existsSync(sessionAttachmentsDir("husk-att")!), false);
  assert.equal(getDraft("husk-att"), null);
  assert.equal(existsSync(other.path), true, "another session's folder is untouched");
});

test("DELETE /api/attachment: one file under the attachments root only", () => {
  const a = upload("del");
  const b = upload("del");
  assert.deepEqual(deleteAttachment(a.path), { ok: true });
  assert.equal(existsSync(a.path), false);
  assert.equal(existsSync(b.path), true);
  const again = deleteAttachment(a.path);
  assert.equal(again.ok ? 0 : again.status, 404);
  const tmp = `/tmp/pi-web-${crypto.randomUUID()}.png`;
  writeFileSync(tmp, PNG);
  try {
    for (const p of [tmp, "/etc/passwd", `${attachmentsRoot()}/del/../../../drafts.json`, `${attachmentsRoot()}/del`, draftsFile]) {
      const r = deleteAttachment(p);
      assert.equal(r.ok ? 0 : r.status, 403, p);
    }
    assert.equal(existsSync(tmp), true, "/tmp is never ours to delete");
  } finally {
    rmSync(tmp, { force: true });
  }
  const none = deleteAttachment(undefined);
  assert.equal(none.ok ? 0 : none.status, 400);
});
