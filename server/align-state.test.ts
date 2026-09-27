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
const { normalizeEntries, normalizeEntry } = await import("./transcript");
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
  { doc: "al_2", ops: [{ op: "accept", q: "open" }, { op: "status", to: "done" }] },
]) as [AlignDetails, AlignDetails, AlignDetails, AlignDetails];

describe("transcript: an align tool result is its own row", () => {
  test("a changing call: kind align, the checked details, paired with its call by toolCallId", () => {
    const [row, ...rest] = normalizeEntry(result(created, null));
    assert.equal(rest.length, 0);
    assert.equal(row!.kind, "align");
    assert.equal(row!.toolCallId, (row!.raw as any).message.toolCallId);
    assert.equal(row!.align?.doc?.id, "al_1");
    assert.equal(row!.align?.line, "created");
    assert.deepEqual(row!.align, created);
  });

  test("an exemption is a row too; a get, a failed call and unreadable details stay plain tool results", () => {
    const exempt = applyAlignCall([], { ops: [{ op: "exempt", why: "a question, no change" }] }, env).details;
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
      { ops: [{ op: "accept", q: "open" }] },
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

describe("SessionSummary.align", () => {
  test("present while an alignment is open, from the file alone; gone once every alignment is done or dropped", async () => {
    const a = result(created, "u1");
    const b = result(answered, a.id);
    const path = session("summary", [a, b]);
    assert.deepEqual((await getSessionSummary(path))?.align, { openDocs: 1, openQuestions: 1, questionDocs: 1, lead: { id: "al_1", title: "Export" } });
    const done = calls([
      { ops: [{ op: "create", title: "Export", summary: "Download a session.", questions: [Q("Format"), Q("Zip")] }] },
      { ops: [{ op: "accept", q: "open" }, { op: "status", to: "done" }] },
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
      { ops: [{ op: "drop", q: "q2", why: "later" }] },
      { ops: [{ op: "reopen", q: "q2" }, { op: "accept", q: "open" }, { op: "status", to: "implementing" }] },
      { ops: [{ op: "status", to: "done" }] },
      { doc: "al_1", ops: [{ op: "status", to: "open" }] },
      { ops: [{ op: "drop", why: "gone" }] },
    ]);
    for (const d of all) assert.equal(web.alignStatusOf(d.doc!), alignStatus(d.doc!), `rev ${d.doc!.rev}`);
    const entries = [result(created, null), result(second, null), result(answered, null)];
    const rows = normalizeEntries(entries);
    assert.deepEqual(
      web.foldAlignRows(rows).map((e) => [e.doc.id, e.doc.rev, e.rowId]),
      foldAlignments(entries).docs.map((d) => [d.id, d.rev, entries.find((e) => (e.message.details as AlignDetails).doc?.id === d.id && (e.message.details as AlignDetails).doc?.rev === d.rev)!.id]),
    );
  });
});
