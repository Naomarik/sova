// Alignments (§chat/alignment): the pi-config mode extension's `align` tool results, as transcript
// rows of kind "align" (the server checked their details with the extension's own function) and,
// while a run streams, as the live tool result's raw details. This file derives what the card, the
// revision rows and the composer chip show from them; nothing here writes.
//
// Also the read-only card of an OLDER session's align document (a report row with source
// "align-doc" and `report.align` metrics).

import type { AlignDocInfo, AlignQuestionInfo, AlignReportInfo, AlignRowInfo, ReportInfo, TranscriptItem } from "../../shared/protocol";
import type { Tone } from "../components/ui";

export type AlignStatus = "aligning" | "confirmed" | "implementing" | "done" | "dropped";
export type AlignQuestionState = "open" | "decided" | "dropped";

/**
 * Derived from the data, exactly as the extension derives it (pi-config/extensions/mode/align.ts
 * `alignStatus`; server/align-state.test.ts pins the two together): the lifecycle when it moved,
 * else aligning while a question is open or there are none, else confirmed.
 */
export function alignStatusOf(doc: AlignDocInfo): AlignStatus {
  if (doc.phase === "dropped" || doc.phase === "done" || doc.phase === "implementing") return doc.phase;
  const live = doc.questions.filter((q) => !q.dropped);
  if (live.length === 0 || live.some((q) => !q.decision)) return "aligning";
  return "confirmed";
}

export const questionStateOf = (q: AlignQuestionInfo): AlignQuestionState => (q.dropped ? "dropped" : q.decision ? "decided" : "open");
export const isOpenDoc = (doc: AlignDocInfo): boolean => doc.phase !== "done" && doc.phase !== "dropped";
export const openCount = (doc: AlignDocInfo): number => doc.questions.filter((q) => questionStateOf(q) === "open").length;
export const liveCount = (doc: AlignDocInfo): number => doc.questions.filter((q) => !q.dropped).length;

/** An option's letter, "a" for the first: the user answers "q3 option a" as "3a". Past z, its number. */
export const optionLetter = (i: number): string => (i < 26 ? String.fromCharCode(97 + i) : String(i + 1));

const bareLabel = (s: string): string => s.replaceAll("**", "").trim().toLowerCase();

/**
 * The option the recommendation names, by index, by the extension's rule (pi-config/extensions/mode/align.ts
 * `recommendedOption`): its choice equals an option's label (trimmed, case-insensitive, bold markers
 * ignored), else starts with one followed by a non-word character, the longest such label winning.
 */
export function recommendedOption(q: Pick<AlignQuestionInfo, "options" | "recommendation">): number | undefined {
  const labels = (q.options ?? []).map((o) => bareLabel(o.label));
  const choice = bareLabel(q.recommendation.choice);
  if (choice === "") return undefined;
  const exact = labels.indexOf(choice);
  if (exact >= 0) return exact;
  let best = -1;
  labels.forEach((l, i) => {
    if (l === "" || !choice.startsWith(l) || /[\p{L}\p{N}_]/u.test(choice.charAt(l.length))) return;
    if (best < 0 || l.length > labels[best]!.length) best = i;
  });
  return best >= 0 ? best : undefined;
}

export interface AlignChip {
  tone?: Tone | "accent";
  label: string;
}

export const ALIGN_STATUS_CHIP: Record<AlignStatus, AlignChip> = {
  aligning: { tone: "warn", label: "Aligning" },
  confirmed: { tone: "success", label: "Confirmed" },
  implementing: { tone: "accent", label: "Implementing" },
  done: { tone: "success", label: "Done" },
  dropped: { label: "Dropped" },
};

export const QUESTION_CHIP: Record<AlignQuestionState, AlignChip> = {
  open: { tone: "warn", label: "Open" },
  decided: { tone: "success", label: "Decided" },
  dropped: { label: "Dropped" },
};

