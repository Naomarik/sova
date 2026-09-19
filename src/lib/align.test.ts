// Run: npx tsx --test src/lib/align.test.ts (or npm test)
import assert from "node:assert/strict";
import { test } from "node:test";
import type { ReportInfo, TranscriptItem } from "../../shared/protocol";
import { alignChip, alignMetrics, alignOf, latestAlignId, type AlignInfo } from "./align";

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
