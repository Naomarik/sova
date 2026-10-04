// Run: npx tsx --test server/align-state.test.ts
// Uses a throwaway PI_CODING_AGENT_DIR in the OS temp dir; ~/.pi is never read or written.
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";

const agentDir = mkdtempSync(join(tmpdir(), "sova-align-test-"));
process.env.PI_CODING_AGENT_DIR = agentDir; // before the modules below compute their paths
const sessionsDir = join(agentDir, "sessions", "--tmp-align-test--");
mkdirSync(sessionsDir, { recursive: true });
after(() => rmSync(agentDir, { recursive: true, force: true }));

const { applyAlignCall } = await import("../pi-config/extensions/mode/align.ts");
const { entryOf, normalizeEntries, normalizeEntry } = await import("./transcript");
const { readAlignScan, sessionAlignOf } = await import("./align-state");
const { getSessionSummary } = await import("./sessions-index");
const { canonicalPath } = await import("./paths");

type AlignDocument = import("../pi-config/extensions/mode/align.ts").AlignDocument;
type AlignDetails = import("../pi-config/extensions/mode/align.ts").AlignDetails;

const env = { now: "2026-09-28T10:00:00.000Z", readFile: () => "" };
const Q = (topic: string) => ({ topic, ask: `${topic}?`, recommendation: { choice: "yes", why: "simpler" } });

/** The details a sequence of calls returns, in order, like a branch of tool results. */
function calls(list: unknown[]): AlignDetails[] {
  let docs: AlignDocument[] = [];
  return list.map((call) => {
    const { details } = applyAlignCall(docs, call, env);
    if (details.doc) docs = [...docs.filter((d) => d.id !== details.doc!.id), details.doc];
    return details;
  });
}

let seq = 0;
/** A tool result entry for `details` (JSON round-tripped, as it is on disk), chained after `parentId`. */
function result(details: unknown, parentId: string | null, over: Record<string, unknown> = {}) {
  const id = `r${++seq}`;
  return {
    type: "message",
    id,
    parentId,
    timestamp: env.now,
    message: { role: "toolResult", toolCallId: `c${id}`, toolName: "align", content: [{ type: "text", text: "echo" }], details: JSON.parse(JSON.stringify(details)), isError: false, ...over },
  };
}

const [created, second, answered, finished] = calls([
  { ops: [{ op: "create", title: "Export", summary: "Download a session.", questions: [Q("Format"), Q("Zip")] }] },
  { ops: [{ op: "create", title: "Pane", summary: "Show workers.", questions: [Q("Cap")] }] },
  { doc: "al_1", ops: [{ op: "decide", q: "q1", decision: "JSONL" }] },
  { doc: "al_2", ops: [{ op: "accept_all" }, { op: "status", to: "done" }] },
]) as [AlignDetails, AlignDetails, AlignDetails, AlignDetails];

describe("transcript: an align tool result is its own row", () => {
  test("a changing call: kind align, the checked details, paired with its call by toolCallId", () => {
    const [row, ...rest] = normalizeEntry(result(created, null));
    assert.equal(rest.length, 0);
    assert.equal(row!.kind, "align");
    assert.equal(row!.toolCallId, (entryOf(row!) as any).message.toolCallId);
    assert.equal(row!.align?.doc?.id, "al_1");
    assert.equal(row!.align?.line, "created");
    assert.deepEqual(row!.align, created);
  });

  test("an exemption is a row too; a get, a failed call and unreadable details stay plain tool results", () => {
    const exempt = applyAlignCall([], { ops: [{ op: "exempt", reason: "a question, no change" }] }, env).details;
    assert.equal(normalizeEntry(result(exempt, null))[0]!.align?.exempt?.why, "a question, no change");
    const get = applyAlignCall([created.doc!], { ops: [{ op: "get" }] }, env).details;
    for (const entry of [
      result(get, null),
      result(created, null, { isError: true }),
      result({ ...created, v: 9 }, null),
      result({ ...created, doc: { ...created.doc, questions: "none" } }, null),
      result(created, null, { toolName: "bash" }),
    ]) {
      const [row] = normalizeEntry(entry);
      assert.equal(row!.kind, "tool-result", JSON.stringify((entry.message as any).details).slice(0, 60));
      assert.equal(row!.align, undefined);
    }
  });

  test("every revision of a document is a row (unlike an older session's align-doc, where only the newest renders)", () => {
    const a = result(created, null);
    const b = result(answered, a.id);
    const legacy = (id: string, revision: number) => ({ type: "custom", id, parentId: null, customType: "align-doc", data: { version: 1, doc: { version: 1, title: "Old", markdown: "## Alignment: Old", questions: [], revision, capturedAt: env.now } } });
    const rows = normalizeEntries([legacy("l1", 1), a, b, legacy("l2", 2)]);
    assert.deepEqual(rows.map((r) => `${r.kind}:${r.align?.doc?.rev ?? r.report?.align?.revision}`), ["align:1", "align:2", "report:2"]);
  });
});

