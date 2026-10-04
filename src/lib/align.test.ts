// Run: npx tsx --test src/lib/align.test.ts (or npm test)
import assert from "node:assert/strict";
import { test } from "node:test";
import type { AlignDocInfo, AlignQuestionInfo, ReportInfo, TranscriptItem } from "../../shared/protocol";
import { alignChip, alignChipCounts, alignChipLabel, alignChipText, alignMenuLabel, alignMenuRows, alignMetrics, alignOf, alignRowFromDetails, alignStatusOf, foldAlignRows, latestAlignId, newestAlignRows, openLabel, optionLetter, recommendedOption, type AlignInfo } from "./align";

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
  const row = (id: string, r?: ReportInfo): TranscriptItem => ({ id, kind: r ? "report" : "user", report: r });
  assert.equal(latestAlignId([row("u1"), row("r1", report("subagent-complete"))]), undefined);
  const items = [row("d1", report("align-doc", a())), row("u1"), row("d2", report("align-doc", a({ revision: 2 }))), row("r1", report("intercom_message"))];
  assert.equal(latestAlignId(items), "d2");
});

// ── Alignments from the align tool (§chat/alignment) ─────────────────────────

const q = (id: string, over: Partial<AlignQuestionInfo> = {}): AlignQuestionInfo => ({ id, topic: id, ask: `${id}?`, recommendation: { choice: "yes", why: "w" }, ...over });
const doc = (id: string, rev: number, questions: AlignQuestionInfo[], phase: AlignDocInfo["phase"] = "open"): AlignDocInfo => ({
  id, title: `T ${id}`, summary: `S ${id}`, findings: [], approach: [], rejected: [], questions, phase, next: { f: 0, a: 0, x: 0, q: questions.length }, rev, createdAt: "", updatedAt: "",
});
const alignItem = (rowId: string, d: AlignDocInfo): TranscriptItem => ({ id: rowId, kind: "align", toolCallId: `c-${rowId}`, align: { v: 1, doc: d, changes: [], line: "" } });
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

test("fold: alignments open above the rows held count, first; a newer held or live revision takes their place", () => {
  const above = [
    { doc: doc("al_1", 3, [q("q1")]), rowId: "o1" },
    { doc: doc("al_2", 1, [q("q1"), q("q2", { decision: decided })]), rowId: "o2" },
    { doc: doc("al_4", 2, [q("q1")]), rowId: "o4" },
  ];
  // Nothing held of them: the chip counts all three, in their last-touched order, each jumping to its row above.
  const only = foldAlignRows([], [], above);
  assert.deepEqual(only.map((e) => [e.doc.id, e.rowId]), [["al_1", "o1"], ["al_2", "o2"], ["al_4", "o4"]]);
  assert.deepEqual(alignChipCounts(only), { docs: 3, decided: 1, total: 4 });
  // al_1 done in the rows held, al_3 new there, al_2 dropped live: only al_4 and al_3 stay open, touched after.
  const items = [alignItem("r1", doc("al_1", 4, [q("q1")], "done")), alignItem("r3", doc("al_3", 1, [q("q1")]))];
  const live = [{ v: 1 as const, doc: doc("al_2", 2, [q("q1")], "dropped"), changes: [], line: "" }];
  const all = foldAlignRows(items, live, above);
  assert.deepEqual(all.map((e) => [e.doc.id, e.doc.rev, e.rowId]), [["al_4", 2, "o4"], ["al_1", 4, "r1"], ["al_3", 1, "r3"], ["al_2", 2, undefined]]);
  assert.deepEqual(alignChipCounts(all), { docs: 2, decided: 0, total: 2 });
  assert.deepEqual(alignMenuRows(all).map((e) => e.doc.id), ["al_3", "al_4"]);
  // A live revision of an alignment above, at the same rev, keeps that row as its jump target.
  const same = foldAlignRows([], [{ v: 1 as const, doc: doc("al_4", 2, [q("q1")]), changes: [], line: "" }], above);
  assert.equal(same.find((e) => e.doc.id === "al_4")?.rowId, "o4");
});

