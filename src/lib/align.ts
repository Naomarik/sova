// The align document (pi-config mode extension, `align` minor mode): a report row with
// source "align-doc" and `report.align` metrics. The status chip and the one-line metrics
// shown on its transcript card and in the viewer's head.

import type { AlignReportInfo, ReportInfo, TranscriptItem } from "../../shared/protocol";
import type { Tone } from "../components/ui";

export type AlignInfo = AlignReportInfo;

/** The align metrics of an "align-doc" report, or undefined for any other report. */
export const alignOf = (r: ReportInfo): AlignInfo | undefined => (r.source === "align-doc" ? r.align : undefined);

/**
 * Id of the newest align-doc row. A snapshot holds at most one, but the watch append path
 * normalizes each batch on its own, so a new revision arrives as another row: every earlier
 * one is superseded and hidden.
 */
export function latestAlignId(items: TranscriptItem[]): string | undefined {
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i]!;
    if (it.kind === "report" && it.report && alignOf(it.report)) return it.id;
  }
  return undefined;
}

export interface AlignChip {
  tone?: Tone | "accent";
  label: string;
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** Status → chip. Unknown statuses still show, untoned. */
export function alignChip(a: AlignInfo): AlignChip {
  switch (a.status) {
    case "aligning":
      return { tone: "info", label: "Aligning" };
    case "questions-open":
      return { tone: "warn", label: "Questions open" };
    case "ready":
      return { tone: "success", label: "Ready" };
    case "confirmed":
      return { tone: "success", label: "Confirmed" };
    case "implementing":
      return { tone: "accent", label: "Implementing" };
    default:
      return { label: cap(String(a.status || "unknown").replace(/[-_]/g, " ")) };
  }
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** "42 lines · 2 of 5 questions open"; the questions part only when there are any. */
export function alignMetrics(a: AlignInfo): string {
  const parts = [plural(a.lines, "line")];
  if (a.total > 0) parts.push(`${a.open} of ${plural(a.total, "question")} open`);
  return parts.join(" · ");
}
