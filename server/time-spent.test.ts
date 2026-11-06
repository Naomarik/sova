// Run: node scripts/run-tests.mjs server/time-spent.test.ts. Time Spent's record
// (§app.subagents-pane/time-spent-record, /time-spent-counting): the one clock per computer, the file
// beside the session, the agent's time over the whole branch, the routes through the app built
// in-process. A throwaway PI_CODING_AGENT_DIR in the OS temp dir; ~/.pi untouched.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import type { HEntry } from "../shared/harness";
import type { AlignDocInfo, TranscriptItem } from "../shared/protocol";
import type { TimeSpentRecord, TimeSpentRow, TimeSpentSlice } from "../shared/time-spent";
import { TIME_SPENT_MAX_BODY_BYTES, TIME_SPENT_MAX_DOCS, TIME_SPENT_MAX_SLICES } from "../shared/time-spent";

const agentDir = realpathSync(mkdtempSync(join(tmpdir(), "sova-time-spent-")));
process.env.PI_CODING_AGENT_DIR = agentDir;
const sessionsDir = join(agentDir, "sessions", "--tmp-time-spent--");
mkdirSync(sessionsDir, { recursive: true });
mkdirSync(join(agentDir, "sessions", "live"), { recursive: true });

const { CLOCK_MEMORY_MS, TimeSpentStore, timeSpentStore } = await import("./time-spent");
const { agentFigures, agentSpans, alignFacts, readingSeconds } = await import("./time-spent-figures");
const { parseTimeSpentReport } = await import("./time-spent-routes");
const { buildApp } = await import("./app");
const { app } = buildApp({ extensionEntriesOf: async () => [] });
const { archiveSession, cleanupSessions } = await import("./sessions-index");
const { setArchived } = await import("./archived-sessions");
const { addWebSession } = await import("./web-sessions");
const { canonicalPath } = await import("./paths");

after(() => rmSync(agentDir, { recursive: true, force: true }));

const NOW = Date.parse("2026-11-07T12:00:00.000Z");
let stores = 0;
const freshStore = () => new TimeSpentStore(join(agentDir, `clock-${++stores}`));
const slice = (row: TimeSpentRow, sec: number, ageMs = 0, docs: string[] = []): TimeSpentSlice => ({ row, sec, ageMs, docs });
const rowsSum = (rows: Partial<Record<TimeSpentRow, number>>) => Object.values(rows).reduce((a, b) => a + b, 0);

