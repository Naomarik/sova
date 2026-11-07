// What the Time Spent section draws (§app.subagents-pane/time-spent), pure: durations in the copy
// deck's form, and the Your Time rows in whole seconds that add up to You to the second.
import { TIME_SPENT_ROWS as SPENT_ROWS, type TimeSpentMessageRow, type TimeSpentMessages, type TimeSpentRecord, type TimeSpentRow } from "../../shared/time-spent";

/** `1h 12m 08s`, `14m 08s`, `8s`: whole seconds, the larger units only once they are reached. */
export function formatSpent(seconds: number): string {
  const total = Math.max(0, Math.floor(Number.isFinite(seconds) ? seconds : 0));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const two = (n: number) => String(n).padStart(2, "0");
  if (h > 0) return `${h}h ${two(m)}m ${two(s)}s`;
  if (m > 0) return `${m}m ${two(s)}s`;
  return `${s}s`;
}

/**
 * Whole seconds per key, adding up exactly to the floor of the sum: each key gets its floor, and
 * the seconds left go to the largest remainders (ties in the given order). Rounding each row on its
 * own is what lets a column of figures miss its total by a second.
 */
export function wholeSeconds<K extends string>(values: Readonly<Partial<Record<K, number>>>, order: readonly K[]): Record<K, number> {
  const safe = (k: K) => Math.max(0, Number.isFinite(values[k]) ? (values[k] as number) : 0);
  const out = {} as Record<K, number>;
  // A hair of tolerance, so 0.1 + 0.2 + 0.7 still sums to the 1 it means.
  const total = Math.floor(order.reduce((sum, k) => sum + safe(k), 0) + 1e-6);
  let left = total;
  for (const k of order) {
    out[k] = Math.floor(safe(k));
    left -= out[k];
  }
  const byRemainder = [...order].sort((a, b) => safe(b) - Math.floor(safe(b)) - (safe(a) - Math.floor(safe(a))));
  for (let i = 0; left > 0 && byRemainder.length > 0; i++, left--) out[byRemainder[i % byRemainder.length]!]++;
  return out;
}

export type SpentRow = TimeSpentRow;

export const READING_LABELS = [
  { key: "reading-transcript", label: "Main Thread" },
  { key: "reading-alignments", label: "Alignments" },
  { key: "reading-workers", label: "Workers" },
] as const;

const OTHER_LABELS = [
  { key: "typing", label: "Typing" },
  { key: "dictating", label: "Dictating" },
  { key: "scrolling", label: "Scrolling" },
  { key: "changes", label: "Reviewing Changes" },
  { key: "screenshots", label: "Reviewing Screenshots" },
  { key: "tours", label: "Viewing Tours" },
  { key: "other", label: "Other" },
] as const;

export type SpentWord = "Counting" | "Paused" | "Not Recording";

/** What the page hasn't seen in a read yet: the tracker's live figures. */
export type SpentLive = {
  you: number;
  rows: Partial<Record<SpentRow, number>>;
  cards: Record<string, number>;
  word: SpentWord;
};

export type SpentLine = { key: string; label: string; seconds: number; parts?: SpentLine[] };

const MESSAGE_LABELS: readonly { key: TimeSpentMessageRow; label: string }[] = [
  { key: "directing", label: "Directing" },
  { key: "steering", label: "Steering" },
  { key: "reworking", label: "Reworking" },
  { key: "asking", label: "Asking" },
  { key: "unsorted", label: "Unsorted" },
  { key: "not-labelled", label: "Not Labelled" },
];

export type SpentMessage = { id: string; excerpt: string; seconds: number; labelledBy: string | null };
/** One row under Your Messages. `messages` is what it opens to; null on a row that opens to nothing. */
export type SpentMessageLine = { key: string; label: string; count: number | null; seconds: number; messages: SpentMessage[] | null };

export type SpentView = {
  word: SpentWord;
  you: number;
  agent: number;
  /** Your Time's rows with time, Reading first when it has any; its parts come with it. */
  reading: { seconds: number; parts: SpentLine[] } | null;
  rows: SpentLine[];
  /** Null with no message figures: the switch is off, or the session has none. */
  messages: SpentMessageLine[] | null;
  alignments: { docId: string; title: string; words: string }[];
};

/**
 * Your Messages in whole seconds: what the page hasn't reported yet has no message after it, so it is
 * Since Your Last Message's, and that row ticks with You. A row's messages add up to the row. Seconds
 * counted with the switch off are in no row, so the rows may add up to less than You.
 */
