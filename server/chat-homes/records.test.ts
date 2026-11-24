// Run: pnpm test server/chat-homes/records.test.ts
// A chat home's own records (server/chat-homes/records.ts): a homed chat's entries go to its home's
// chat/*.json, everyone else's stay in the server-wide files, and every read sees both.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

const scratch = mkdtempSync(join(tmpdir(), "sova-home-records-"));
process.env.PI_CODING_AGENT_DIR = join(scratch, "agent");
process.env.SOVA_CHAT_HOMES = join(scratch, "homes");

const { ensureChatHome } = await import("./root");
const { expireHomeRecordChecksForTest, homeOf, registerHomeMember, resetHomeRecordsForTest } = await import("./records");
const { markSeen, readSeen } = await import("../seen");
const { readSessionTitles, setSessionTitle } = await import("../session-titles");
const { isArchived, setArchived } = await import("../archived-sessions");
const { getDraft, setDraft } = await import("../drafts");
const { readSignals, updateSignals, workerKey } = await import("../signals-store");
const { checkTmpImage, deleteAttachment, saveUploadedImage, sessionAttachmentsDir } = await import("../attachments");
const { findTmpImagePaths } = await import("../../shared/tmp-paths");
const { WorkerRegistry } = await import("../chat-workers");

after(() => rmSync(scratch, { recursive: true, force: true }));

const HOMED = "019a0000-0000-7000-8000-00000000000a";
const OLD = "019a0000-0000-7000-8000-00000000000b";
const WORKER = "019a0000-0000-7000-8000-00000000000c";
const state = join(scratch, "agent", "sova");
const doc = (name: string) => join(process.env.SOVA_CHAT_HOMES!, HOMED, "chat", `${name}.json`);
const json = (f: string) => JSON.parse(readFileSync(f, "utf8"));

ensureChatHome(HOMED);

test("a homed chat's entries go to its home; an older chat's stay in the server-wide file; reads see both", () => {
  markSeen(OLD, 1000);
  markSeen(HOMED, 2000);
  assert.deepEqual(json(join(state, "seen.json")), { [OLD]: 1000 });
  assert.equal(json(doc("seen"))["seen.json"][HOMED], 2000);
  assert.equal(readSeen()[HOMED], 2000);

  // A change of the homed chat alone leaves the server-wide file as it was.
  const before = statSync(join(state, "seen.json")).mtimeMs;
  markSeen(HOMED, 3000);
  assert.equal(statSync(join(state, "seen.json")).mtimeMs, before);

  setSessionTitle(HOMED, "Homed title");
  assert.equal(existsSync(join(state, "session-titles.json")), false);
  assert.equal(json(doc("meta"))["session-titles.json#titles"][HOMED].title, "Homed title");
  setSessionTitle(OLD, "Old title");
  assert.deepEqual(Object.keys(json(join(state, "session-titles.json")).titles), [OLD]);
  assert.equal(readSessionTitles()[HOMED], "Homed title");
  resetHomeRecordsForTest(); // a server start: read back from the home
  assert.equal(readSessionTitles()[HOMED], "Homed title");

  setArchived(HOMED, true);
  assert.deepEqual(json(doc("meta"))["archived-sessions.json"], [HOMED]);
  assert.equal(isArchived(HOMED), true);
  setArchived(HOMED, false);
  assert.equal(json(doc("meta"))["archived-sessions.json"], undefined);
});

