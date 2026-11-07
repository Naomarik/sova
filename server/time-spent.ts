// Time Spent's record (§app.subagents-pane/time-spent-record): one clock per computer, and one
// append-only file per session under <state root>/attention/, beside the sessions and never in them.
//
// A page reports runs of seconds with how old each is. This computer places them on its own clock at
// receipt, so a page's wrong clock changes nothing. Each moment belongs to one page: the one with the
// newest real input. Reports arrive late, so a moment already written can be lost to a later report:
// the loser's file then gets a line taking those seconds back. Sums replay the file, so a session's
// rows always add up to its total, and a second counted anywhere on this computer is counted once.

import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from "node:fs";
import { join } from "node:path";
import { TIME_SPENT_ROWS, type TimeSpentReport, type TimeSpentRow } from "../shared/time-spent";
import { stateRoot } from "./state-root";

/** How long the clock remembers who holds a moment. An older run can't be told from one already counted, so it is dropped. */
export const CLOCK_MEMORY_MS = 6 * 3_600_000;
/** How far a page's next run may land from the end of its last and still continue it: the time a request takes
    moves where a run lands by a second or two, and those seconds are the page's own, neither lost nor doubled. */
const SAME_PAGE_DRIFT_S = 2;

const ROWS = new Set<string>(TIME_SPENT_ROWS);

/** Seconds on this computer's clock, [start, end). */
interface Claim {
  start: number;
  end: number;
  page: string;
  /** This computer's time (ms) of the page's newest real input known for this run. */
  inputAt: number;
  session: string;
  row: TimeSpentRow;
  docs: readonly string[];
}

/** One line of a session's file. */
interface Line extends TimeSpentRun {
  d?: readonly string[];
}

/** Counted seconds [s, e) on this computer's clock, and what they were spent on. */
export interface TimeSpentRun {
  s: number;
  e: number;
  r: TimeSpentRow;
}

export interface TimeSpentSums {
  you: number;
  rows: Partial<Record<TimeSpentRow, number>>;
  /** Per alignment document: counted seconds on screen, and the first moment (ms) it was. */
  docs: Map<string, { onScreen: number; firstShownAt: number }>;
}

const sameDocs = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((d, i) => d === b[i]);

/** A session id as a file name: a session file's name is checked, but this is what stands between it and a path. */
const safeId = (id: string) => /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id);

export class TimeSpentStore {
  /** Who holds each remembered moment, oldest first, never overlapping. */
  private held: Claim[] = [];
  /** Where each page's last run ended, and the runs it has had recorded (id to where the run ended). */
  private pages = new Map<string, { end: number; runs: Map<number, number> }>();
  /** Each session's last line, while its file can still take a merge. */
  private tails = new Map<string, { offset: number; line: Line }>();

  constructor(readonly dir: string) {}

  /** When this computer began keeping Time Spent; a session begun earlier has time it never recorded. */
  since(now = Date.now()): number {
    const file = join(this.dir, "since");
    try {
      const at = Date.parse(readFileSync(file, "utf8").trim());
      if (Number.isFinite(at)) return at;
    } catch { /* first time */ }
    mkdirSync(this.dir, { recursive: true });
    writeFileSync(file, `${new Date(now).toISOString()}\n`);
    return now;
  }

  /** Puts a report's runs on the clock and writes what it won. */
  report(session: string, report: Pick<TimeSpentReport, "pageId" | "inputAgeMs" | "slices">, now = Date.now()): void {
    if (!safeId(session)) return;
    this.forget(now);
    const received = Math.floor(now / 1000);
    const inputAt = now - Math.max(0, report.inputAgeMs);
    for (const slice of report.slices) {
      const page = this.pages.get(report.pageId);
      // A resend after a lost answer: already on the record, wherever it would land now.
      if (slice.id !== undefined && page?.runs.has(slice.id)) continue;
      let end = Math.min(received, Math.round((now - Math.max(0, slice.ageMs)) / 1000));
      let start = end - slice.sec;
      if (start * 1000 < now - CLOCK_MEMORY_MS) continue;
      const last = page?.end;
      if (last !== undefined && Math.abs(start - last) <= SAME_PAGE_DRIFT_S) {
        // Bounded by the check above: a page can't get more than the drift ahead of this computer's time.
        start = last;
        end = start + slice.sec;
      }
      this.claim({
        start,
        end,
        page: report.pageId,
        // A run can't claim input that came after it: a report sent long after its seconds speaks for its own moment only.
        inputAt: Math.min(inputAt, end * 1000),
        session,
        row: slice.row,
        docs: slice.docs,
      });
      // Only now: a report whose write failed is answered as a failure, and its resend must still count.
      const seen = page ?? { end: 0, runs: new Map<number, number>() };
      seen.end = Math.max(seen.end, end);
      if (slice.id !== undefined) seen.runs.set(slice.id, end);
      this.pages.set(report.pageId, seen);
    }
  }

