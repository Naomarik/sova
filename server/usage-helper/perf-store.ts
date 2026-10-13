import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import type { UsageDevice, UsageRange } from "../../shared/usage/wire";
import type { ReplyTiming, UsagePerformance } from "../../shared/usage/perf";
import { parsePerfRecordLine } from "../perf-record";
import { normalizeTiming, performanceRows, type PerfSample } from "./perf";
import { displayModel, modelFilterKey, validZone } from "./query";

/**
 * The usage helper's reader of the reply-timing store (`<agent dir>/usage/perf/v1/<UTC day>/<producer>.jsonl`,
 * one line per measured reply, written by each chat process): every record in memory (a few hundred
 * bytes each), deduplicated by key, indexed by session. Files are read from where the last read
 * stopped (whole lines only); a gzipped day file is read whole. The newest days are looked at on
 * every ask, every day at most once a minute. Synchronous, in the helper child only.
 */

/** One stored reply, as the reader keeps it. */
export interface PerfStored {
  key: string;
  ts: number;
  sid: string;
  entryId: string;
  provider: string;
  model: string;
  responseModel?: string;
  timing: ReplyTiming;
}

/** The answer to `session-timings`: one session's measured replies by entry id. `v` changes whenever
    they do (a row builder's cache key). */
export interface SessionTimings {
  v: string;
  timings: Record<string, ReplyTiming>;
}

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const FILE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}\.jsonl(\.gz)?$/;
const DAY_MS = 86_400_000;
const FULL_SWEEP_MS = 60_000;
const addDays = (day: string, n: number) => new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);

/**
 * A store line as the reader keeps it, or null when it isn't a finished reply's record (the record's
 * contract and strict parse are its writer's, server/perf-record.ts).
 */
export function parsePerfLine(line: string): PerfStored | null {
  const r = parsePerfRecordLine(line);
  if (!r) return null;
  const timing: ReplyTiming = { ttftMs: r.ttftMs, thinkingMs: r.thinkingMs, replyMs: r.replyMs, output: r.output };
  if (r.effort !== undefined) timing.effort = r.effort;
  if (r.reasoning !== undefined) timing.reasoning = r.reasoning;
  if (r.tool.n > 0) timing.toolCalls = r.tool.n;
  if (r.thinking.n > 0) timing.thinkingParts = r.thinking.n;
  const out: PerfStored = { key: r.key, ts: r.ts, sid: r.sid, entryId: r.entryId, provider: r.provider, model: r.model, timing: normalizeTiming(timing) };
  if (r.responseModel !== undefined) out.responseModel = r.responseModel;
  return out;
}

interface FileState {
  size: number;
  mtimeMs: number;
  /** Bytes consumed (whole lines) of a plain file. */
  off: number;
}

export interface PerfStoreOptions {
  /** `<agent dir>/usage/perf/v1`. */
  root: string;
  device?: () => string | null;
  now?: () => number;
}

export class PerfStore {
  private readonly root: string;
  private readonly device: () => UsageDevice;
  private readonly now: () => number;
  private readonly files = new Map<string, FileState>();
  private readonly byKey = new Map<string, PerfStored>();
  private readonly bySid = new Map<string, Map<string, PerfStored>>();
  /** Bumped per record added: a session's `v` is its count and this. */
  private seq = 0;
  private readonly sidSeq = new Map<string, number>();
  private lastSweep = -Infinity;
  private first: number | null = null;
  private readonly zones = new Map<string, Intl.DateTimeFormat>();

  constructor(opts: PerfStoreOptions) {
    this.root = opts.root;
    this.device = () => ({ id: opts.device?.() ?? null, self: true });
    this.now = opts.now ?? Date.now;
  }

  /** Records read so far (tests, stats). */
  get size(): number {
    return this.byKey.size;
  }

  /** Read what's new: the newest days always, every day at most once a minute (or `full`). */
  refresh(full = false): void {
    let days: string[];
    try {
      days = fs.readdirSync(this.root).filter((d) => DAY_RE.test(d)).sort();
    } catch {
      return;
    }
    const now = this.now();
    const sweep = full || now - this.lastSweep >= FULL_SWEEP_MS;
    if (sweep) this.lastSweep = now;
    const recent = new Set([new Date(now - DAY_MS), new Date(now)].map((d) => d.toISOString().slice(0, 10)));
    for (const d of days.slice(-2)) recent.add(d);
    for (const day of days) if (sweep || recent.has(day)) this.readDay(day);
  }

  private readDay(day: string): void {
    const dir = path.join(this.root, day);
    let names: string[];
    try {
      names = fs.readdirSync(dir).filter((n) => FILE_RE.test(n));
    } catch {
      return;
    }
    for (const name of names) this.readFile(path.join(dir, name));
  }