describe("one clock per computer", () => {
  test("two pages reporting one moment count it once, for the newest input, and the rows add up", () => {
    const s = freshStore();
    // Each page's own clock is hours off the other's, and what it thinks the time is rides along (the page's ledger
    // keeps `endAt` on its clock): the seconds still land on this computer's time, so they are one moment.
    const skewed = (clock: number) => ({ sentAt: clock, nowMs: clock, endAt: clock });
    s.report("one", { pageId: "desktop", inputAgeMs: 9_000, ...skewed(NOW - 3 * 3_600_000), slices: [{ ...slice("reading-transcript", 15), ...skewed(NOW - 3 * 3_600_000) }] }, NOW);
    s.report("one", { pageId: "phone", inputAgeMs: 1_000, ...skewed(NOW + 2 * 3_600_000), slices: [{ ...slice("typing", 15, 1_000), ...skewed(NOW + 2 * 3_600_000) }] }, NOW + 1_000);
    const sums = s.sums("one");
    assert.equal(sums.you, 15, "the same 15 seconds, once");
    assert.equal(rowsSum(sums.rows), sums.you);
    assert.deepEqual(sums.rows, { typing: 15 }, "the phone's input is the newer");
  });

  test("the answer doesn't depend on which report arrived first", () => {
    const newerFirst = freshStore();
    newerFirst.report("one", { pageId: "phone", inputAgeMs: 1_000, slices: [slice("typing", 15)] }, NOW);
    newerFirst.report("one", { pageId: "desktop", inputAgeMs: 9_000, slices: [slice("reading-transcript", 15, 1_000)] }, NOW + 1_000);
    assert.deepEqual(newerFirst.sums("one").rows, { typing: 15 });
  });

  test("a page with an older input keeps only the seconds nobody else reported", () => {
    const s = freshStore();
    s.report("one", { pageId: "phone", inputAgeMs: 500, slices: [slice("typing", 10)] }, NOW);
    // 20 seconds ending now: the first 10 are its own, the last 10 are the phone's.
    s.report("one", { pageId: "desktop", inputAgeMs: 30_000, slices: [slice("scrolling", 20)] }, NOW);
    const sums = s.sums("one");
    assert.deepEqual(sums.rows, { typing: 10, scrolling: 10 });
    assert.equal(sums.you, 20);
  });

  test("devices on two sessions add one second between them, for the session of the newest input", () => {
    const s = freshStore();
    s.report("a", { pageId: "desktop", inputAgeMs: 8_000, slices: [slice("reading-transcript", 15)] }, NOW);
    s.report("b", { pageId: "phone", inputAgeMs: 200, slices: [slice("typing", 15)] }, NOW);
    assert.equal(s.sums("a").you + s.sums("b").you, 15);
    assert.equal(s.sums("a").you, 0, "the older input's seconds are taken back from its session");
    assert.equal(s.sums("b").you, 15);
  });

  test("a second computer has its own clock and counts the same moment for itself", () => {
    const here = freshStore();
    const there = freshStore();
    here.report("a", { pageId: "desktop", inputAgeMs: 100, slices: [slice("typing", 15)] }, NOW);
    there.report("b", { pageId: "desktop", inputAgeMs: 100, slices: [slice("typing", 15)] }, NOW);
    assert.equal(here.sums("a").you, 15);
    assert.equal(there.sums("b").you, 15, "no moment is shared across computers");
  });

  test("a page's run landing a second off its last one neither loses nor doubles it", () => {
    const s = freshStore();
    s.report("one", { pageId: "p", inputAgeMs: 0, slices: [slice("typing", 15)] }, NOW);
    s.report("one", { pageId: "p", inputAgeMs: 0, slices: [slice("typing", 15)] }, NOW + 14_000);
    s.report("one", { pageId: "p", inputAgeMs: 0, slices: [slice("typing", 15)] }, NOW + 31_000);
    assert.equal(s.sums("one").you, 45);
  });

  test("a report sent again after its answer was lost adds nothing", () => {
    const s = freshStore();
    s.report("one", { pageId: "p", inputAgeMs: 0, slices: [slice("typing", 15)] }, NOW);
    s.report("one", { pageId: "p", inputAgeMs: 20_000, slices: [slice("typing", 15, 20_000)] }, NOW + 20_000);
    assert.equal(s.sums("one").you, 15);
  });

  test("a run older than the clock remembers is dropped, not counted a second time", () => {
    const s = freshStore();
    const tooOld = CLOCK_MEMORY_MS + 60_000;
    s.report("one", { pageId: "p", inputAgeMs: tooOld, slices: [slice("typing", 15, tooOld)] }, NOW);
    assert.equal(s.sums("one").you, 0);
    const old = CLOCK_MEMORY_MS - 60_000;
    s.report("one", { pageId: "p", inputAgeMs: old, slices: [slice("typing", 15, old)] }, NOW);
    assert.equal(s.sums("one").you, 15, "an old one within it still counts");
  });
});

