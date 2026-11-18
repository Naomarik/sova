import fs from "node:fs";
import path from "node:path";
import { TIME_SPENT_ROWS, type TimeSpentRow } from "../../shared/time-spent";
import { replayAttention, type TimeSpentRun } from "../time-spent-replay";

/**
 * The usage helper's reader of your time: every session's Time Spent record on this computer
 * (`<state root>/attention/<session>.jsonl`, written by server/time-spent.ts), replayed the same way
 * the server sums it. Those files are not append-only (a run's line grows in place, a take-back cuts
 * earlier runs), so a session's whole file is folded again whenever its size or mtime changes.
 *
 * A session's file goes with the session; its hours don't. The reader keeps a durable rollup of
 * your time (one line per session × 15-minute bucket × activity, with the session's folder) in its
 * own append-only file outside the ledger's snapshots: a bucket is written once it can no longer
 * change (older than the clock's memory), and every bucket left is written the moment the reader
 * sees the file gone. A session without a file counts from its rollup lines.
 */

export const ATTENTION_BUCKET_MS = 15 * 60_000;
/** server/time-spent.ts CLOCK_MEMORY_MS: no run older than this is written, cut or grown. */
const SETTLED_MS = 6 * 3_600_000 + ATTENTION_BUCKET_MS;
const ROWS = new Set<string>(TIME_SPENT_ROWS);
const SESSION_FILE = /^([A-Za-z0-9][A-Za-z0-9._-]*)\.jsonl$/;

/** Where a session ran, as the ledger knows it (or as its rollup line kept it). */
export interface SessionPlace {
  cwd: string | null;
  project: string | null;
  kind: "main" | "worker" | "overseer" | null;
}

/** A gone session's seconds in one 15-minute bucket on one activity. */
export interface RollupLine extends SessionPlace {
  sid: string;
  /** Bucket start, ms epoch. */
  b: number;
  r: TimeSpentRow;
  sec: number;
}

export interface AttentionOptions {
  /** `<state root>/attention`. */
  dir: string;
  /** The rollup's file (`<state root>/usage-time/you-v1.jsonl`). */
  rollupPath: string;
  /** Where a session ran, at the time a bucket is written. */
  place?: (sid: string) => SessionPlace | null;
  now?: () => number;
  log?: (line: string) => void;
}

/** A run's seconds by 15-minute bucket start (ms). */
export function bucketsOf(run: TimeSpentRun, out: Map<number, number> = new Map()): Map<number, number> {
  let s = run.s * 1000;
  const e = run.e * 1000;
  while (s < e) {
    const b = Math.floor(s / ATTENTION_BUCKET_MS) * ATTENTION_BUCKET_MS;
    const to = Math.min(e, b + ATTENTION_BUCKET_MS);
    out.set(b, (out.get(b) ?? 0) + (to - s) / 1000);
    s = to;
  }
  return out;
}

export class AttentionStore {
  private readonly files = new Map<string, { size: number; mtimeMs: number; runs: TimeSpentRun[] }>();
  /** Per session: the newest bucket start already in the rollup. */
  private readonly rolled = new Map<string, number>();
  private readonly rollup: RollupLine[] = [];
  private seq = 0;
  private rollupRead = false;
  private readonly now: () => number;
  private readonly log: (line: string) => void;

  constructor(private readonly opts: AttentionOptions) {
    this.now = opts.now ?? Date.now;
    this.log = opts.log ?? (() => {});
  }

  /** Bumped whenever any session's runs or the rollup change. */
  get version(): number {
    return this.seq;
  }

  /** When this computer began keeping Time Spent (its `since` file), or the first run's, or null. */
  since(): number | null {
    try {
      const at = Date.parse(fs.readFileSync(path.join(this.opts.dir, "since"), "utf8").trim());
      if (Number.isFinite(at)) return at;
    } catch { /* not yet */ }
    let first: number | null = null;
    for (const f of this.files.values()) for (const r of f.runs) if (first === null || r.s * 1000 < first) first = r.s * 1000;
    for (const l of this.rollup) if (first === null || l.b < first) first = l.b;
    return first;
  }

  /** Living sessions' runs, by session id. */
  live(): ReadonlyMap<string, { runs: readonly TimeSpentRun[] }> {
    return this.files;
  }

  /** Gone sessions' rollup lines (a living session's are in its runs). */
  *gone(): Generator<RollupLine> {
    for (const l of this.rollup) if (!this.files.has(l.sid)) yield l;
  }