  private readFile(file: string): void {
    let st: fs.Stats;
    try {
      st = fs.statSync(file);
    } catch {
      return;
    }
    const had = this.files.get(file);
    if (had && had.size === st.size && had.mtimeMs === st.mtimeMs) return;
    const gz = file.endsWith(".gz");
    try {
      if (gz) {
        this.addText(zlib.gunzipSync(fs.readFileSync(file)).toString("utf8"), true);
        this.files.set(file, { size: st.size, mtimeMs: st.mtimeMs, off: st.size });
        return;
      }
      // Shrunk (rewritten): read it again from the start; dedup by key keeps it counted once.
      const from = had && st.size >= had.off ? had.off : 0;
      const len = st.size - from;
      const buf = Buffer.alloc(len);
      const fd = fs.openSync(file, "r");
      try {
        fs.readSync(fd, buf, 0, len, from);
      } finally {
        fs.closeSync(fd);
      }
      const end = buf.lastIndexOf(10) + 1;
      if (end > 0) this.addText(buf.subarray(0, end).toString("utf8"), false);
      this.files.set(file, { size: st.size, mtimeMs: st.mtimeMs, off: from + end });
    } catch {
      // Unreadable now: tried again on its next change.
    }
  }

  private addText(text: string, whole: boolean): void {
    const lines = text.split("\n");
    // A gzipped file's last line may lack its newline.
    if (!whole) lines.pop();
    for (const line of lines) {
      if (!line) continue;
      const rec = parsePerfLine(line);
      if (rec) this.add(rec);
    }
  }

  /** One record, once per key. */
  add(rec: PerfStored): void {
    if (this.byKey.has(rec.key)) return;
    this.byKey.set(rec.key, rec);
    let s = this.bySid.get(rec.sid);
    if (!s) this.bySid.set(rec.sid, (s = new Map()));
    s.set(rec.entryId, rec);
    this.sidSeq.set(rec.sid, ++this.seq);
    if (this.first === null || rec.ts < this.first) this.first = rec.ts;
  }

  /** `session-timings`: one session's measured replies, by the entry each was written as. */
  sessionTimings(sid: string): SessionTimings {
    this.refresh();
    const s = this.bySid.get(sid);
    const timings: Record<string, ReplyTiming> = {};
    if (s) for (const [entryId, rec] of s) timings[entryId] = rec.timing;
    return { v: `${s?.size ?? 0}.${this.sidSeq.get(sid) ?? 0}`, timings };
  }

  private localDay(tz: string): (ms: number) => string {
    let fmt = this.zones.get(tz);
    if (!fmt) this.zones.set(tz, (fmt = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" })));
    return (ms) => fmt.format(ms);
  }

  /** `performance`: the Performance tab, under one range and one filter. */
  performance(q: { range: UsageRange; providers: string[]; models: string[]; tz: string }): UsagePerformance {
    this.refresh();
    const tz = validZone(q.tz);
    const now = this.now();
    const ld = this.localDay(tz);
    const today = ld(now);
    const from = q.range === "all" ? null : addDays(today, q.range === "7d" ? -6 : -29);
    const pset = new Set(q.providers);
    const mset = new Set(q.models.map((k) => modelFilterKey(k, now)));
    const facetP = new Set<string>();
    const facetM = new Map<string, { provider: string; model: string }>();
    const samples: PerfSample[] = [];
    // Records outside the range by more than a day can't be in it in any zone: skipped unformatted.
    const lo = from ? Date.parse(`${addDays(from, -1)}T00:00:00Z`) : -Infinity;
    const hi = Date.parse(`${addDays(today, 2)}T00:00:00Z`);
    for (const rec of this.byKey.values()) {
      if (rec.ts < lo || rec.ts >= hi) continue;
      const day = ld(rec.ts);
      if ((from && day < from) || day > today) continue;
      const model = displayModel(rec.provider, rec.model, rec.responseModel, rec.ts).model;
      const mk = `${rec.provider}/${model}`;
      facetP.add(rec.provider);
      if (!facetM.has(mk)) facetM.set(mk, { provider: rec.provider, model });
      if (pset.size && !pset.has(rec.provider)) continue;
      if (mset.size && !mset.has(mk)) continue;
      samples.push({ provider: rec.provider, model, timing: rec.timing });
    }
    return {
      device: this.device(),
      range: q.range,
      asOf: now,
      since: this.first === null ? null : new Date(this.first).toISOString(),
      providers: q.providers,
      models: q.models,
      facets: {
        providers: [...facetP].sort(),
        models: [...facetM.values()].sort((a, b) => a.provider.localeCompare(b.provider) || a.model.localeCompare(b.model)),
      },
      rows: performanceRows(samples),
    };
  }
}