describe("the file", () => {
  test("adjacent identical runs are one line; a change of row or document is a new one", () => {
    const s = freshStore();
    for (let i = 0; i < 40; i++) s.report("one", { pageId: "p", inputAgeMs: 0, slices: [slice("typing", 15, 0, ["al_1"])] }, NOW + i * 15_000);
    const file = join(s.dir, "one.jsonl");
    assert.equal(readFileSync(file, "utf8").trim().split("\n").length, 1);
    assert.equal(s.sums("one").you, 600);
    s.report("one", { pageId: "p", inputAgeMs: 0, slices: [slice("typing", 15, 0, ["al_2"])] }, NOW + 40 * 15_000);
    assert.equal(readFileSync(file, "utf8").trim().split("\n").length, 2);
  });

  test("ten busy hours stay small", () => {
    const s = freshStore();
    const rows: TimeSpentRow[] = ["typing", "reading-transcript"];
    for (let i = 0; i < 2400; i++) s.report("one", { pageId: "p", inputAgeMs: 0, slices: [slice(rows[Math.floor(i / 8) % 2]!, 15)] }, NOW + i * 15_000);
    assert.equal(s.sums("one").you, 36_000);
    assert.ok(statSync(join(s.dir, "one.jsonl")).size < 100 * 1024);
  });

  test("a torn line counts for nothing, and the rest still sums", () => {
    const s = freshStore();
    s.report("one", { pageId: "p", inputAgeMs: 0, slices: [slice("typing", 15)] }, NOW);
    writeFileSync(join(s.dir, "one.jsonl"), `${readFileSync(join(s.dir, "one.jsonl"), "utf8")}{"s":17300`);
    assert.equal(s.sums("one").you, 15);
  });

  test("a document's on-screen seconds overlap the rows, and it keeps its first moment", () => {
    const s = freshStore();
    s.report("one", { pageId: "p", inputAgeMs: 0, slices: [slice("typing", 10, 20_000, ["al_1"]), slice("reading-alignments", 5, 0, ["al_1", "al_2"])] }, NOW);
    const sums = s.sums("one");
    assert.equal(sums.you, 15);
    assert.deepEqual(sums.rows, { typing: 10, "reading-alignments": 5 });
    assert.equal(sums.docs.get("al_1")!.onScreen, 15);
    assert.equal(sums.docs.get("al_2")!.onScreen, 5);
    assert.equal(sums.docs.get("al_1")!.firstShownAt, (Math.round((NOW - 20_000) / 1000) - 10) * 1000);
  });

  test("a session id that isn't a file name writes nothing", () => {
    const s = freshStore();
    s.report("../escape", { pageId: "p", inputAgeMs: 0, slices: [slice("typing", 15)] }, NOW);
    assert.equal(existsSync(join(s.dir, "..", "escape.jsonl")), false);
    assert.equal(s.sums("../escape").you, 0);
  });
});

const at = (sec: number) => new Date(NOW + sec * 1000).toISOString();
const user = (sec: number): HEntry => ({ kind: "user", id: `u${sec}`, parentId: null, at: at(sec), blocks: [] });
const reply = (sec: number, stop: string): HEntry => ({ kind: "assistant", id: `a${sec}`, parentId: null, at: at(sec), blocks: [], stop });
const tool = (sec: number): HEntry => ({ kind: "tool-result", id: `t${sec}`, parentId: null, at: at(sec), blocks: [] });
const note = (sec: number): HEntry => ({ kind: "note", id: `n${sec}`, parentId: null, at: at(sec), content: "", display: true, inMessage: true });

describe("the agent's time", () => {
  const agent = (branch: HEntry[]) => agentFigures(agentSpans(branch), false, NOW + 1e7);

  test("a turn runs from what started it to the agent's last entry; time between turns isn't its", () => {
    assert.equal(agent([user(0), reply(5, "toolUse"), tool(9), reply(12, "stop"), user(1000), reply(1003, "stop")]).agent, 15);
  });
  test("a worker's report starting a turn long after doesn't stretch the last turn", () => {
    assert.equal(agent([user(0), reply(10, "stop"), note(5000), reply(5020, "stop")]).agent, 30);
  });
  test("a turn that died with its process ends at its last entry, not at the next message", () => {
    assert.equal(agent([user(0), reply(5, "toolUse"), user(9000), reply(9002, "stop")]).agent, 7);
  });
  test("a retry after an error is the same turn", () => {
    assert.equal(agent([user(0), reply(5, "error"), reply(20, "stop")]).agent, 20);
  });
  test("a running turn counts up to now and says how much of the figure it is", () => {
    const f = agentFigures(agentSpans([user(0), reply(10, "stop"), user(100), reply(105, "toolUse")]), true, NOW + 130_000);
    assert.deepEqual(f, { agent: 40, agentRunning: 30 });
  });
  test("with nothing running, an open turn stops at its last entry", () => {
    assert.deepEqual(agentFigures(agentSpans([user(100), reply(105, "toolUse")]), false, NOW + 999_000), { agent: 5, agentRunning: null });
  });
});