export function messageLines(messages: TimeSpentMessages, unreported: number): SpentMessageLine[] {
  const byKey = new Map(messages.rows.map((r) => [r.key, r]));
  const order = [...MESSAGE_LABELS.map((l) => l.key as string), "before-action", "since-last"];
  const seconds: Record<string, number> = { "before-action": messages.beforeAction.seconds, "since-last": messages.sinceLast + Math.max(0, unreported) };
  for (const r of messages.rows) seconds[r.key] = r.seconds;
  const whole = wholeSeconds<string>(seconds, order);
  const lines: SpentMessageLine[] = [];
  for (const { key, label } of MESSAGE_LABELS) {
    const row = byKey.get(key);
    if (!row || row.messages.length === 0) continue;
    const each = wholeSeconds<string>(Object.fromEntries(row.messages.map((m) => [m.id, m.seconds])), row.messages.map((m) => m.id));
    // A row's own rounding may differ from its messages' by a second: the longest message takes it.
    const longest = row.messages.reduce((a, b) => (b.seconds > a.seconds ? b : a));
    each[longest.id] = Math.max(0, each[longest.id]! + whole[key]! - row.messages.reduce((n, m) => n + each[m.id]!, 0));
    lines.push({
      key,
      label,
      count: row.messages.length,
      seconds: whole[key]!,
      messages: row.messages.map((m) => ({ id: m.id, excerpt: m.excerpt, seconds: each[m.id]!, labelledBy: m.labelledBy ?? null })),
    });
  }
  if (whole["before-action"]! > 0) lines.push({ key: "before-action", label: "Before An Action", count: messages.beforeAction.count, seconds: whole["before-action"]!, messages: null });
  if (whole["since-last"]! > 0) lines.push({ key: "since-last", label: "Since Your Last Message", count: null, seconds: whole["since-last"]!, messages: null });
  return lines;
}

/** Reviewing Screenshots by what followed; the row's whole seconds, its parts adding up to them. Seconds not in a read yet have no message after them. */
export function screenshotParts(split: NonNullable<TimeSpentRecord["screenshots"]>, seconds: number): SpentLine[] {
  const reworking = Math.min(seconds, Math.floor(split.reworking));
  const directing = Math.min(seconds - reworking, Math.floor(split.directing));
  return [
    { key: "screenshots-reworking", label: "Followed By Reworking", seconds: reworking },
    { key: "screenshots-directing", label: "Followed By Directing", seconds: directing },
    { key: "screenshots-other", label: "Followed By Anything Else", seconds: seconds - reworking - directing },
  ].filter((p) => p.seconds > 0);
}

/** One document's figures, in the copy deck's words; `to decided` is left out when it has none. */
export function alignmentWords(onScreen: number, toRead: number, toDecided: number | null): string {
  const parts = [`${formatSpent(onScreen)} on screen`, `${formatSpent(toRead)} to read`];
  if (toDecided !== null) parts.push(`${formatSpent(toDecided)} from first shown to decided`);
  return parts.join(" · ");
}

/**
 * What the section draws: record plus what the tracker hasn't reported, in whole seconds, so the rows
 * add up to You to the second and Reading's parts add up to Reading. Under Not Recording the live
 * seconds stay out: they aren't reaching a record, so You doesn't tick.
 * `record.agent` holds a running turn as of the read; `agentElapsed` is the seconds since that read.
 */
export function spentView(record: TimeSpentRecord, live: SpentLive, agentElapsed: number): SpentView {
  const counting = live.word !== "Not Recording";
  const sum: Partial<Record<SpentRow, number>> = {};
  for (const k of SPENT_ROWS) sum[k] = (record.rows[k] ?? 0) + (counting ? (live.rows[k] ?? 0) : 0);
  const whole = wholeSeconds<SpentRow>(sum, SPENT_ROWS);
  const parts = READING_LABELS.map((r) => ({ key: r.key as string, label: r.label, seconds: whole[r.key] })).filter((r) => r.seconds > 0);
  const readingSeconds = parts.reduce((n, p) => n + p.seconds, 0);
  const you = SPENT_ROWS.reduce((n, k) => n + whole[k], 0);
  const lines = record.messages ? messageLines(record.messages, you - record.you) : [];
  const messages = lines.length > 0 ? lines : null;
  return {
    word: live.word,
    you,
    agent: Math.floor(record.agent + (record.agentRunning === null ? 0 : Math.max(0, agentElapsed))),
    reading: readingSeconds > 0 ? { seconds: readingSeconds, parts } : null,
    rows: OTHER_LABELS.map((r) => {
      const line: SpentLine = { key: r.key, label: r.label, seconds: whole[r.key] };
      if (r.key === "screenshots" && record.screenshots && messages) line.parts = screenshotParts(record.screenshots, whole[r.key]);
      return line;
    }).filter((r) => r.seconds > 0),
    messages,
    alignments: record.alignments.map((d) => ({
      docId: d.docId,
      title: d.title,
      words: alignmentWords(d.onScreen + (counting ? (live.cards[d.docId] ?? 0) : 0), d.toRead, d.toDecided),
    })),
  };
}
