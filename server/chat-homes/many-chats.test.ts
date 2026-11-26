// What many homes cost (§app.chat-homes/change-log): a "not a home" answer is kept until something says otherwise, the
// open-record indexes read only the home that changed, and an archived chat's helpers are read when first asked about.
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

const scratch = mkdtempSync(join(tmpdir(), "sova-many-chats-"));
process.env.PI_CODING_AGENT_DIR = join(scratch, "agent");
process.env.SOVA_CHAT_HOMES = join(scratch, "homes");
const HOMES = process.env.SOVA_CHAT_HOMES;
after(() => rmSync(scratch, { recursive: true, force: true }));

const { ensureChatHome, hasHome, homeIo, noteHomeArrived, sweepHomeNegatives } = await import("./root");
const { homeArrived, homeOf, resetHomeRecordsForTest } = await import("./records");
const { OpenRecordIndex, openIndexIo } = await import("./open-index");
const { pollChanges, segmentFile, segments } = await import("./changes");
const { setArchived } = await import("../archived-sessions");
const { WorkerRegistry } = await import("../chat-workers");
const { stateRoot } = await import("../state-root");

const id = (n: number) => `019a0000-0000-7000-8000-${String(n).padStart(12, "0")}`;
const manifest = (sid: string) => {
  mkdirSync(join(HOMES, sid, "sessions"), { recursive: true });
  writeFileSync(join(HOMES, sid, "home.json"), JSON.stringify({ v: 1, id: sid, stateRoot: stateRoot(), layout: 1, device: { id: "d", name: "d" }, createdAt: "" }));
};
const lineFromAnotherProcess = (h: string, d: string) => appendFileSync(segmentFile(HOMES, segments(HOMES).at(-1) ?? 1), `${JSON.stringify({ h, d, g: 1, p: process.pid + 1 })}\n`);

test("a 'not a home' answer is kept, and asked again when a line, an arrival or the sweep says so", () => {
  ensureChatHome(id(1)); // the homes root exists, so lines can be written
  const old = id(500);
  assert.equal(hasHome(old), false);
  const reads = homeIo.manifestReads;
  for (let i = 0; i < 5; i++) assert.equal(hasHome(old), false);
  assert.equal(homeIo.manifestReads, reads, "the negative answer is kept: no manifest read per ask");

  // Its home made by another process (a second server): told by its line.
  manifest(old);
  assert.equal(hasHome(old), false, "nothing said so yet");
  lineFromAnotherProcess(old, "home");
  pollChanges(HOMES);
  assert.equal(hasHome(old), true);

  // A Transport's arrival says so itself.
  const arrived = id(501);
  assert.equal(hasHome(arrived), false);
  manifest(arrived);
  noteHomeArrived(arrived);
  assert.equal(hasHome(arrived), true);

  // A home copied in by hand, with no line: the backstop sweep asks again.
  const byHand = id(502);
  assert.equal(hasHome(byHand), false);
  manifest(byHand);
  assert.equal(hasHome(byHand), false);
  sweepHomeNegatives();
  assert.equal(hasHome(byHand), true);
});

test("the open-record index reads only the home whose generation moved, never every home again", () => {
  resetHomeRecordsForTest();
  for (let i = 10; i < 40; i++) ensureChatHome(id(i));
  const recFile = (h: string) => join(HOMES, h, "chat", "cards", `${h}.json`);
  const put = (h: string, open: boolean) => {
    mkdirSync(join(HOMES, h, "chat", "cards"), { recursive: true });
    writeFileSync(recFile(h), JSON.stringify({ open }));
  };
  const entryOf = (sid: string): string | undefined => {
    const h = homeOf(sid);
    try {
      return h && JSON.parse(readFileSync(recFile(h), "utf8")).open ? sid : undefined;
    } catch {
      return undefined;
    }
  };
  put(id(10), true);
  const idx = new OpenRecordIndex<string>("cards", () => join(scratch, "agent", "sova", "session-cards"), entryOf);
  assert.equal(idx.get(id(10)), id(10));
  const full = openIndexIo.full;
  const homes = openIndexIo.homes;

  // A record placed in an untouched home with nothing said: the index stands (the old index re-read every home here).
  put(id(11), true);
  // A home arrived (a Transport): only that home's folder is read again.
  const arrived = id(41);
  manifest(arrived);
  put(arrived, true);
  homeArrived(arrived);
  assert.equal(idx.get(arrived), arrived, "the arrived home's open record is listed");
  assert.equal(idx.get(id(11)), undefined, "an untouched home is not read again");
  assert.equal(openIndexIo.full, full, "no full rebuild");
  assert.equal(openIndexIo.homes, homes + 1, "one home's folder read");

  // Another process wrote that home's cards: its line moves that home alone.
  lineFromAnotherProcess(id(11), "cards");
  pollChanges(HOMES);
  assert.equal(idx.get(id(11)), id(11));
  put(id(10), false);
  lineFromAnotherProcess(id(10), "cards");
  pollChanges(HOMES);
  assert.equal(idx.get(id(10)), undefined, "a record no longer open leaves the index");
  assert.equal(openIndexIo.full, full);
});

test("an archived chat's finished helpers are read when first asked about, not at the start", () => {
  const parent = id(60);
  ensureChatHome(parent);
  setArchived(parent, true);
  const helper = id(61);
  const home = join(HOMES, parent);
  mkdirSync(join(home, "workers"), { recursive: true });
  const rec = (workerId: string) => ({ v: 1, chatId: helper, path: join(home, "sessions", `x_${helper}.jsonl`), key: `${parent}:${workerId}:1`, kind: "worker", parent: { sessionId: parent, path: join(home, "sessions", `x_${parent}.jsonl`), workerId }, spec: { kind: "worker", parent: { sessionId: parent, path: "", workerId }, cwd: scratch }, state: "ended", startedAt: new Date(0).toISOString() });
  writeFileSync(join(home, "workers", `${helper}.json`), JSON.stringify(rec("ag_01")));
  resetHomeRecordsForTest();
  const reg = new WorkerRegistry({ start: async () => { throw new Error("no process here"); }, stop: async () => {} });
  assert.equal(homeOf(helper), parent, "its home is known from its name alone");
  // Changed on disk after the start: a record read at the start would still say ag_01.
  writeFileSync(join(home, "workers", `${helper}.json`), JSON.stringify(rec("ag_02")));
  assert.equal(reg.record(helper)?.parent.workerId, "ag_02", "read when first asked about");
  assert.deepEqual(reg.chatsOf(parent), [helper]);
});