test("the chip counts open documents only: '2 aligns · 1/4 decided'", () => {
  const entries = foldAlignRows([
    alignItem("r1", doc("al_1", 1, [q("q1"), q("q2", { decision: decided })])),
    alignItem("r2", doc("al_2", 1, [q("q1"), q("q2")])),
    alignItem("r3", doc("al_3", 1, [q("q1")], "done")),
  ]);
  const c = alignChipCounts(entries);
  assert.deepEqual(c, { docs: 2, decided: 1, total: 4 });
  assert.equal(alignChipText(c), "2 aligns · 1/4 decided");
  assert.equal(alignChipText({ docs: 1, decided: 3, total: 3 }), "1 align · 3/3 decided");
  assert.equal(alignChipLabel(c), "2 open alignments, 1 of 4 questions decided — show alignments");
});

test("menu rows: open documents only, those still asking first, each group last touched first", () => {
  const entries = foldAlignRows([
    alignItem("r1", doc("al_1", 1, [q("q1")])),
    alignItem("r2", doc("al_2", 1, [q("q1", { decision: decided })], "implementing")),
    alignItem("r3", doc("al_3", 1, [q("q1")])),
    alignItem("r4", doc("al_4", 1, [])),
    alignItem("r5", doc("al_5", 1, [q("q1")], "done")),
  ]);
  assert.deepEqual(alignMenuRows(entries).map((e) => e.doc.id), ["al_3", "al_1", "al_4", "al_2"]);
});

test("a menu row's accessible name: decided of live, or the status when there are no questions", () => {
  const d = doc("al_1", 1, [q("q1"), q("q2", { decision: decided }), q("q3", { dropped: { why: "x", at: "" } })]);
  assert.equal(alignMenuLabel(d), "al_1 T al_1: 1 of 2 questions decided — jump to its card");
  assert.equal(alignMenuLabel(doc("al_2", 1, [q("q1", { decision: decided })])), "al_2 T al_2: 1 of 1 question decided — jump to its card");
  assert.equal(alignMenuLabel(doc("al_3", 1, [], "implementing")), "al_3 T al_3: implementing, no questions — jump to its card");
});

test("a live result's details become a row only when they are a changed document or an exemption", () => {
  const d = doc("al_1", 1, [q("q1")]);
  assert.ok(alignRowFromDetails({ v: 1, doc: d, changes: [], line: "created" }));
  assert.ok(alignRowFromDetails({ v: 1, changes: [], line: "", exempt: { why: "x" } }));
  for (const bad of [undefined, null, {}, { v: 2, doc: d, changes: [], line: "" }, { v: 1, changes: [], line: "" }, { v: 1, doc: { ...d, questions: [{ id: "q1" }] }, changes: [], line: "" }]) {
    assert.equal(alignRowFromDetails(bad), undefined, JSON.stringify(bad)?.slice(0, 60));
  }
});

test("options are lettered from a; the recommendation names one by its label", () => {
  assert.deepEqual([0, 1, 2, 25, 26].map(optionLetter), ["a", "b", "c", "z", "27"]);
  const options = [
    { label: "CSV", tradeoff: "readable" },
    { label: "CSV + gzip", tradeoff: "smaller" },
    { label: "**Parquet**", tradeoff: "compact" },
  ];
  const rec = (choice: string) => recommendedOption({ options, recommendation: { choice, why: "w" } });
  assert.equal(rec("csv"), 0, "case-insensitive");
  assert.equal(rec("  CSV  "), 0, "trimmed");
  assert.equal(rec("CSV + gzip"), 1, "an exact label beats a shorter one it starts with");
  assert.equal(rec("CSV + gzip — half the bytes"), 1, "the longest label the choice starts with");
  assert.equal(rec("CSV, since anyone can read it"), 0);
  assert.equal(rec("Parquet"), 2, "bold markers on the label are ignored");
  assert.equal(rec("**Parquet**"), 2, "and on the choice");
  assert.equal(rec("CSVs"), undefined, "the label must end at a word boundary");
  assert.equal(rec("Avro"), undefined, "no option named: the line keeps the choice");
  assert.equal(rec(""), undefined);
  assert.equal(recommendedOption({ recommendation: { choice: "CSV", why: "w" } }), undefined, "no options");
});
