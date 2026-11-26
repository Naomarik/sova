// Run: pnpm test server/chat-homes/records.test.ts
// A chat home's own records (server/chat-homes/records.ts): a homed chat's entries go to its home's
// chat/*.json, everyone else's stay in the server-wide files, and every read sees both.
import assert from "node:assert/strict";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

const scratch = mkdtempSync(join(tmpdir(), "sova-home-records-"));
process.env.PI_CODING_AGENT_DIR = join(scratch, "agent");
process.env.SOVA_CHAT_HOMES = join(scratch, "homes");

const { ensureChatHome, forgetHome } = await import("./root");
const { expireHomeRecordChecksForTest, expireHomeRecordSweepForTest, forgetHomeRecords, homeArrived, homeOf, homesGeneration, registerHomeMember, resetHomeRecordsForTest } = await import("./records");
const { markSeen, readSeen } = await import("../seen");
const { memoSessionTitles, readSessionTitles, setSessionTitle } = await import("../session-titles");
const { isArchived, setArchived } = await import("../archived-sessions");
const { isWebSession } = await import("../web-sessions");
const { getDraft, setDraft } = await import("../drafts");
const { readSignals, updateSignals, workerKey } = await import("../signals-store");
const { checkTmpImage, deleteAttachment, saveUploadedImage, sessionAttachmentsDir } = await import("../attachments");
const { findTmpImagePaths } = await import("../../shared/tmp-paths");
const { WorkerRegistry } = await import("../chat-workers");
const { segmentFile, segments } = await import("./changes");

after(() => rmSync(scratch, { recursive: true, force: true }));

const HOMED = "019a0000-0000-7000-8000-00000000000a";
const OLD = "019a0000-0000-7000-8000-00000000000b";
const WORKER = "019a0000-0000-7000-8000-00000000000c";
const state = join(scratch, "agent", "sova");
const doc = (name: string) => join(process.env.SOVA_CHAT_HOMES!, HOMED, "chat", `${name}.json`);
const json = (f: string) => JSON.parse(readFileSync(f, "utf8"));
/** The line another process appends after its write (server/chat-homes/changes.ts), with a pid not ours. */
const otherProcessLine = (h: string, d: string) => appendFileSync(segmentFile(process.env.SOVA_CHAT_HOMES!, segments(process.env.SOVA_CHAT_HOMES!).at(-1) ?? 1), `${JSON.stringify({ h, d, g: 1, p: process.pid + 1 })}\n`);

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
  // And the other way round: their change, told by its line in the change log, shows here at the next look.
  meta["session-titles.json#titles"] = { ...after, [OTHER]: { title: "Theirs, renamed", by: "user", at: 2 } };
  writeFileSync(doc("meta"), JSON.stringify(meta));
  otherProcessLine(HOMED, "meta");
  expireHomeRecordChecksForTest();
  assert.equal(readSessionTitles()[OTHER], "Theirs, renamed");
});

test("a write by rename that came with no line in the change log is seen by the backstop sweep, late but never lost", () => {
  setSessionTitle(HOMED, "Before");
  const meta = json(doc("meta"));
  meta["session-titles.json#titles"][HOMED] = { title: "Renamed in by hand", by: "user", at: 3 };
  writeFileSync(`${doc("meta")}.x`, JSON.stringify(meta));
  renameSync(`${doc("meta")}.x`, doc("meta"));
  // The log says nothing: a look at the log alone keeps what was read.
  expireHomeRecordChecksForTest();
  assert.equal(readSessionTitles()[HOMED], "Before");
  // The sweep (every BACKSTOP_MS) checks every home whatever the log says.
  expireHomeRecordSweepForTest();
  assert.equal(readSessionTitles()[HOMED], "Renamed in by hand");
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

test("a write after a home was removed never makes it again", () => {
  const GONE = "019a0000-0000-7000-8000-00000000000f";
  const home = ensureChatHome(GONE);
  setSessionTitle(GONE, "Before");
  forgetHome(GONE);
  forgetHomeRecords(GONE);
  rmSync(home, { recursive: true, force: true });
  setSessionTitle(GONE, "Late");
  markSeen(GONE, 99);
  assert.equal(existsSync(home), false);
});

test("a home that arrives from outside is seen by every store at once, memos included", () => {
  const MOVED = "019a0000-0000-7000-8000-0000000000b1";
  // Each store read once first, so each holds a memo that knows nothing of it.
  assert.equal(isArchived(MOVED), false);
  assert.equal(isWebSession(MOVED), false);
  assert.equal(memoSessionTitles()[MOVED], undefined);
  assert.equal(readSeen()[MOVED], undefined);
  // Transport's publishing rename: the home appears with its records already in it.
  const home = ensureChatHome(MOVED);
  mkdirSync(join(home, "chat"), { recursive: true });
  writeFileSync(join(home, "chat", "meta.json"), JSON.stringify({ version: 1, id: MOVED, "archived-sessions.json": [MOVED], "web-sessions.json": [MOVED], "session-titles.json#titles": { [MOVED]: { title: "Moved here", by: "user", at: 1 } } }));
  writeFileSync(join(home, "chat", "seen.json"), JSON.stringify({ version: 1, id: MOVED, "seen.json": { [MOVED]: 42 } }));
  const before = homesGeneration();
  homeArrived(MOVED);
  assert.notEqual(homesGeneration(), before, "seen at once, inside the second the generation was last checked in");
  assert.equal(isArchived(MOVED), true);
  assert.equal(isWebSession(MOVED), true);
  assert.equal(memoSessionTitles()[MOVED], "Moved here");
  assert.equal(readSeen()[MOVED], 42);
});
