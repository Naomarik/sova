// Run: npx tsx --test src/lib/align.test.ts (or npm test)
import assert from "node:assert/strict";
import { test } from "node:test";
import type { AlignDocInfo, AlignQuestionInfo, ReportInfo, TranscriptItem } from "../../shared/protocol";
import { alignChip, alignChipCounts, alignChipLabel, alignChipText, alignMenuNote, alignMetrics, alignOf, alignRowFromDetails, alignStatusOf, foldAlignRows, latestAlignId, newestAlignRows, openLabel, type AlignInfo } from "./align";

const a = (extra: Partial<AlignInfo> = {}): AlignInfo => ({
  status: "aligning",
  title: "",
  lines: 0,
  open: 0,
  settled: 0,
  total: 0,
  revision: 1,
  ...extra,
});

const report = (source: string, align?: unknown): ReportInfo =>
  ({ source, body: "## Alignment: x", preview: "## Alignment: x", truncated: false, align }) as ReportInfo;

test("alignOf: only align-doc reports that carry metrics", () => {
  assert.equal(alignOf(report("subagent-complete", a())), undefined);
  assert.equal(alignOf(report("align-doc")), undefined);
  assert.deepEqual(alignOf(report("align-doc", a({ status: "ready", title: "T", lines: 9, settled: 2, total: 2 }))), a({ status: "ready", title: "T", lines: 9, settled: 2, total: 2 }));
});

test("status → chip", () => {
  const cases: [string, string | undefined, string][] = [
    ["aligning", "info", "Aligning"],
    ["questions-open", "warn", "Questions open"],
    ["ready", "success", "Ready"],
    ["confirmed", "success", "Confirmed"],
    ["implementing", "accent", "Implementing"],
    ["on_hold", undefined, "On hold"],
  ];
  for (const [status, tone, label] of cases) {
    assert.deepEqual(alignChip(a({ status: status as AlignInfo["status"] })), tone ? { tone, label } : { label }, status);
  }
});

test("metrics: lines always, questions only when there are any", () => {
  assert.equal(alignMetrics(a({ lines: 1 })), "1 line");
  assert.equal(alignMetrics(a({ lines: 42, open: 2, total: 5 })), "42 lines · 2 of 5 questions open");
  assert.equal(alignMetrics(a({ lines: 3, open: 0, total: 1 })), "3 lines · 0 of 1 question open");
});

test("latestAlignId: the newest align-doc row wins, other reports don't count", () => {
  const row = (id: string, r?: ReportInfo): TranscriptItem => ({ id, kind: r ? "report" : "user", report: r, raw: null });
  assert.equal(latestAlignId([row("u1"), row("r1", report("subagent-complete"))]), undefined);
  const items = [row("d1", report("align-doc", a())), row("u1"), row("d2", report("align-doc", a({ revision: 2 }))), row("r1", report("intercom_message"))];
  assert.equal(latestAlignId(items), "d2");
});

// ── Alignments from the align tool (§chat/alignment) ─────────────────────────

const q = (id: string, over: Partial<AlignQuestionInfo> = {}): AlignQuestionInfo => ({ id, topic: id, ask: `${id}?`, recommendation: { choice: "yes", why: "w" }, ...over });
const doc = (id: string, rev: number, questions: AlignQuestionInfo[], phase: AlignDocInfo["phase"] = "open"): AlignDocInfo => ({
  id, title: `T ${id}`, summary: `S ${id}`, findings: [], approach: [], rejected: [], questions, phase, next: { f: 0, a: 0, x: 0, q: questions.length }, rev, createdAt: "", updatedAt: "",
});
const alignItem = (rowId: string, d: AlignDocInfo): TranscriptItem => ({ id: rowId, kind: "align", raw: {}, toolCallId: `c-${rowId}`, align: { v: 1, doc: d, changes: [], line: "" } });
const decided = { text: "no", by: "user" as const, at: "" };

test("derived status, and the card's open line", () => {
  assert.equal(alignStatusOf(doc("al_1", 1, [])), "aligning");
  assert.equal(alignStatusOf(doc("al_1", 1, [q("q1"), q("q2", { decision: decided })])), "aligning");
  assert.equal(alignStatusOf(doc("al_1", 1, [q("q1", { decision: decided }), q("q2", { dropped: { why: "x", at: "" } })])), "confirmed");
  assert.equal(alignStatusOf(doc("al_1", 1, [q("q1")], "implementing")), "implementing");
  assert.equal(openLabel(doc("al_1", 1, [])), "No questions yet");
  assert.equal(openLabel(doc("al_1", 1, [q("q1"), q("q2", { decision: decided }), q("q3", { dropped: { why: "x", at: "" } })])), "1 of 2 open");
  assert.equal(openLabel(doc("al_1", 1, [q("q1", { decision: decided })])), "All 1 decided");
});

test("fold: newest per document in touch order; this run's live results on top; a settled live revision keeps its row", () => {
  const items = [alignItem("r1", doc("al_1", 1, [q("q1")])), alignItem("r2", doc("al_2", 1, [q("q1"), q("q2")])), alignItem("r3", doc("al_1", 2, [q("q1", { decision: decided })]))];
  assert.deepEqual(foldAlignRows(items).map((e) => [e.doc.id, e.doc.rev, e.rowId]), [["al_2", 1, "r2"], ["al_1", 2, "r3"]]);
  assert.deepEqual([...newestAlignRows(items)].sort(), ["r2", "r3"]);
  const live = [{ v: 1 as const, doc: doc("al_2", 2, [q("q1")]), changes: [], line: "" }, { v: 1 as const, doc: doc("al_1", 2, [q("q1", { decision: decided })]), changes: [], line: "" }];
  assert.deepEqual(foldAlignRows(items, live).map((e) => [e.doc.id, e.doc.rev, e.rowId]), [["al_2", 2, undefined], ["al_1", 2, "r3"]]);
});

test("the chip counts open documents only: '2 aligns · 3/4'", () => {
  const entries = foldAlignRows([
    alignItem("r1", doc("al_1", 1, [q("q1"), q("q2", { decision: decided })])),
    alignItem("r2", doc("al_2", 1, [q("q1"), q("q2")])),
    alignItem("r3", doc("al_3", 1, [q("q1")], "done")),
  ]);
  const c = alignChipCounts(entries);
  assert.deepEqual(c, { docs: 2, open: 3, total: 4 });
  assert.equal(alignChipText(c), "2 aligns · 3/4");
  assert.equal(alignChipText({ docs: 1, open: 0, total: 3 }), "1 align · 0/3");
  assert.equal(alignChipLabel(c), "2 open alignments, 3 of 4 questions open — show alignments");
  assert.equal(alignMenuNote(entries[0]!.doc), "S al_1 · 1 of 2 open");
  assert.equal(alignMenuNote(doc("al_9", 1, [q("q1", { decision: decided })], "implementing")), "S al_9 · implementing");
});

test("a live result's details become a row only when they are a changed document or an exemption", () => {
  const d = doc("al_1", 1, [q("q1")]);
  assert.ok(alignRowFromDetails({ v: 1, doc: d, changes: [], line: "created" }));
  assert.ok(alignRowFromDetails({ v: 1, changes: [], line: "", exempt: { why: "x" } }));
  for (const bad of [undefined, null, {}, { v: 2, doc: d, changes: [], line: "" }, { v: 1, changes: [], line: "" }, { v: 1, doc: { ...d, questions: [{ id: "q1" }] }, changes: [], line: "" }]) {
    assert.equal(alignRowFromDetails(bad), undefined, JSON.stringify(bad)?.slice(0, 60));
  }
});
