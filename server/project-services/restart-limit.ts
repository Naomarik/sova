import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { GiveUpRule, GiveUpView, RestartingView } from "../../shared/project-contract";
import { HOUR_MS, HOURLY_LIMIT, RESTART_BURST, RESTART_SEC, STABLE_RUN_SEC, type RestartFacts } from "./drivers";
import { servicesRoot } from "./store";

/**
 * The restart limit, as Sova's server holds a systemd unit to it (§app.project-services/supervisor): 5 failures
 * in a row (a run that stayed up STABLE_RUN_SEC before it failed starts a fresh count), or HOURLY_LIMIT within
 * any hour. It counts from systemd's own facts (NRestarts, the last run's start and exit), never by sampling
 * the unit's state, so failures that come and go between two looks are each counted. Its record of each unit
 * (`<state root>/project-services/limits/<unit>.json`) holds the count and, once it gave up, the give-up: the
 * source of truth, since stopping a transient unit unloads it and systemd forgets it. The detached driver keeps
 * its own count in its unit records (drivers.ts).
 */

/** The watch's tick, and its tick while a unit fails or is in a try: each failure then seen on its own (RestartSec is 2 s). */
export const LIMIT_TICK_MS = 10_000;
export const LIMIT_BUSY_TICK_MS = 1_000;

export interface LimitRecord {
  v: 1;
  /** The failures counted so far: systemd's NRestarts, plus the one it waits to restart after. */
  seen: number;
  /** The start (ms) of the run seen at the last look, null when none was known. */
  runAt: number | null;
  /** Whether that run had already failed at the last look. */
  failing: boolean;
  /** When it was looked at last (ms). */
  at: number;
  /** Its failures in a row. */
  inRow: number;
  /** When its failures within the last hour happened (ms). */
  recent: number[];
  /** Once the limit is reached: the give-up, kept until a start or down clears it. */
  giveUp?: GiveUpView;
}

/** A unit's count from nothing: a start by hand (up, Start, apply's or reset's restart), at `now`. */
export const freshRecord = (now: number): LimitRecord => ({ v: 1, seen: 0, runAt: now, failing: false, at: now, inRow: 0, recent: [] });

export interface Reached {
  rule: GiveUpRule;
  tries: number;
  /** The last try's time (ms). */
  at: number;
  exit: number | null;
}

/**
 * The count after a look at `f` at `now`, from the record `prev` of the look before (null: none; a unit
 * already running when Sova first looks), and whether the limit is reached (pure).
 *
 * New failures are NRestarts' growth since the last look. The newest, when the unit is failing now, is the
 * run systemd describes, its length known. The others ran unseen between the last look and the current run's
 * start: if they can't have lasted STABLE_RUN_SEC together they were quick, each counted in a row; if all but
 * the first can't, the first may have been slow and the rest count from it; else the last may have been slow
 * and the count starts afresh from it (never a give-up a slow service didn't earn). With no record, they
 * count in a row while the unit is failing or its current run is younger than STABLE_RUN_SEC (a loop under
 * way: a unit already over the limit gives up at once), else not at all.
 */