  /** The record's sums. A line that can't be read (a torn write) counts for nothing. */
  sums(session: string): TimeSpentSums {
    const out: TimeSpentSums = { you: 0, rows: {}, docs: new Map() };
    const { runs, firstShown } = this.replay(session);
    for (const r of runs) {
      const sec = r.e - r.s;
      out.you += sec;
      out.rows[r.r] = (out.rows[r.r] ?? 0) + sec;
      for (const d of r.d ?? []) {
        const doc = out.docs.get(d) ?? { onScreen: 0, firstShownAt: firstShown.get(d)! };
        doc.onScreen += sec;
        out.docs.set(d, doc);
      }
    }
    for (const [d, at] of firstShown) if (!out.docs.has(d)) out.docs.set(d, { onScreen: 0, firstShownAt: at });
    return out;
  }

  /** The counted seconds as runs on this computer's clock, what `sums` adds up: they add up to its `you`. */
  runs(session: string): readonly TimeSpentRun[] {
    return this.replay(session).runs;
  }

  /** The file replayed: its runs after every take-back, and each document's first moment on screen. */
  private replay(session: string): { runs: Line[]; firstShown: Map<string, number> } {
    const runs: Line[] = [];
    const firstShown = new Map<string, number>();
    if (!safeId(session)) return { runs, firstShown };
    let text: string;
    try {
      text = readFileSync(this.file(session), "utf8");
    } catch {
      return { runs, firstShown };
    }
    for (const raw of text.split("\n")) {
      if (!raw) continue;
      let l: any;
      try {
        l = JSON.parse(raw);
      } catch {
        continue;
      }
      if (Array.isArray(l?.x)) {
        takeBack(runs, l.x[0], l.x[1]);
        continue;
      }
      if (!ROWS.has(l?.r) || !Number.isInteger(l.s) || !Number.isInteger(l.e) || l.e <= l.s) continue;
      runs.push(l);
      // A moment later lost to another page was still on screen: first shown stays.
      for (const d of l.d ?? []) if (!firstShown.has(d)) firstShown.set(d, l.s * 1000);
    }
    return { runs, firstShown };
  }

  /** The session is gone: its record goes with it, and the clock forgets it held any moment. */
  remove(session: string): void {
    if (!safeId(session)) return;
    rmSync(this.file(session), { force: true });
    this.tails.delete(session);
    this.held = this.held.filter((c) => c.session !== session);
  }

  private file(session: string): string {
    return join(this.dir, `${session}.jsonl`);
  }

  private forget(now: number): void {
    const before = Math.floor((now - CLOCK_MEMORY_MS) / 1000);
    this.held = this.held.filter((c) => c.end > before);
    for (const [id, page] of this.pages) {
      if (page.end <= before) {
        this.pages.delete(id);
        continue;
      }
      // A resend this old is dropped by its age, so its id needn't be kept.
      for (const [run, end] of page.runs) if (end <= before) page.runs.delete(run);
    }
  }