test("another process's write to the same home is kept by this one's next write, and seen by its next read", () => {
  const OTHER = "019a0000-0000-7000-8000-00000000000e";
  registerHomeMember(OTHER, HOMED);
  setSessionTitle(HOMED, "Mine");
  // Another process (a chat process, a second server) writes a title for the member into the same file.
  const meta = json(doc("meta"));
  meta["session-titles.json#titles"][OTHER] = { title: "Theirs", by: "user", at: 1 };
  writeFileSync(doc("meta"), JSON.stringify(meta));
  setSessionTitle(HOMED, "Mine again");
  const after = json(doc("meta"))["session-titles.json#titles"];
  assert.equal(after[OTHER]?.title, "Theirs");
  assert.equal(after[HOMED]?.title, "Mine again");
  // And the other way round: their change shows here once the files are checked again.
  meta["session-titles.json#titles"] = { ...after, [OTHER]: { title: "Theirs, renamed", by: "user", at: 2 } };
  writeFileSync(doc("meta"), JSON.stringify(meta));
  expireHomeRecordChecksForTest();
  assert.equal(readSessionTitles()[OTHER], "Theirs, renamed");
});

test("a homed chat's unsent draft never goes into its home", () => {
  setDraft(HOMED, "secret thing");
  assert.equal(existsSync(doc("draft")), false);
  assert.equal(json(join(state, "drafts.json")).drafts[HOMED].text, "secret thing");
  assert.equal(getDraft(HOMED)?.text, "secret thing");
});

test("a worker's entries go to its root chat's home, and survive a fresh read", () => {
  registerHomeMember(WORKER, HOMED);
  assert.equal(homeOf(WORKER), HOMED);
  updateSignals((d) => {
    d.stalls[WORKER] = { since: 1, at: 2, names: ["w"] };
    d.workers[workerKey(HOMED, "ag_01")] = { sessionId: HOMED, workerId: "ag_01", kind: "stuck", at: 5, answers: {} };
  });
  const sig = json(doc("signals"));
  assert.ok(sig["signals.json#stalls"][WORKER]);
  assert.ok(sig["signals.json#workers"][`${HOMED}:ag_01`]);
  assert.equal(readSignals().stalls[WORKER]?.since, 1);
});

test("a homed chat's uploads live in its home and are served and deleted from there", () => {
  const dir = sessionAttachmentsDir(HOMED)!;
  assert.equal(dir, join(process.env.SOVA_CHAT_HOMES!, HOMED, "chat", "attachments"));
  assert.equal(sessionAttachmentsDir(OLD), join(state, "attachments", OLD));
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]);
  const up = saveUploadedImage(png, "image/png", dir);
  assert.deepEqual(findTmpImagePaths(`see ${up.path} here`).map((m) => m.path), [up.path]);
  assert.equal(checkTmpImage(up.path).ok, true);
  assert.equal(checkTmpImage(join(process.env.SOVA_CHAT_HOMES!, HOMED, "shared", "x.png")).ok, false);
  assert.deepEqual(deleteAttachment(up.path), { ok: true });
  assert.equal(existsSync(up.path), false);
});

test("a helper's record kept in its chat's home is loaded at start, and its records follow it there", () => {
  const helper = "019a0000-0000-7000-8000-00000000000d";
  const home = join(process.env.SOVA_CHAT_HOMES!, HOMED);
  mkdirSync(join(home, "workers"), { recursive: true });
  const rec = { v: 1, chatId: helper, path: join(home, "sessions", `x_${helper}.jsonl`), key: "k", kind: "worker", parent: { sessionId: HOMED, path: join(home, "sessions", `x_${HOMED}.jsonl`), workerId: "ag_02" }, spec: { kind: "worker", parent: { sessionId: HOMED, path: "", workerId: "ag_02" }, cwd: scratch }, state: "ended", startedAt: new Date(0).toISOString() };
  writeFileSync(join(home, "workers", `${helper}.json`), JSON.stringify(rec));
  resetHomeRecordsForTest();
  const reg = new WorkerRegistry({ start: async () => { throw new Error("no process here"); }, stop: async () => {} });
  assert.equal(reg.record(helper)?.state, "ended", "a finished helper's record is kept and loaded");
  assert.equal(homeOf(helper), HOMED);
  assert.equal(existsSync(join(state, "chats", "workers", `${helper}.json`)), false);
});
