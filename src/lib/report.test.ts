// Run: npx tsx --test src/lib/report.test.ts (or npm test)
import assert from "node:assert/strict";
import { test } from "node:test";
import type { ReportInfo } from "../../shared/protocol";
import { reportChip, reportFrom, reportLine, teamMessageChip } from "./report";

const r = (agent?: ReportInfo["agent"], extra: Partial<ReportInfo> = {}): ReportInfo => ({
  source: "subagent-complete",
  agent,
  body: "",
  preview: "",
  truncated: false,
  ...extra,
});

test("status → chip: failure first, then stopped/aborted, success, live status", () => {
  const cases: [ReportInfo, string | undefined, string | undefined][] = [
    [r({ id: "a", name: "n", status: "waiting", outcome: "success" }), "success", "Success"],
    [r({ id: "a", name: "n", status: "done" }), "success", "Done"],
    [r({ id: "a", name: "n", status: "waiting", outcome: "error" }), "error", "Failed"],
    [r({ id: "a", name: "n", status: "error", outcome: "error" }), "error", "Failed"],
    [r({ id: "a", name: "n", status: "waiting", outcome: "success" }, { error: "boom" }), "error", "Failed"],
    [r({ id: "a", name: "n", status: "killed", outcome: "aborted" }), "warn", "Stopped"],
    [r({ id: "a", name: "n", status: "waiting", outcome: "aborted" }), "warn", "Aborted"],
    [r({ id: "a", name: "n", status: "waiting" }), "info", "Waiting"],
    [r({ id: "a", name: "n", status: "running" }), "info", "Running"],
    [r({ id: "a", name: "n", status: "odd" }), undefined, "Odd"],
  ];
  for (const [report, tone, label] of cases) {
    const chip = reportChip(report);
    assert.equal(chip?.tone, tone, JSON.stringify(report.agent));
    assert.equal(chip?.label, label, JSON.stringify(report.agent));
  }
  assert.equal(reportChip(r(undefined)), undefined);
});

test("the collapsed line", () => {
  const rep = r(
    { id: "ag_01", name: "orchestrator", status: "waiting", outcome: "success" },
    { preview: "All requested checks pass. Report for items 5 and 6, plus the item 1 flag check." },
  );
  assert.equal(reportLine(rep), "ag_01 · orchestrator · Success · All requested checks pass. Report for items 5 and 6, plus the item 1 flag check.");
  assert.equal(reportFrom(r(undefined, { source: "intercom_message" })), "intercom_message");
});

test("team message chip: Milestone, Concern, none without a label, Question for a question", () => {
  const t = { kind: "report" as const, role: "coordinator", workerId: "ag_01", teamId: "team_01", teamName: "x" };
  assert.deepEqual(teamMessageChip({ ...t, label: "milestone" }), { tone: "success", label: "Milestone" });
  assert.deepEqual(teamMessageChip({ ...t, label: "concern" }), { tone: "warn", label: "Concern" });
  assert.equal(teamMessageChip(t), undefined);
  assert.deepEqual(teamMessageChip({ ...t, kind: "question" }), { tone: "warn", label: "Question" });
});