/** "2 of 7 open" · "No questions yet" · "All 3 decided". */
export function openLabel(doc: AlignDocInfo): string {
  const live = liveCount(doc);
  const open = openCount(doc);
  if (live === 0) return "No questions yet";
  return open === 0 ? `All ${live} decided` : `${open} of ${live} open`;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * A live `align` result's details, while a run streams, when they are an alignment row: a changed
 * document or an exemption. Shape-checked only as far as rendering needs; the settled transcript
 * row is the server's, checked by the extension's own function.
 */
export function alignRowFromDetails(details: unknown): AlignRowInfo | undefined {
  if (!isObj(details) || details.v !== 1 || typeof details.line !== "string" || !Array.isArray(details.changes)) return undefined;
  if (isObj(details.exempt) && typeof details.exempt.why === "string") return details as unknown as AlignRowInfo;
  const d = details.doc;
  if (!isObj(d) || typeof d.id !== "string" || typeof d.title !== "string" || typeof d.summary !== "string" || typeof d.rev !== "number") return undefined;
  if (!Array.isArray(d.questions) || !Array.isArray(d.findings) || !Array.isArray(d.approach) || !Array.isArray(d.rejected)) return undefined;
  if (!d.questions.every((q) => isObj(q) && typeof q.id === "string" && typeof q.ask === "string" && isObj(q.recommendation))) return undefined;
  return details as unknown as AlignRowInfo;
}

/** One document's newest revision on the branch, and the row that shows it. */
export interface AlignEntry {
  doc: AlignDocInfo;
  /** The transcript row (entry id) of that revision: the jump target. Absent for a live revision
      the settled transcript hasn't brought yet. */
  rowId?: string;
}

/**
 * The branch's documents: the newest snapshot per id, in the order they were last touched —
 * the settled rows, then this run's live results on top. The same rule as the extension's fold.
 */
export function foldAlignRows(items: readonly TranscriptItem[], live: readonly AlignRowInfo[] = []): AlignEntry[] {
  const docs = new Map<string, AlignEntry>();
  for (const it of items) {
    const doc = it.kind === "align" ? it.align?.doc : undefined;
    if (!doc) continue;
    docs.delete(doc.id);
    docs.set(doc.id, { doc, rowId: it.id });
  }
  for (const row of live) {
    if (!row.doc) continue;
    const prev = docs.get(row.doc.id);
    docs.delete(row.doc.id);
    // A live revision already settled into the transcript keeps its row.
    docs.set(row.doc.id, { doc: row.doc, ...(prev && prev.doc.rev === row.doc.rev ? { rowId: prev.rowId } : {}) });
  }
  return [...docs.values()];
}

/** Row id → true for the newest row of each document: those render the full card, the rest one line. */
export function newestAlignRows(items: readonly TranscriptItem[]): Set<string> {
  const newest = new Map<string, string>();
  for (const it of items) if (it.kind === "align" && it.align?.doc) newest.set(it.align.doc.id, it.id);
  return new Set(newest.values());
}

/** The composer chip's counts over the open documents: how many, their open questions, all their questions. */
export function alignChipCounts(entries: readonly AlignEntry[]): { docs: number; open: number; total: number } {
  const open = entries.filter((e) => isOpenDoc(e.doc));
  return {
    docs: open.length,
    open: open.reduce((n, e) => n + openCount(e.doc), 0),
    total: open.reduce((n, e) => n + liveCount(e.doc), 0),
  };
}

/** "2 aligns · 5/15" / "1 align · 0/3". */
export const alignChipText = (c: { docs: number; open: number; total: number }): string => `${c.docs} ${c.docs === 1 ? "align" : "aligns"} · ${c.open}/${c.total}`;

/** The chip's accessible name. */
export const alignChipLabel = (c: { docs: number; open: number; total: number }): string =>
  `${c.docs} open ${c.docs === 1 ? "alignment" : "alignments"}, ${c.open} of ${c.total} ${c.total === 1 ? "question" : "questions"} open — show alignments`;

/**
 * The chip menu's rows: the open documents, those with an open question first, each group the
 * last touched first (the entries come oldest-touched first).
 */
export function alignMenuRows(entries: readonly AlignEntry[]): AlignEntry[] {
  const rows = entries.filter((e) => isOpenDoc(e.doc)).reverse();
  return [...rows.filter((e) => openCount(e.doc) > 0), ...rows.filter((e) => openCount(e.doc) === 0)];
}

/** A menu row's accessible name: "al_3 Autonomy: 5 of 7 questions decided — jump to its card". */
export function alignMenuLabel(doc: AlignDocInfo): string {
  const live = liveCount(doc);
  const state =
    live === 0
      ? `${ALIGN_STATUS_CHIP[alignStatusOf(doc)].label.toLowerCase()}, no questions`
      : `${live - openCount(doc)} of ${live} ${live === 1 ? "question" : "questions"} decided`;
  return `${doc.id} ${doc.title}: ${state} — jump to its card`;
}

// ── An older session's align document (read-only) ────────────────────────────

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