describe("sessionAlignOf: the session list's counts", () => {
  test("open documents, their open questions, the documents that ask, and the last-touched of those", () => {
    const docs = [answered.doc!, second.doc!];
    assert.deepEqual(sessionAlignOf(docs), { openDocs: 2, openQuestions: 2, questionDocs: 2, lead: { id: "al_2", title: "Pane" } });
    assert.deepEqual(sessionAlignOf([answered.doc!, finished.doc!]), { openDocs: 1, openQuestions: 1, questionDocs: 1, lead: { id: "al_1", title: "Export" } });
    assert.equal(sessionAlignOf([finished.doc!]), undefined, "nothing open: no field");
    const confirmed = calls([
      { ops: [{ op: "create", title: "C", summary: "s", questions: [Q("x")] }] },
      { ops: [{ op: "accept_all" }] },
    ])[1]!.doc!;
    assert.deepEqual(sessionAlignOf([confirmed]), { openDocs: 1, openQuestions: 0, questionDocs: 0 }, "open but asking nothing: no lead");
  });
});

/** A session file: header, a first user message, then `lines`. */
function session(name: string, lines: unknown[]): string {
  const path = join(sessionsDir, `2026-09-28T00-00-00-000Z_${name}.jsonl`);
  const all = [
    { type: "session", version: 3, id: name, timestamp: env.now, cwd: "/tmp" },
    { type: "message", id: "u1", parentId: null, message: { role: "user", content: "hello" } },
    ...lines,
  ];
  writeFileSync(path, all.map((l) => JSON.stringify(l)).join("\n") + "\n");
  return canonicalPath(path);
}

describe("readAlignScan: the file's open alignments, cheaply", () => {
  test("a file with no align result is never parsed: no marker, no summary", async () => {
    const path = session("plain", [{ type: "message", id: "a1", parentId: "u1", message: { role: "assistant", content: "the word align, and \"toolName\": \"bash\"" } }]);
    const size = readFileSync(path).length;
    assert.deepEqual(await readAlignScan(path, size, null), { size, found: false, summary: undefined });
  });

  test("folds the active branch: a rewind (a leaf back on an earlier entry) lands on the earlier state", async () => {
    const a = result(created, "u1");
    const b = result(second, a.id);
    const path = session("rewind", [a, b]);
    let scan = await readAlignScan(path, readFileSync(path).length, null);
    assert.deepEqual(scan.summary, { openDocs: 2, openQuestions: 3, questionDocs: 2, lead: { id: "al_2", title: "Pane" } });
    // Rewind to after `a`: a new leaf entry parented on it (what a sova-rewind marker does).
    appendFileSync(path, `${JSON.stringify({ type: "custom", id: "rw", parentId: a.id, customType: "sova-rewind", data: { targetId: a.id } })}\n`);
    scan = await readAlignScan(path, readFileSync(path).length, scan);
    assert.deepEqual(scan.summary, { openDocs: 1, openQuestions: 2, questionDocs: 1, lead: { id: "al_1", title: "Export" } });
  });

  test("the marker search resumes where it stopped while the file grows; a shrunk file is searched from the start", async () => {
    const path = session("grow", []);
    const empty = await readAlignScan(path, readFileSync(path).length, null);
    assert.equal(empty.found, false);
    appendFileSync(path, `${JSON.stringify(result(created, "u1"))}\n`);
    const grown = await readAlignScan(path, readFileSync(path).length, empty);
    assert.equal(grown.found, true);
    assert.equal(grown.summary?.openQuestions, 2);
    const smaller = session("grow", []);
    assert.equal((await readAlignScan(smaller, readFileSync(smaller).length, grown)).found, false, "shrunk: not carried");
    assert.deepEqual(await readAlignScan(join(sessionsDir, "missing.jsonl"), 10, null), { size: 10, found: false, summary: undefined });
  });
});

