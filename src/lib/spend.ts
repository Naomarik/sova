// Pure derivations behind the session pane's Usage and Session tabs: the spend table's rows and
// labels, the model/thinking/mode timeline read off the transcript, and the two text helpers the
// Session tab needs. Nothing here touches the DOM, so it is unit-tested in spend.test.ts.

import type { TranscriptItem } from "../../shared/protocol";
import type { UsageOrigin, UsageSessionModelRow, UsageSessionSpend, UsageSpend, UsageWorkerRow } from "../../shared/usage/wire";
import { formatTokens } from "./context";
import { clockTime, shortDate } from "./format";

/** The "Where" column: the session's own conversation, side calls made for it, or its workers. */
export function originLabel(origin: UsageOrigin): string {
  return origin === "main" ? "Main thread" : origin === "oneshot" ? "Side calls" : "Subagents";
}

/** What a row actually spoke, the headline and the table's sort. Cache is its own column. */
export const spoken = (u: Pick<UsageSpend, "tokens">): number => u.tokens.input + u.tokens.output;

/**
 * Table order: the main thread first, then side calls, then subagents, and the biggest spender
 * first inside each — the reader is looking for "what cost this". Ties go by provider and model
 * so two identical rows never swap places between polls.
 */
export function usageTabRows(spend: Pick<UsageSessionSpend, "models"> | undefined): UsageSessionModelRow[] {
  const rank = (o: UsageOrigin) => (o === "main" ? 0 : o === "oneshot" ? 1 : 2);
  return [...(spend?.models ?? [])].sort(
    (a, b) => rank(a.origin) - rank(b.origin) || spoken(b) - spoken(a) || `${a.provider}/${a.model}`.localeCompare(`${b.provider}/${b.model}`),
  );
}

/** Whether anything was recorded for the session: a call, of any kind. */
export const spentAnything = (spend: Pick<UsageSessionSpend, "total"> | undefined): boolean => !!spend && spend.total.calls > 0;

/** `$1.24`, `$0.08`, `<$0.01`, `$0.00`: dollars at API prices, always said (subscriptions included). */
export function spendUsd(usd: number): string {
  if (!(usd > 0)) return "$0.00";
  return usd < 0.01 ? "<$0.01" : `$${usd.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** The `title` behind a token figure: the split the headline hides, and the cost at API prices. */
export function spendTitle(s: Pick<UsageSpend, "tokens" | "usd">): string {
  const t = s.tokens;
  return [`${formatTokens(t.input)} in`, `${formatTokens(t.output)} out`, `${formatTokens(t.cacheRead)} cache read`, `${formatTokens(t.cacheWrite)} cache write`, spendUsd(s.usd)].join(" · ");
}

/** A listed worker's ledger row: its row under this session (`worker` id, parent this session),
    else the only row with that worker id; null when nothing is recorded for it. */
export function workerSpendOf(spend: Pick<UsageSessionSpend, "sid" | "workerList"> | undefined, workerId: string): UsageWorkerRow | null {
  const rows = spend?.workerList.filter((r) => r.worker === workerId) ?? [];
  return rows.find((r) => r.parent === spend!.sid) ?? (rows.length === 1 ? rows[0]! : null);
}

// Each surface's figure, read straight off the ledger's answer: nothing here adds anything up.

/** The session pane head's token chip: the answer's total, only once the answer is for this
    session and something was spoken; null hides the chip. */
export function headChipSpend(spend: Pick<UsageSessionSpend, "sid" | "total"> | undefined, sid: string | null): UsageSpend | null {
  return spend && sid && spend.sid === sid && spentAnything(spend) && spoken(spend.total) > 0 ? spend.total : null;
}

/** The head chip's words: "53.2k tokens", its accessible name "53.2k tokens — show usage", and the split in its title. */
export const headChipWords = (s: UsageSpend): { text: string; label: string; title: string } => {
  const text = `${formatTokens(spoken(s))} tokens`;
  return { text, label: `${text} — show usage`, title: spendTitle(s) };
};

/** The open worker transcript's sid: the one its roster row in the session's answer names (worker
    id, parent this session), never one derived from the worker; null until the ledger lists it. */
export const transcriptHeaderSid = (spend: Pick<UsageSessionSpend, "sid" | "workerList"> | undefined, workerId: string): string | null =>
  workerSpendOf(spend, workerId)?.sid ?? null;

/** The transcript header's figure: "{n} tok", the split in its title. */
export const headerTokenWords = (s: UsageSpend): { text: string; title: string } => ({ text: `${formatTokens(spoken(s))} tok`, title: spendTitle(s) });

/** A worker row's tokens: the worker's own calls and its workers', at any depth (`withWorkers`);
    null for a worker with no recorded call. */
export function workerRowSpend(spend: Pick<UsageSessionSpend, "sid" | "workerList"> | undefined, workerId: string): UsageSpend | null {
  const row = workerSpendOf(spend, workerId);
  return row && row.withWorkers.calls > 0 ? row.withWorkers : null;
}

/** The open worker transcript's header: the worker's own answer's total; null until it has a call. */
export const transcriptHeaderSpend = (spend: Pick<UsageSessionSpend, "total"> | undefined): UsageSpend | null =>
  spend && spentAnything(spend) ? spend.total : null;

/** A workspace pane title's "$x this session": the answer's total dollars; null when nothing was spent. */
export const paneTitleCost = (spend: Pick<UsageSessionSpend, "total"> | undefined): string | null =>
  spend && spend.total.usd > 0 ? `${spendUsd(spend.total.usd)} this session` : null;

/** A compaction summary in one line: first line, cut at a word boundary near `max`. */
export function firstLine(text: string | null | undefined, max = 120): string {
  const line = (text ?? "").trim().split("\n")[0]?.trim() ?? "";
  if (line.length <= max) return line;
  const cut = line.slice(0, max);
  const space = cut.lastIndexOf(" ");
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

/** "Mar 4 2:06 PM", with the year when it isn't this one: the `title` behind a relative time. */
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
    out.push({ id: item.id, text, ...(item.at !== undefined ? { at: item.at } : {}) });
  }
  return out;
}
