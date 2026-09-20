// Pure derivations behind the Session info modal (DESIGN_NOTES §4h): the spend table's rows and
// labels, the model/thinking/mode timeline read off the transcript, and the two text helpers the
// modal needs. Nothing here touches the DOM, so it is unit-tested in spend.test.ts.

import type { ModelSpend, SessionUsage, SpendOrigin, TokenUsage, TranscriptItem } from "../../shared/protocol";
import { clockTime, shortDate } from "./format";

/** The "Where" column: a row is the active branch, this session's plain subagents, or its team. */
export function originLabel(origin: SpendOrigin): string {
  return origin === "main" ? "Main thread" : origin === "team" ? "Team" : "Subagents";
}

/** What a row actually spoke, which is what the table sorts on. Cache is its own column. */
const spoken = (u: TokenUsage): number => u.input + u.output;

/**
 * Table order: the main thread first, then the biggest spender. Model × origin rows arrive in
 * whatever order the server tallied them, and a mid-session switch adds one more — the reader is
 * looking for "what cost this", so the largest row leads inside each origin. Ties go by model id
 * so two identical rows never swap places between fetches.
 */
export function spendRows(usage: SessionUsage | undefined): ModelSpend[] {
  const rank = (o: SpendOrigin) => (o === "main" ? 0 : o === "subagents" ? 1 : 2);
  return [...(usage?.models ?? [])].sort(
    (a, b) => rank(a.origin) - rank(b.origin) || spoken(b) - spoken(a) || a.model.localeCompare(b.model),
  );
}

/** Whether the Cost column is worth a column: only a backend that reports USD fills it. */
export const anyCost = (rows: readonly TokenUsage[]): boolean => rows.some((r) => (r.cost ?? 0) > 0);

/** A compaction summary in one line: first line, cut at a word boundary near `max`. */
export function firstLine(text: string | null | undefined, max = 120): string {
  const line = (text ?? "").trim().split("\n")[0]?.trim() ?? "";
  if (line.length <= max) return line;
  const cut = line.slice(0, max);
  const space = cut.lastIndexOf(" ");
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

/** "Mar 4 14:06", with the year when it isn't this one: the `title` behind a relative time. */
export function absoluteTime(iso: string, now = Date.now()): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  return `${shortDate(t, now)} ${clockTime(iso)}`;
}

/** Info rows the timeline keeps (server/transcript.ts writes these exact prefixes). */
const TIMELINE = /^(?:Model: |Thinking: |Mode → |Minor mode: |Strict mode (?:on|off)$)/;

export interface TimelineEntry {
  id: string;
  /** ISO from the JSONL entry, when it carried one. */
  at?: string;
  text: string;
}

/**
 * The session's model, thinking-level and mode history, oldest first, off the chat's own rows.
 * Consecutive repeats collapse: re-selecting the model that's already set writes an entry, and a
 * list that says "Model: X" four times in a row reports the writing, not the session.
 */
export function timelineEntries(items: readonly TranscriptItem[]): TimelineEntry[] {
  const out: TimelineEntry[] = [];
  for (const item of items) {
    if (item.kind !== "info") continue;
    const text = item.text?.trim();
    if (!text || !TIMELINE.test(text)) continue;
    if (out[out.length - 1]?.text === text) continue;
    const raw = item.raw;
    const stamp = raw && typeof raw === "object" ? (raw as Record<string, unknown>).timestamp : undefined;
    out.push({ id: item.id, text, ...(typeof stamp === "string" ? { at: stamp } : {}) });
  }
  return out;
}