describe("readAlignScan: incremental while the file grows", () => {
  const line = (e: unknown) => `${JSON.stringify(e)}\n`;
  const fresh = async (path: string) => (await readAlignScan(path, readFileSync(path).length, null)).summary;

  test("each growth parses only the new lines, reuses the kept entries, and equals a full read", async () => {
    const a = result(created, "u1");
    const path = session("incremental", [a]);
    let scan = await readAlignScan(path, readFileSync(path).length, null);
    const kept = scan.entries;
    assert.deepEqual(kept?.map((e) => e.type), ["session", "message", "message"], "header, user prompt, align result: kept compact");
    const b = result(second, a.id);
    const c = result(answered, b.id);
    // A line written in two parts: the half-written one is left for the next read.
    const half = line(b).slice(0, 40);
    appendFileSync(path, half);
    scan = await readAlignScan(path, readFileSync(path).length, scan);
    assert.equal(scan.entries, kept, "the same list, appended to, never rebuilt");
    assert.equal(scan.size, readFileSync(path).length - half.length, "the read stops at the last complete line");
    assert.deepEqual(scan.summary, await fresh(path));
    appendFileSync(path, line(b).slice(40) + line(c));
    scan = await readAlignScan(path, readFileSync(path).length, scan);
    assert.equal(scan.entries, kept);
    assert.deepEqual(scan.summary, await fresh(path), "incremental equals a full fold");
    assert.deepEqual(scan.summary, { openDocs: 2, openQuestions: 2, questionDocs: 2, lead: { id: "al_1", title: "Export" } });
  });

  test("a rewrite that moves the line boundary is read again from the start", async () => {
    const a = result(created, "u1");
    const path = session("rewrite", [a]);
    const scan = await readAlignScan(path, readFileSync(path).length, null);
    // Same bytes shifted by one: the last read's end is no longer a line start.
    writeFileSync(path, ` ${readFileSync(path, "utf8")}`);
    const again = await readAlignScan(path, readFileSync(path).length, scan);
    assert.notEqual(again.entries, scan.entries, "rebuilt");
    assert.deepEqual(again.summary, await fresh(path));
  });
});

describe("SessionSummary.align: only while the session waits on the user, with align on", () => {
  const line = (e: unknown) => `${JSON.stringify(e)}\n`;
  const user = (id: string, parentId: string, content: string) => ({ type: "message", id, parentId, message: { role: "user", content } });
  const mode = (id: string, parentId: string, minorModes: string[]) => ({ type: "custom", id, parentId, customType: "mode", data: { mode: "normal", active: { version: 1, mode: "normal", strict: false, minorModes } } });
  const summaryOf = async (path: string) => (await readAlignScan(path, readFileSync(path).length, null)).summary;

  test("the user speaking again after the last align result ends the wait; a new result resumes it", async () => {
    const a = result(created, "u1");
    const path = session("moved-on", [a]);
    assert.equal((await summaryOf(path))?.openQuestions, 2, "waiting on q1, q2");
    appendFileSync(path, line(user("u2", a.id, "never mind, fix the login bug")));
    assert.equal(await summaryOf(path), undefined, "moved on: out of Needs you, the mark and push");
    const b = result(answered, "u2");
    appendFileSync(path, line(b));
    assert.equal((await summaryOf(path))?.openQuestions, 1, "an answer recorded after it: waiting on q2 again");
  });

  test("an open alignment far above the transcript's newest rows (over 256 KB and 60 rows of later work) still waits on the user", async () => {
    const a = result(created, "u1");
    const later: unknown[] = [];
    let parent = a.id;
    for (let i = 0; i < 80; i++) {
      const id = `w${i}`;
      later.push({ type: "message", id, parentId: parent, message: { role: "assistant", content: [{ type: "text", text: `working ${i} ${"z".repeat(4000)}` }], stopReason: "stop" } });
      parent = id;
    }
    const path = session("far-above", [a, ...later]);
    assert.ok(readFileSync(path).length - readFileSync(path, "utf8").indexOf(`"id":"${a.id}"`) > 256 * 1024, "over 256 KB after it");
    assert.deepEqual(await summaryOf(path), { openDocs: 1, openQuestions: 2, questionDocs: 1, lead: { id: "al_1", title: "Export" } });
    // Its done, far below it, ends the wait.
    const done = calls([
      { ops: [{ op: "create", title: "Export", summary: "Download a session.", questions: [Q("Format"), Q("Zip")] }] },
      { ops: [{ op: "accept_all" }, { op: "status", to: "done" }] },
    ])[1]!;
    const closed = session("far-above-done", [a, ...later, result(done, parent)]);
    assert.equal(await summaryOf(closed), undefined, "done");
    // So does the user speaking again after it, however far below.
    const spoke = session("far-above-spoke", [a, ...later, user("u2", parent, "let's do something else")]);
    assert.equal(await summaryOf(spoke), undefined, "moved on");
  });

  test("a wake nudge or a partner's link message is not the user speaking", async () => {
    const a = result(created, "u1");
    const path = session("wake", [a, user("w1", a.id, "[wake_nudge n1] Scheduled wakeup fired (set 3m ago).\nReason: check")]);
    assert.equal((await summaryOf(path))?.openQuestions, 2);
  });

  test("align off on the branch: nothing can answer them, so nothing counts; on again, it does", async () => {
    const a = result(created, "u1");
    const path = session("align-off", [mode("m0", "u1", ["align"]), { ...a, parentId: "m0" }]);
    assert.equal((await summaryOf(path))?.openQuestions, 2);
    appendFileSync(path, line(mode("m1", a.id, [])));
    assert.equal(await summaryOf(path), undefined, "align off");
    appendFileSync(path, line(mode("m2", "m1", ["align", "spec"])));
    assert.equal((await summaryOf(path))?.openQuestions, 2, "align back on");
  });
});

