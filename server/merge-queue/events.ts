import { appendFileSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { MergeEvent, MergeEventInput, MergeEventsPage } from "../../shared/merge-queue";

/**
 * The merge queue's event memory, per project, beside queue.json (§app.merge-queue/activity):
 *
 *   <state>/merge-queue/<key>/events/YYYY-MM.jsonl   one MergeEvent per line, appended in `seq` order, by the month it
 *                                                    was recorded in (not its `at`); never rewritten, never trimmed
 *
 * Every change to a branch or to the queue is one event: its time, who made it, why (one plain sentence), and the run
 * and plan step it belongs to. `seq` grows by one per event, per queue, across restarts: at the first record after a
 * start the newest good line on disk says where it stands (a line torn by a stop mid-append is skipped; an empty newest
 * month falls back to the one before).
 */

const MONTH_RE = /^(\d{4}-\d{2})\.jsonl$/;
/** Longest `why`/`text` kept, and most `read` items: thread-supplied strings live here for good and reach the page. */
export const EVENT_TEXT_MAX = 300;
export const EVENT_LONG_TEXT_MAX = 2000;
export const EVENT_READ_MAX = 10;
/** How many of the newest events the log keeps in memory (the view reads VIEW_EVENTS of them). */
const TAIL = 200;

const clipText = (t: string, n: number): string => (t.length > n ? `${t.slice(0, n - 1).trimEnd()}…` : t);

/** An event as it is kept: strings capped, `read` capped, nothing undefined. */
export function tidyEvent(ev: MergeEvent): MergeEvent {
  const out = { ...ev } as MergeEvent & { text?: string; read?: string[] };
  out.why = clipText(String(out.why ?? ""), EVENT_TEXT_MAX);
  if (typeof out.text === "string") out.text = clipText(out.text, EVENT_LONG_TEXT_MAX);
  if (Array.isArray(out.read)) out.read = out.read.slice(0, EVENT_READ_MAX).map((r) => clipText(String(r), EVENT_TEXT_MAX));
  for (const k of Object.keys(out) as (keyof typeof out)[]) if (out[k] === undefined) delete out[k];
  return out;
}

const isEvent = (x: unknown): x is MergeEvent => !!x && typeof x === "object" && typeof (x as MergeEvent).seq === "number" && typeof (x as MergeEvent).kind === "string" && typeof (x as MergeEvent).at === "string";

/** What a read selects: one entry's, one run's, one branch's, or one actor's events; `before` a seq to page back. */
export interface EventQuery {
  entry?: string;
  run?: string;
  branch?: string;
  by?: MergeEvent["by"];
  kind?: MergeEvent["kind"];
  before?: number;
  limit?: number;
}

export class MergeEventLog {
  readonly dir: string;
  private seq: number | null = null;
  private tail: MergeEvent[] | null = null;

  constructor(
    queueDir: string,
    private readonly now: () => number = Date.now,
  ) {
    this.dir = join(queueDir, "events");
  }

  months(): string[] {
    try {
      return readdirSync(this.dir)
        .map((n) => MONTH_RE.exec(n)?.[1])
        .filter((m): m is string => !!m)
        .sort();
    } catch {
      return [];
    }
  }

  /** A month's events in file order; a damaged line (a torn append) is skipped. */
  readMonth(month: string): MergeEvent[] {
    let text: string;
    try {
      text = readFileSync(join(this.dir, `${month}.jsonl`), "utf8");
    } catch {
      return [];
    }
    const out: MergeEvent[] = [];
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try {
        const ev = JSON.parse(line) as unknown;
        if (isEvent(ev)) out.push(ev);
      } catch {}
    }
    return out;
  }

  /** The newest seq on disk (0: none), from the newest month that holds a good line. */
  private lastSeq(): number {
    const months = this.months();
    for (let i = months.length - 1; i >= 0; i--) {
      const list = this.readMonth(months[i]!);
      if (list.length) return list.reduce((m, e) => Math.max(m, e.seq), 0);
    }
    return 0;
  }

  /** Record one event: `seq` given, `at` defaulted, strings capped; appended at once. A write that fails is logged by
   *  the caller's `warn` and the event still answers (kept in memory), so recording never blocks the queue. */
  record(input: MergeEventInput, warn?: (line: string) => void): MergeEvent {
    if (this.seq === null) this.seq = this.lastSeq();
    // The memory tail is read before the append, so the new event is never in it twice.
    const tail = this.newest();
    const at = input.at ?? new Date(this.now()).toISOString();
    // Filed by the month it is RECORDED in (never its `at`, which may be earlier): seqs then only grow along the files,
    // so the newest month's last good line is always the newest seq.
    const month = new Date(this.now()).toISOString().slice(0, 7);
    const ev = tidyEvent({ ...input, seq: ++this.seq, at } as MergeEvent);
    try {
      mkdirSync(this.dir, { recursive: true });
      // A line that a stop tore leaves no newline: start on a fresh one so this event is never glued to it.
      appendFileSync(join(this.dir, `${month}.jsonl`), `${this.needsNewline(month) ? "\n" : ""}${JSON.stringify(ev)}\n`, { mode: 0o600 });
    } catch (err) {
      warn?.(`event ${ev.seq} (${ev.kind}) not written to ${this.dir}: ${err instanceof Error ? err.message : err}`);
    }
    tail.unshift(ev);
    if (tail.length > TAIL) tail.length = TAIL;
    return ev;
  }

  private newlineChecked = new Set<string>();
  /** Once per month file per start: does it end mid-line (a torn append)? */
  private needsNewline(month: string): boolean {
    if (this.newlineChecked.has(month)) return false;
    this.newlineChecked.add(month);
    try {
      const text = readFileSync(join(this.dir, `${month}.jsonl`), "utf8");
      return text.length > 0 && !text.endsWith("\n");
    } catch {
      return false;
    }
  }

  /** The newest events, newest first (at most TAIL), from memory once read. */
  newest(): MergeEvent[] {
    if (this.tail) return this.tail;
    const out: MergeEvent[] = [];
    const months = this.months();
    for (let i = months.length - 1; i >= 0 && out.length < TAIL; i--) out.push(...this.readMonth(months[i]!).reverse());
    this.tail = out.slice(0, TAIL);
    return this.tail;
  }

  /** A page of events matching `q`, newest first, the whole memory read (history included): newest months first,
   *  stopping once the page is full. */
  read(q: EventQuery = {}): MergeEventsPage {
    const limit = Math.max(1, Math.min(500, q.limit ?? 100));
    const match = (e: MergeEvent): boolean =>
      (q.before === undefined || e.seq < q.before) && (!q.entry || e.entry === q.entry) && (!q.run || e.run === q.run) && (!q.branch || e.branch === q.branch) && (!q.by || e.by === q.by) && (!q.kind || e.kind === q.kind);
    const out: MergeEvent[] = [];
    const months = this.months();
    for (let i = months.length - 1; i >= 0; i--) {
      const list = this.readMonth(months[i]!).filter(match).reverse();
      for (const e of list) {
        out.push(e);
        if (out.length > limit) return { events: out.slice(0, limit), more: true };
      }
    }
    return { events: out, more: false };
  }
}