const doc = (id: string, over: Partial<AlignDocInfo> = {}): AlignDocInfo => ({
  id,
  title: "A title",
  summary: "A summary.",
  findings: [],
  approach: [],
  rejected: [],
  questions: [],
  phase: "open",
  next: { f: 1, a: 1, x: 1, q: 1 },
  rev: 1,
  createdAt: at(0),
  updatedAt: at(0),
  ...over,
} as AlignDocInfo);
const question = (id: string, decided: boolean) => ({ id, topic: "t", ask: "a", recommendation: { choice: "c", why: "w" }, ...(decided ? { decision: { text: "d", by: "user" as const, at: at(0) } } : {}) });
const alignRow = (d: AlignDocInfo, sec: number): TranscriptItem => ({ id: `r${sec}`, kind: "align", at: at(sec), align: { v: 1, doc: d, changes: [], line: "" } }) as TranscriptItem;

describe("alignment facts", () => {
  test("one line per document across revisions, with the newest words", () => {
    const facts = alignFacts([alignRow(doc("al_1", { title: "Old" }), 0), alignRow(doc("al_2"), 1), alignRow(doc("al_1", { title: "New", rev: 2 }), 2)]);
    assert.deepEqual(facts.map((f) => [f.docId, f.title]), [["al_1", "New"], ["al_2", "A title"]]);
  });
  test("decided at the revision that settled the last question; a later revision doesn't move it, reopening clears it", () => {
    const open = doc("al_1", { questions: [question("q1", true), question("q2", false)] as never });
    const settled = doc("al_1", { questions: [question("q1", true), question("q2", true)] as never });
    assert.equal(alignFacts([alignRow(open, 0)])[0]!.decidedAt, null);
    assert.equal(alignFacts([alignRow(open, 0), alignRow(settled, 50), alignRow(settled, 90)])[0]!.decidedAt, NOW + 50_000);
    assert.equal(alignFacts([alignRow(settled, 50), alignRow(open, 60)])[0]!.decidedAt, null);
  });
  test("no questions: none", () => assert.equal(alignFacts([alignRow(doc("al_1"), 0)])[0]!.decidedAt, null));
  test("reading time is about 250 words a minute", () => {
    assert.equal(readingSeconds(doc("al_1", { title: "", summary: Array(500).fill("word").join(" ") })), 120);
  });
});

describe("the report's limits", () => {
  const good = { pageId: "p", path: "/x.jsonl", inputAgeMs: 0, slices: [slice("typing", 1)] };
  test("a good one passes", () => assert.deepEqual(parseTimeSpentReport(good), good));
  test("a page's own idea of the time doesn't get past the door", () => {
    const skewed = { ...good, sentAt: 1, slices: [{ ...good.slices[0], endAt: 1 }] };
    assert.deepEqual(parseTimeSpentReport(skewed), good);
  });
  for (const [name, bad] of Object.entries({
    "an unknown row": { ...good, slices: [slice("playing" as TimeSpentRow, 1)] },
    "a fractional second": { ...good, slices: [slice("typing", 1.5)] },
    "no seconds": { ...good, slices: [slice("typing", 0)] },
    "a negative age": { ...good, slices: [slice("typing", 1, -1)] },
    "too many slices": { ...good, slices: Array(TIME_SPENT_MAX_SLICES + 1).fill(slice("typing", 1)) },
    "too many documents": { ...good, slices: [slice("typing", 1, 0, Array(TIME_SPENT_MAX_DOCS + 1).fill("al_1"))] },
    "a page id too long": { ...good, pageId: "p".repeat(129) },
    "no page id": { ...good, pageId: "" },
  })) test(`refuses ${name}`, () => assert.equal(parseTimeSpentReport(bad), null));
});

// ---- through the routes, on real files ----------------------------------------------------------

const T0 = Date.now() - 3_600_000;
const iso = (ms: number) => new Date(ms).toISOString();