export function assess(prev: LimitRecord | null, f: RestartFacts, now: number): { rec: LimitRecord; reached: Reached | null } {
  const R = RESTART_SEC * 1000;
  const STABLE = STABLE_RUN_SEC * 1000;
  // At start-limit-hit, NRestarts counts the start systemd refused: no run of its own.
  const failures = f.limitHit ? f.restarts : f.restarts + (f.failing ? 1 : 0);
  // A count below the record's: systemd's was flushed (a start outside Sova): counted afresh.
  const known = prev !== null && failures >= prev.seen;
  const r: LimitRecord = known ? { ...prev!, recent: [...prev!.recent] } : { v: 1, seen: 0, runAt: null, failing: false, at: now, inRow: 0, recent: [] };
  const k = failures - r.seen;
  if (k > 0) {
    const unseen = k - (f.failing ? 1 : 0);
    const before = f.startAt ?? now;
    if (unseen > 0) {
      if (r.runAt === null) {
        // No record of an earlier look: a loop under way counts in a row.
        if (f.failing || f.startAt === null || now - f.startAt < STABLE) {
          r.inRow += unseen;
          for (let i = 0; i < unseen; i++) r.recent.push(before - R);
        } else r.inRow = 0;
      } else {
        // The unseen runs began after the last look's run started (after the look, when that run had already failed).
        const from = r.failing ? r.at : r.runAt;
        const firstAtLeast = r.failing ? 0 : Math.max(0, r.at - r.runAt);
        const span = before - from - unseen * R;
        if (span < STABLE) r.inRow += unseen;
        else if (unseen === 1 || span - firstAtLeast < STABLE) r.inRow = unseen;
        else r.inRow = 1;
        for (let i = 0; i < unseen; i++) r.recent.push(before - R);
      }
    }
    if (f.failing) {
      const ran = f.startAt !== null && f.exitAt !== null && f.exitAt >= f.startAt ? f.exitAt - f.startAt : null;
      r.inRow = (ran !== null && ran >= STABLE ? 0 : r.inRow) + 1;
      r.recent.push(f.exitAt ?? now);
    }
  }
  // A run that has stayed up STABLE_RUN_SEC: whatever it does next starts a fresh count in a row.
  if (!f.failing && f.startAt !== null && now - f.startAt >= STABLE) r.inRow = 0;
  r.recent = r.recent.filter((t) => now - t < HOUR_MS).slice(-HOURLY_LIMIT);
  r.seen = failures;
  r.runAt = f.startAt;
  r.failing = f.failing;
  r.at = now;
  const at = f.exitAt ?? now;
  const reached: Reached | null = f.limitHit
    ? { rule: "system-limit", tries: f.burst, at, exit: f.exit }
    : r.inRow >= RESTART_BURST
      ? { rule: "in-a-row", tries: r.inRow, at, exit: f.exit }
      : r.recent.length >= HOURLY_LIMIT
        ? { rule: "in-an-hour", tries: r.recent.length, at, exit: f.exit }
        : null;
  return { rec: r, reached };
}

/** The try a unit is in or waits for while it is within the limit, from its failures in a row; none when it has none. */
export const restartingOf = (inRow: number): RestartingView | undefined => (inRow > 0 && inRow < RESTART_BURST ? { try: inRow + 1, of: 5 } : undefined);

/** Whether two records count the same (when it was looked at aside): the watch writes only a change. */
export const sameCount = (a: LimitRecord | null, b: LimitRecord): boolean =>
  !!a && a.seen === b.seen && a.runAt === b.runAt && a.failing === b.failing && a.inRow === b.inRow && a.recent.length === b.recent.length && a.recent.every((t, i) => t === b.recent[i]) && !a.giveUp === !b.giveUp;

// ---- the records ------------------------------------------------------------------------------

export const limitsDir = () => join(servicesRoot(), "limits");
const fileOf = (unit: string) => join(limitsDir(), `${unit}.json`);

export function readLimit(unit: string): LimitRecord | null {
  try {
    const r = JSON.parse(readFileSync(fileOf(unit), "utf8")) as LimitRecord;
    return r && r.v === 1 && typeof r.seen === "number" && Array.isArray(r.recent) ? r : null;
  } catch {
    return null;
  }
}

/** Written whole or not at all: a temp file beside it, then a rename. */
export function writeLimit(unit: string, rec: LimitRecord): void {
  mkdirSync(limitsDir(), { recursive: true });
  const file = fileOf(unit);
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  try {
    writeFileSync(tmp, `${JSON.stringify(rec)}\n`, { mode: 0o600 });
    renameSync(tmp, file);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
}

export function forgetLimit(unit: string): void {
  rmSync(fileOf(unit), { force: true });
}

/** The units with a record whose name starts with `prefix`. */
export function limitUnits(prefix: string): string[] {
  try {
    return readdirSync(limitsDir())
      .filter((f) => f.endsWith(".json") && f.startsWith(prefix))
      .map((f) => f.slice(0, -5));
  } catch {
    return [];
  }
}