  private claim(run: Claim): void {
    const kept: Claim[] = [];
    const free: [number, number][] = [];
    let cursor = run.start;
    const lost = new Map<string, [number, number][]>();
    for (const c of this.held) {
      if (c.end <= run.start || c.start >= run.end) {
        kept.push(c);
        continue;
      }
      if (c.start > cursor) free.push([cursor, c.start]);
      const from = Math.max(c.start, run.start);
      const to = Math.min(c.end, run.end);
      cursor = Math.max(cursor, to);
      // The same page reporting a moment again (a retry whose answer was lost) adds nothing, and an
      // equal input leaves the moment with the page already holding it.
      if (c.page === run.page || c.inputAt >= run.inputAt) {
        kept.push(c);
        continue;
      }
      free.push([from, to]);
      if (c.start < from) kept.push({ ...c, end: from });
      if (c.end > to) kept.push({ ...c, start: to });
      const taken = lost.get(c.session) ?? [];
      taken.push([from, to]);
      lost.set(c.session, taken);
    }
    if (cursor < run.end) free.push([cursor, run.end]);
    for (const [session, spans] of lost) for (const [from, to] of spans) this.writeTakeBack(session, from, to);
    for (const [start, end] of joined(free)) {
      kept.push({ ...run, start, end });
      this.writeRun(run.session, { s: start, e: end, r: run.row, ...(run.docs.length ? { d: run.docs } : {}) });
    }
    this.held = kept.sort((a, b) => a.start - b.start);
  }

  private writeTakeBack(session: string, from: number, to: number): void {
    const file = this.file(session);
    // A record removed with its session stays removed.
    if (!existsSync(file)) return;
    appendFileSync(file, `${JSON.stringify({ x: [from, to] })}\n`);
    this.tails.delete(session);
  }

  /** Appends a run, or grows the file's last line when the run continues it. Numbers only grow, so a merged
      line never leaves part of the old one behind. */
  private writeRun(session: string, line: Line): void {
    const file = this.file(session);
    const tail = this.tails.get(session);
    if (tail && tail.line.e === line.s && tail.line.r === line.r && sameDocs(tail.line.d ?? [], line.d ?? [])) {
      const merged: Line = { ...tail.line, e: line.e };
      const bytes = Buffer.from(`${JSON.stringify(merged)}\n`);
      const fd = openSync(file, "r+");
      try {
        writeSync(fd, bytes, 0, bytes.length, tail.offset);
      } finally {
        closeSync(fd);
      }
      this.tails.set(session, { offset: tail.offset, line: merged });
      return;
    }
    mkdirSync(this.dir, { recursive: true });
    let offset = 0;
    try {
      offset = statSync(file).size;
    } catch { /* a new file */ }
    appendFileSync(file, `${JSON.stringify(line)}\n`);
    this.tails.set(session, { offset, line });
  }
}

/** Adjacent spans as one, so one report's run stays one line. */
function joined(spans: [number, number][]): [number, number][] {
  const out: [number, number][] = [];
  for (const [from, to] of [...spans].sort((a, b) => a[0] - b[0])) {
    const last = out[out.length - 1];
    if (last && last[1] === from) last[1] = to;
    else if (to > from) out.push([from, to]);
  }
  return out;
}

/** Cuts [from, to) out of the runs so far. */
function takeBack(runs: Line[], from: unknown, to: unknown): void {
  if (typeof from !== "number" || typeof to !== "number") return;
  for (let i = runs.length - 1; i >= 0; i--) {
    const r = runs[i]!;
    if (r.e <= from || r.s >= to) continue;
    const pieces: Line[] = [];
    if (r.s < from) pieces.push({ ...r, e: from });
    if (r.e > to) pieces.push({ ...r, s: to });
    runs.splice(i, 1, ...pieces);
  }
}

const stores = new Map<string, TimeSpentStore>();

/** This computer's clock: one per state root, read per call as every state path is. */
export function timeSpentStore(): TimeSpentStore {
  const dir = join(stateRoot(), "attention");
  let store = stores.get(dir);
  if (!store) stores.set(dir, (store = new TimeSpentStore(dir)));
  return store;
}

/** A deleted session's record goes with it. Never in the way of the delete itself: the transcript is already gone. */
export function removeSessionTimeSpent(session: string): void {
  try {
    timeSpentStore().remove(session);
  } catch (err) {
    console.error("[time-spent] could not remove a deleted session's record", err);
  }
}
