// Report rows: the status chip and the one collapsed line.

import type { ReportInfo, TeamMessageInfo } from "../../shared/protocol";
import type { Tone } from "../components/ui";

export interface ReportChip {
  tone?: Tone;
  label: string;
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/**
 * Status → chip. Failure first (same rule as the subagents extension's own "failed": an error
 * line, a failed task, or an errored worker), then stopped/aborted, then the task's success,
 * then the worker's live status. Undefined when the report has no parsed agent.
 */
export function reportChip(r: ReportInfo): ReportChip | undefined {
  const a = r.agent;
  if (!a) return undefined;
  if (r.error || a.outcome === "error" || a.status === "error") return { tone: "error", label: "Failed" };
  if (a.status === "killed") return { tone: "warn", label: "Stopped" };
  if (a.outcome === "aborted") return { tone: "warn", label: "Aborted" };
  if (a.outcome === "success") return { tone: "success", label: "Success" };
  if (a.status === "done") return { tone: "success", label: "Done" };
  if (["starting", "running", "waiting", "stopping"].includes(a.status)) return { tone: "info", label: cap(a.status) };
  return { label: cap(a.status) };
}

/** Who sent it: "ag_01 · orchestrator", or the message's type when there's no agent header. */
export const reportFrom = (r: ReportInfo) => (r.agent ? `${r.agent.id} · ${r.agent.name}` : r.source || "message");

/** The collapsed row as one plain line (also what the summary reads out after "Report from"). */
export function reportLine(r: ReportInfo): string {
  const chip = reportChip(r);
  return [reportFrom(r), chip?.label, r.preview].filter(Boolean).join(" · ");
}

/** A team message's chip: Milestone / Concern for a report that says which (none otherwise),
    Question for a question — it waits on someone. */
export function teamMessageChip(t: TeamMessageInfo): ReportChip | undefined {
  if (t.kind === "question") return { tone: "warn", label: "Question" };
  if (t.label === "milestone") return { tone: "success", label: "Milestone" };
  if (t.label === "concern") return { tone: "warn", label: "Concern" };
  return undefined;
}