function sessionFile(id: string, lines: unknown[], began = T0): string {
  const path = join(sessionsDir, `2026-11-07T00-00-00-000Z_${id}.jsonl`);
  writeFileSync(path, [{ type: "session", version: 3, id, timestamp: iso(began), cwd: "/tmp" }, ...lines].map((l) => JSON.stringify(l)).join("\n") + "\n");
  return canonicalPath(path);
}
const postReport = (body: unknown) => app.request("/api/time-spent/report", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
async function read(path: string): Promise<TimeSpentRecord> {
  const res = await app.request(`/api/time-spent?path=${encodeURIComponent(path)}`);
  assert.equal(res.status, 200);
  return (await res.json()) as TimeSpentRecord;
}

describe("the routes", () => {
  test("Agent is the whole file's sum, on a transcript far longer than one page's tail", async () => {
    const lines: unknown[] = [];
    let parent: string | null = null;
    const push = (e: Record<string, unknown>, ms: number) => {
      lines.push({ ...e, parentId: parent, timestamp: iso(ms) });
      parent = e.id as string;
    };
    let expected = 0;
    // 200 turns of ~8 KB: well past the tail a page loads first (TAIL_CHARS), each its own length.
    for (let i = 0; i < 200; i++) {
      const start = T0 + i * 10_000;
      const took = 1 + (i % 7);
      expected += took;
      push({ type: "message", id: `u${i}`, message: { role: "user", content: [{ type: "text", text: `ask ${"q".repeat(4000)}` }], timestamp: 0 } }, start);
      push({ type: "message", id: `a${i}`, message: { role: "assistant", content: [{ type: "text", text: `answer ${"a".repeat(4000)}` }], provider: "anthropic", model: "m", api: "anthropic-messages", stopReason: "stop", timestamp: 0 } }, start + took * 1000);
    }
    const { TAIL_CHARS } = await import("./tail-hello");
    const path = sessionFile("long", lines);
    assert.ok(statSync(path).size > TAIL_CHARS * 2, "the file must be longer than what a page loads first");
    const res = await read(path);
    assert.equal(res.agent, expected);
    assert.equal(res.agentRunning, null);
  });

  test("a report lands in the record, never in the session's file, and reads back", async () => {
    const path = sessionFile("reported", []);
    const before = readFileSync(path, "utf8");
    const res = await postReport({ pageId: "route-page", path, inputAgeMs: 0, slices: [slice("typing", 15), slice("reading-alignments", 5, 0, ["al_1"])] });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true });
    assert.equal(readFileSync(path, "utf8"), before);
    assert.ok(existsSync(join(agentDir, "sova", "attention", "reported.jsonl")));
    const r = await read(path);
    assert.ok(r.you > 0);
    assert.equal(r.you, rowsSum(r.rows));
  });

  test("an alignment on the branch reads with its on-screen time and its time to decided", async () => {
    const shownAgo = 600_000;
    const decidedAgo = 300_000;
    const settled = { ...doc("al_9", { title: "The plan", questions: [question("q1", true)] as never }) };
    const path = sessionFile("aligned", [
      { type: "message", id: "u", parentId: null, timestamp: iso(Date.now() - 900_000), message: { role: "user", content: "go" } },
      { type: "message", id: "c", parentId: "u", timestamp: iso(Date.now() - decidedAgo), message: { role: "assistant", content: [{ type: "toolCall", id: "t1", name: "align", arguments: {} }], stopReason: "toolUse" } },
      { type: "message", id: "r", parentId: "c", timestamp: iso(Date.now() - decidedAgo), message: { role: "toolResult", toolCallId: "t1", toolName: "align", content: [{ type: "text", text: "ok" }], details: { v: 1, doc: settled, changes: [], line: "x" }, isError: false } },
    ]);
    await postReport({ pageId: "align-page", path, inputAgeMs: shownAgo, slices: [slice("reading-alignments", 30, shownAgo, ["al_9"])] });
    const r = await read(path);
    assert.equal(r.alignments.length, 1);
    const a = r.alignments[0]!;
    assert.equal(a.title, "The plan");
    assert.equal(a.onScreen, 30);
    assert.ok(a.firstShownAt !== null);
    // Shown 30 seconds before the moment the slice ends, so about 330 seconds before the decision.
    assert.ok(Math.abs(a.toDecided! - 330) <= 2, `toDecided ${a.toDecided}`);
  });

  test("a fork's record starts from zero, while its Agent covers the turns its branch copied", async () => {
    const started = Date.now() + 1000;
    const copied = [
      { type: "message", id: "u", parentId: null, timestamp: iso(T0), message: { role: "user", content: "go" } },
      { type: "message", id: "a", parentId: "u", timestamp: iso(T0 + 40_000), message: { role: "assistant", content: [{ type: "text", text: "done" }], stopReason: "stop" } },
    ];
    const parent = sessionFile("fork-parent", copied);
    await postReport({ pageId: "fork-page", path: parent, inputAgeMs: 1_000_000, slices: [slice("typing", 9, 1_000_000)] });
    assert.equal((await read(parent)).you, 9);
    const fork = sessionFile("fork-child", copied, started);
    const r = await read(fork);
    assert.equal(r.you, 0);
    assert.equal(r.older, false);
    assert.equal(r.agent, 40);
  });

  test("a session older than the record says so; a new one doesn't", async () => {
    const older = sessionFile("older", [], timeSpentStore().since() - 86_400_000);
    assert.equal((await read(older)).older, true);
    const fresh = sessionFile("fresh", [], Date.now() + 1000);
    assert.equal((await read(fresh)).older, false);
    assert.equal((await read(fresh)).you, 0);
  });

  test("a bad path is 400, a gone file 404 on read, and a report for a gone file keeps nothing", async () => {
    assert.equal((await app.request("/api/time-spent?path=/etc/passwd")).status, 400);
    const gone = join(sessionsDir, "2026-11-07T00-00-00-000Z_gone.jsonl");
    assert.equal((await app.request(`/api/time-spent?path=${encodeURIComponent(gone)}`)).status, 404);
    assert.equal((await postReport({ pageId: "p", path: gone, inputAgeMs: 0, slices: [slice("typing", 1)] })).status, 200);
    assert.equal(existsSync(join(agentDir, "sova", "attention", "gone.jsonl")), false);
    assert.equal((await postReport({ pageId: "p", path: "/etc/passwd", inputAgeMs: 0, slices: [] })).status, 400);
  });

  test("a report past the size limit is refused as a bad request, never as a refusal", async () => {
    const res = await app.request("/api/time-spent/report", { method: "POST", headers: { "content-type": "application/json" }, body: "x".repeat(TIME_SPENT_MAX_BODY_BYTES + 1) });
    assert.equal(res.status, 400);
  });
});