  /** Read what changed: fold again each file whose size or mtime moved; a vanished file's buckets go to the rollup.
      Then write the buckets that settled. */
  refresh(): void {
    this.readRollup();
    let names: string[];
    try {
      names = fs.readdirSync(this.opts.dir);
    } catch {
      names = [];
    }
    const seen = new Set<string>();
    for (const name of names) {
      const m = SESSION_FILE.exec(name);
      if (!m) continue;
      const sid = m[1]!;
      seen.add(sid);
      const file = path.join(this.opts.dir, name);
      let st: fs.Stats;
      try {
        st = fs.statSync(file);
      } catch {
        seen.delete(sid);
        continue;
      }
      const had = this.files.get(sid);
      if (had && had.size === st.size && had.mtimeMs === st.mtimeMs) continue;
      let text: string;
      try {
        text = fs.readFileSync(file, "utf8");
      } catch {
        continue;
      }
      this.files.set(sid, { size: st.size, mtimeMs: st.mtimeMs, runs: replayAttention(text).runs.map(({ s, e, r }) => ({ s, e, r })) });
      this.seq++;
    }
    for (const sid of [...this.files.keys()]) {
      if (seen.has(sid)) continue;
      // Gone: every bucket not yet kept is kept now, then the session counts from the rollup.
      this.write(sid, Infinity);
      this.files.delete(sid);
      this.seq++;
    }
    const settled = this.now() - SETTLED_MS;
    for (const sid of this.files.keys()) this.write(sid, settled);
  }

  /** The session is about to be deleted: its file is read now and every bucket not yet kept is kept, so its
      latest hours stay even if this reader is down when the file goes. Unknown or unreadable: nothing. */
  keep(sid: string): void {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(sid)) return;
    this.readRollup();
    const file = path.join(this.opts.dir, `${sid}.jsonl`);
    try {
      const st = fs.statSync(file);
      this.files.set(sid, { size: st.size, mtimeMs: st.mtimeMs, runs: replayAttention(fs.readFileSync(file, "utf8")).runs.map(({ s, e, r }) => ({ s, e, r })) });
    } catch {
      return;
    }
    this.seq++;
    this.write(sid, Infinity);
  }

  /** Writes the session's buckets after its newest kept one that end by `until`. */
  private write(sid: string, until: number): void {
    const f = this.files.get(sid);
    if (!f) return;
    const after = this.rolled.get(sid) ?? -Infinity;
    const by = new Map<string, number>();
    let newest = after;
    for (const run of f.runs) {
      if (run.e * 1000 <= after + ATTENTION_BUCKET_MS) continue;
      for (const [b, sec] of bucketsOf(run)) {
        if (b <= after || b + ATTENTION_BUCKET_MS > until) continue;
        const k = `${b}\u001f${run.r}`;
        by.set(k, (by.get(k) ?? 0) + sec);
        if (b > newest) newest = b;
      }
    }
    if (!by.size) return;
    const place = this.opts.place?.(sid) ?? { cwd: null, project: null, kind: null };
    const lines: RollupLine[] = [...by].map(([k, sec]) => {
      const [b, r] = k.split("\u001f");
      return { sid, b: Number(b), r: r as TimeSpentRow, sec: Math.round(sec), cwd: place.cwd, project: place.project, kind: place.kind };
    });
    try {
      fs.mkdirSync(path.dirname(this.opts.rollupPath), { recursive: true });
      fs.appendFileSync(this.opts.rollupPath, lines.map((l) => `${JSON.stringify(l)}\n`).join(""));
    } catch (err) {
      this.log(`could not keep your time's rollup: ${String(err)}`);
      return;
    }
    this.rollup.push(...lines);
    this.rolled.set(sid, newest);
    this.seq++;
  }

  /** The rollup as kept, once (only this reader appends to it). A torn line counts for nothing. */
  private readRollup(): void {
    if (this.rollupRead) return;
    this.rollupRead = true;
    let text = "";
    try {
      text = fs.readFileSync(this.opts.rollupPath, "utf8");
    } catch {
      return;
    }
    // A torn last line (a crash mid-write) is cut, so the next line starts clean.
    const end = text.lastIndexOf("\n") + 1;
    if (end < text.length) {
      try {
        fs.truncateSync(this.opts.rollupPath, end);
      } catch { /* read-only: the torn line is skipped below */ }
    }
    for (const raw of text.slice(0, end).split("\n")) {
      if (!raw) continue;
      let l: any;
      try {
        l = JSON.parse(raw);
      } catch {
        continue;
      }
      if (typeof l?.sid !== "string" || !Number.isFinite(l.b) || !ROWS.has(l.r) || !(typeof l.sec === "number" && l.sec > 0)) continue;
      const str = (v: unknown) => (typeof v === "string" ? v : null);
      const kind = l.kind === "main" || l.kind === "worker" || l.kind === "overseer" ? l.kind : null;
      this.rollup.push({ sid: l.sid, b: l.b, r: l.r, sec: l.sec, cwd: str(l.cwd), project: str(l.project), kind });
      if (l.b > (this.rolled.get(l.sid) ?? -Infinity)) this.rolled.set(l.sid, l.b);
    }
    this.seq++;
  }
}