describe("SessionSummary.align", () => {
  test("present while an alignment is open, from the file alone; gone once every alignment is done or dropped", async () => {
    const a = result(created, "u1");
    const b = result(answered, a.id);
    const path = session("summary", [a, b]);
    assert.deepEqual((await getSessionSummary(path))?.align, { openDocs: 1, openQuestions: 1, questionDocs: 1, lead: { id: "al_1", title: "Export" } });
    const done = calls([
      { ops: [{ op: "create", title: "Export", summary: "Download a session.", questions: [Q("Format"), Q("Zip")] }] },
      { ops: [{ op: "accept_all" }, { op: "status", to: "done" }] },
    ])[1]!;
    appendFileSync(path, `${JSON.stringify(result(done, b.id))}\n`);
    // A different size is a changed file for the list's cache.
    assert.equal((await getSessionSummary(path))?.align, undefined);
  });
});

describe("the web derives what the extension derives", () => {
  test("src/lib/align alignStatusOf and foldAlignRows agree with the extension's alignStatus and fold", async () => {
    const { alignStatus, foldAlignments } = await import("../pi-config/extensions/mode/align.ts");
    const web = await import("../src/lib/align");
    const all = calls([
      { ops: [{ op: "create", title: "A", summary: "s" }] },
      { ops: [{ op: "add", questions: [Q("x"), Q("y")] }] },
      { ops: [{ op: "decide", q: "q1", decision: "no" }] },
      { ops: [{ op: "drop_question", q: "q2", reason: "later" }] },
      { ops: [{ op: "reopen", q: "q2" }, { op: "accept_all" }, { op: "status", to: "implementing" }] },
      { ops: [{ op: "status", to: "done" }] },
      { doc: "al_1", ops: [{ op: "status", to: "open" }] },
      { ops: [{ op: "drop_alignment", reason: "gone" }] },
    ]);
    for (const d of all) assert.equal(web.alignStatusOf(d.doc!), alignStatus(d.doc!), `rev ${d.doc!.rev}`);
    const entries = [result(created, null), result(second, null), result(answered, null)];
    const rows = normalizeEntries(entries);
    assert.deepEqual(
      web.foldAlignRows(rows).map((e) => [e.doc.id, e.doc.rev, e.rowId]),
      foldAlignments(entries).docs.map((d) => [d.id, d.rev, entries.find((e) => (e.message.details as AlignDetails).doc?.id === d.id && (e.message.details as AlignDetails).doc?.rev === d.rev)!.id]),
    );
  });

  test("src/lib/align recommendedOption and optionLetter agree with the extension's", async () => {
    const ext = await import("../pi-config/extensions/mode/align.ts");
    const web = await import("../src/lib/align");
    const options = [{ label: "CSV", tradeoff: "t" }, { label: "CSV + gzip", tradeoff: "t" }, { label: "**Parquet**", tradeoff: "t" }, { label: "Ü-mode", tradeoff: "t" }];
    const choices = ["csv", " CSV + GZIP ", "CSV + gzip, smaller", "CSV — plain", "CSVs", "parquet", "**Parquet** it is", "ü-mode", "Avro", "", "   "];
    for (const choice of choices) {
      for (const opts of [options, undefined]) {
        const q = { options: opts, recommendation: { choice, why: "w" } };
        assert.equal(web.recommendedOption(q), ext.recommendedOption(q), JSON.stringify(q));
      }
    }
    for (let i = 0; i < 30; i++) assert.equal(web.optionLetter(i), ext.optionLetter(i));
  });
});