describe("kept until the session is deleted", () => {
  const recordOf = (id: string) => join(agentDir, "sova", "attention", `${id}.jsonl`);
  function recorded(id: string, lines: unknown[] = [{ type: "message", id: "m1", parentId: null, timestamp: iso(T0), message: { role: "user", content: "hi" } }]): string {
    const path = sessionFile(id, lines);
    const old = new Date(Date.now() - 40 * 86_400_000);
    utimesSync(path, old, old);
    addWebSession(id);
    return path;
  }
  // Each its own moment: these all share this computer's clock, and two reports of one moment count once.
  let moments = 0;
  const report = async (path: string) => {
    const ageMs = 60_000 + 10_000 * moments++;
    assert.equal((await postReport({ pageId: `page-${moments}`, path, inputAgeMs: ageMs, slices: [slice("typing", 3, ageMs)] })).status, 200);
    return path;
  };

  test("archiving keeps it", async () => {
    const path = recorded("del-archive");
    await report(path);
    assert.ok((await archiveSession(path, true)).ok);
    assert.ok(existsSync(recordOf("del-archive")));
  });
  test("Clean Up of a named session removes it", async () => {
    const path = recorded("del-paths");
    await report(path);
    setArchived("del-paths", true);
    assert.equal((await cleanupSessions({ mode: "paths", paths: [path], dryRun: false })).deletedCount, 1);
    assert.equal(existsSync(recordOf("del-paths")), false);
  });
  test("Clean Up by age removes it, and a dry run doesn't", async () => {
    const path = recorded("del-age");
    await report(path);
    await cleanupSessions({ mode: "age", minAgeDays: 30, dryRun: true });
    assert.ok(existsSync(recordOf("del-age")));
    await cleanupSessions({ mode: "age", minAgeDays: 30, dryRun: false });
    assert.equal(existsSync(path), false);
    assert.equal(existsSync(recordOf("del-age")), false);
  });
  test("an empty husk deleted by archiving removes it", async () => {
    const path = recorded("del-husk", []);
    await report(path);
    const r = await archiveSession(path, true);
    assert.ok(r.ok && r.summary.deleted);
    assert.equal(existsSync(recordOf("del-husk")), false);
  });
  test("an open page's next report doesn't bring it back", async () => {
    const path = recorded("del-late");
    await report(path);
    setArchived("del-late", true);
    await cleanupSessions({ mode: "paths", paths: [path], dryRun: false });
    await report(path);
    assert.equal(existsSync(recordOf("del-late")), false);
  });
});