describe("a session written with the old op names", () => {
  test("its rows and its summary come from the results' snapshots, whatever the call's args said", async () => {
    // pi-config/extensions/mode/tests/align-old-ops.jsonl: written by align.ts before the op rename
    // (create + fromFile, accept "open", drop, edit of a question, exempt {why}).
    const fixture = readFileSync(new URL("../pi-config/extensions/mode/tests/align-old-ops.jsonl", import.meta.url), "utf8").trim().split("\n").map((line) => JSON.parse(line));
    let parentId: string | null = "u1";
    const lines = fixture.map((entry) => {
      const chained = { ...entry, id: `old-${entry.id}`, parentId, timestamp: env.now };
      parentId = chained.id;
      return chained;
    });
    const rows = normalizeEntries(lines).filter((row) => row.kind === "align");
    assert.deepEqual(rows.map((row) => row.align?.line || (row.align?.exempt ? "exempt" : "")), [
      "created from file",
      "q1 accepted · q2 dropped · q3 edited",
      "q3 accepted · → implementing",
      "created",
      "dropped",
      "exempt",
    ]);
    const path = session("old-ops", lines);
    const scan = await readAlignScan(path, readFileSync(path).length, null);
    assert.equal(scan.found, true);
    assert.deepEqual(scan.summary, { openDocs: 1, openQuestions: 0, questionDocs: 0 });
  });
});

describe("readAlignScan: a file that shrank since its size was read", () => {
  // The list reads a size, then the file is rewritten smaller before the read. A read that returned
  // only the marker's overlap made no progress and looped forever, hanging the whole listing.
  const bounded = <T>(p: Promise<T>) => Promise.race([p, new Promise<"hung">((done) => setTimeout(() => done("hung"), 2000))]);
  test("from the start: a 1,900-byte file read as 5,000 bytes returns, with nothing found", async () => {
    const path = join(sessionsDir, "shrunk-fresh.jsonl");
    writeFileSync(path, `${"x".repeat(1899)}\n`);
    assert.deepEqual(await bounded(readAlignScan(path, 5000, null)), { size: 5000, found: false, summary: undefined });
  });
  test("resuming: the search restarts at the old end, which is now the file's end", async () => {
    const path = join(sessionsDir, "shrunk-resume.jsonl");
    writeFileSync(path, `${"x".repeat(1899)}\n`);
    const out = await bounded(readAlignScan(path, 1900 + 5000, { size: 1900, found: false, summary: undefined }));
    assert.notEqual(out, "hung");
  });
});

describe("adversarial review: the record rides the align row (§chat.alignment-review/record)", () => {
  test("a review op's snapshot keeps its record through the server's transcript row; a malformed record is no row", () => {
    const review = {
      reviewer: () => ({ use: { backend: "pi", model: "fake/sol", effort: "high" }, via: "primary" as const, retry: null }),
      startText: () => "start",
    };
    let docs: AlignDocument[] = [];
    const run = (call: unknown) => {
      const { details } = applyAlignCall(docs, call, { ...env, review });
      if (details.doc) docs = [...docs.filter((d) => d.id !== details.doc!.id), details.doc];
      return details;
    };
    run({ ops: [{ op: "create", title: "Queue", summary: "Persist it." }] });
    const started = run({ ops: [{ op: "review", phase: "plan", state: "running", reason: "persistence" }] });
    const [row] = normalizeEntry(result(started, null));
    assert.equal(row?.kind, "align");
    assert.deepEqual(row?.align?.doc?.review, { plan: { state: "running", reason: "persistence", model: "pi · fake/sol · high", at: env.now } });
    assert.deepEqual(row?.align?.changes, [{ kind: "review", phase: "plan", state: "running" }]);
    const bad = JSON.parse(JSON.stringify(started));
    bad.doc.review.plan.state = "maybe";
    assert.notEqual(normalizeEntry(result(bad, null))[0]?.kind, "align", "a malformed record fails the snapshot, like any field");
  });
});
