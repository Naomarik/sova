import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import type { PriceBook } from "./price-book";
import type { PriceTable } from "../../shared/model-prices/prices";
import { parseLine, type UsageRec } from "./records";

/**
 * The usage helper's rollup (§app.insights/usage-ledger): follows every producer file under
 * `<agent dir>/usage/v1/<UTC day>/`, deduplicates by key and folds each record into a row per
 * 15-minute bucket, owner, model and price period. Synchronous and single-threaded: it runs in the
 * helper child, never on the server's loop.
 *
 * Per UTC day one snapshot `<state>/days/<day>.snap` (written atomically) holds how far each file
 * was read, the rows, and the day's key hashes; offsets, rows and keys are always saved together,
 * so a restart resumes exactly where the last save stood and nothing is counted twice or lost
 * (anything read after that save is read again, and its keys are not in the saved set).
 *
 * A row never spans a price change: its key includes the price key, the period it was in and the
 * context tier each of its calls fell in. When the price history changes, a day whose rows no
 * longer sit wholly inside their period is folded again from its records.
 *
 * A day closes once it ended `CLOSE_GRACE_MS` ago and every file was read to its end: its files are
 * gzipped and its key set dropped. A file that turns up later in a closed day reopens the day (a
 * fold from all its records) and it closes again.
 */

export const BUCKET_MS = 15 * 60_000;
export const CLOSE_GRACE_MS = 2 * 60 * 60_000;
const DAY_MS = 86_400_000;
const READ_CHUNK = 4 * 1024 * 1024;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const FILE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}\.jsonl$/;

/** The dimensions a row is keyed by, besides its bucket and price band. */
export const DIMS = ["owner", "parent", "worker", "kind", "purpose", "cwd", "project", "src", "provider", "model", "responseModel", "starter"] as const;
export type Dim = (typeof DIMS)[number];

export interface Row {
  /** Bucket start, ms epoch. */
  b: number;
  d: (string | null)[];
  /** Price status at fold time: a key (`anthropic/claude-opus-5-5`), `free:local`/`free:synthetic`, or null (unpriced). */
  pk: string | null;
  /** The period's `from` (null = the first period). */
  pf: string | null;
  /** The context tier its calls fell in (`inputAbove`), or null. */
  tier: number | null;
  /** input, output, cacheRead, cacheWrite5m, cacheWrite1h */
  t: [number, number, number, number, number];
  n: number;
  /** First and last call time in the row. */
  a0: number;
  a1: number;
}

export interface OwnerInfo {
  parent: string | null;
  worker: string | null;
  /** The kind of its own (non-side) calls. */
  kind: "main" | "overseer" | "worker" | null;
  cwd: string | null;
  project: string | null;
  days: Set<string>;
}

interface FileState {
  /** Bytes of the plain `.jsonl` consumed (whole lines only). */
  off: number;
  /** Earlier bytes sealed into `<file>.gz` by a close. */
  gz: boolean;
}

interface DayState {
  name: string;
  files: Map<string, FileState>;
  rows: Map<string, Row>;
  /** Key hashes of an open day; null once closed. */
  keys: Set<number> | null;
  closed: boolean;
  /** Unterminated tails dropped at close. */
  torn: number;
  dirty: boolean;
  version: number;
}

export interface LedgerOptions {
  /** `<agent dir>/usage/v1`. */
  usageRoot: string;
  /** Where the snapshots live (`<state root>/usage-ledger`). */
  stateDir: string;
  prices: PriceBook;
  now?: () => number;
  log?: (line: string) => void;
}

/** cyrb53: a 53-bit string hash; at 50k keys a day a collision is about 1 in 10^7. */
export function hashKey(str: string): number {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

/** One copy of each dimension value (owners, models, directories repeat across thousands of rows). */
const interned = new Map<string, string>();
function intern(v: string | null): string | null {
  if (v === null) return null;
  const hit = interned.get(v);
  if (hit !== undefined) return hit;
  interned.set(v, v);
  return v;
}

const dayEnd = (day: string) => Date.parse(`${day}T00:00:00Z`) + DAY_MS;

/** The tiers of the period a row's band came from, for telling whether a price change moved a call to another band. */
function bandOf(table: PriceTable, pk: string | null, at: number): { pf: string | null; tiers: string } | null {
  if (!pk || pk.startsWith("free:")) return null;
  const m = table.models[pk];
  if (!m) return null;
  for (const p of m.periods) {
    const from = p.from === null ? -Infinity : Date.parse(p.from);
    const until = p.until === null ? Infinity : Date.parse(p.until);
    if (at >= from && at < until) return { pf: p.from, tiers: JSON.stringify(p.tiers ?? []) };
  }
  const first = m.periods[0];
  return first ? { pf: first.from, tiers: JSON.stringify(first.tiers ?? []) } : null;
}

export class Ledger {
  readonly usageRoot: string;
  readonly stateDir: string;
  private readonly prices: PriceBook;
  private readonly now: () => number;
  private readonly log: (line: string) => void;
  private readonly days = new Map<string, DayState>();
  /** Days known only by their snapshot (closed, not loaded). */
  private readonly onDisk = new Set<string>();
  /** Every owner seen, on any day: where its rows are and whose worker it is. */
  readonly owners = new Map<string, OwnerInfo>();
  /** parent sid -> the owners naming it as parent. */
  readonly children = new Map<string, Set<string>>();
  /** org project id -> the days with rows naming it. */
  readonly projects = new Map<string, Set<string>>();
  /** Counters for the benchmark and diagnostics. */
  readonly stats = { records: 0, duplicates: 0, skipped: 0, bytes: 0, rebuilds: 0, closes: 0 };

  constructor(opts: LedgerOptions) {
    this.usageRoot = opts.usageRoot;
    this.stateDir = opts.stateDir;
    this.prices = opts.prices;
    this.now = opts.now ?? Date.now;
    this.log = opts.log ?? ((l) => console.warn(`[usage-helper] ${l}`));
    fs.mkdirSync(path.join(this.stateDir, "days"), { recursive: true });
    for (const f of fs.readdirSync(path.join(this.stateDir, "days"))) {
      const m = /^(\d{4}-\d{2}-\d{2})\.snap$/.exec(f);
      if (m) this.onDisk.add(m[1]!);
    }
  }

  /** Every day with a snapshot or a directory, oldest first. */
  dayNames(): string[] {
    const names = new Set(this.onDisk);
    for (const d of this.days.keys()) names.add(d);
    return [...names].sort();
  }

  /** A day's rows (loaded from its snapshot when not in memory), and its version for caching. */
  rowsOf(day: string): { rows: Iterable<Row>; version: number } {
    const d = this.day(day, false);
    if (!d) return { rows: [], version: 0 };
    return { rows: d.rows.values(), version: d.version };
  }

  /** A day's version (changes whenever its rows do) without loading it. */
  versionOf(day: string): number {
    return this.days.get(day)?.version ?? this.gens.get(day) ?? 0;
  }

  /** Versions outlive a day's eviction, so a cache keyed by one never matches a later fold. */
  private readonly gens = new Map<string, number>();
  private clock = 0;
  private bump(day: DayState): void {
    day.version = ++this.clock;
    this.gens.set(day.name, day.version);
  }

  /** Forget a closed day's rows (the query layer keeps what it needs). */
  evict(day: string): void {
    const d = this.days.get(day);
    if (d && d.closed && !d.dirty) this.days.delete(day);
  }

  /** Build the owner index from every saved day (start-up; closed days are read and let go). */
  indexAll(): void {
    for (const name of this.dayNames()) {
      const kept = this.days.has(name);
      const d = this.day(name, false);
      if (!d) continue;
      for (const row of d.rows.values()) this.note(row, name);
      if (!kept) this.evict(name);
    }
  }

  private note(row: Row, day: string): void {
    const [owner, parent, worker, kind, , cwd, project] = row.d;
    if (project) {
      let days = this.projects.get(project);
      if (!days) this.projects.set(project, (days = new Set()));
      days.add(day);
    }
    if (!owner) return;
    let o = this.owners.get(owner);
    if (!o) {
      o = { parent: null, worker: null, kind: null, cwd: null, project: null, days: new Set() };
      this.owners.set(owner, o);
    }
    o.days.add(day);
    if (kind !== "oneshot") o.kind ??= kind as OwnerInfo["kind"];
    o.worker ??= worker ?? null;
    o.cwd ??= cwd ?? null;
    o.project ??= project ?? null;
    if (parent && !o.parent && parent !== owner) {
      o.parent = parent;
      let set = this.children.get(parent);
      if (!set) this.children.set(parent, (set = new Set()));
      set.add(owner);
    }
  }

  // ---- catch-up and follow ------------------------------------------------------------------

  /** Every day directory and every file past its saved offset: the start-up catch-up, and the slow safety sweep. */
  scanAll(): void {
    let dirs: string[] = [];
    try {
      dirs = fs.readdirSync(this.usageRoot).filter((d) => DAY_RE.test(d));
    } catch {
      return;
    }
    for (const name of dirs.sort()) {
      this.scanDay(name);
      // A catch-up over many days keeps one day in memory at a time: an ended day closes at once.
      const day = this.days.get(name);
      if (day && !day.closed && this.now() >= dayEnd(name) + CLOSE_GRACE_MS) {
        this.close(day);
        this.evict(name);
      }
    }
  }

  /** One day directory: new files, grown files. `only` limits it to the files an event named. */
  scanDay(name: string, only?: Iterable<string>): void {
    if (!DAY_RE.test(name)) return;
    const dir = path.join(this.usageRoot, name);
    let files: string[];
    try {
      files = only ? [...only] : fs.readdirSync(dir);
    } catch {
      return;
    }
    const plain = files.filter((f) => FILE_RE.test(f));
    if (plain.length === 0 && only) return;
    const day = this.day(name, true)!;
    // A sealed file the day's snapshot doesn't know (the snapshot lost, or removed so the day is
    // folded again from its records): fold the whole day, sealed records included, or they'd be lost.
    if (!only && files.some((f) => f.endsWith(".gz") && FILE_RE.test(f.slice(0, -3)) && !day.files.get(f.slice(0, -3))?.gz)) {
      this.rebuild(day);
      return;
    }
    // A closed day with anything new is folded again from all its records, then closes again.
    if (day.closed) {
      const grown = plain.some((f) => {
        const size = sizeOf(path.join(dir, f));
        return size > (day.files.get(f)?.off ?? 0);
      });
      if (grown) this.rebuild(day);
      return;
    }
    for (const f of plain) this.tail(day, f);
  }

  /** Read a file's new whole lines. */
  private tail(day: DayState, file: string): void {
    const full = path.join(this.usageRoot, day.name, file);
    const st = day.files.get(file) ?? { off: 0, gz: false };
    let fd: number;
    try {
      fd = fs.openSync(full, "r");
    } catch {
      return;
    }
    try {
      const size = fs.fstatSync(fd).size;
      if (size < st.off) {
        // Shrunk under us: never written that way; take the file as it is now.
        this.log(`${day.name}/${file} shrank (${st.off} -> ${size}); folding the day again`);
        fs.closeSync(fd);
        fd = -1;
        this.rebuild(day);
        return;
      }
      let off = st.off;
      let pos = off;
      let carry: Buffer | null = null;
      while (pos < size) {
        const want = Math.min(READ_CHUNK, size - pos);
        const buf = Buffer.allocUnsafe(want);
        const got = fs.readSync(fd, buf, 0, want, pos);
        if (got <= 0) break;
        pos += got;
        const chunk: Buffer = carry ? Buffer.concat([carry, buf.subarray(0, got)]) : buf.subarray(0, got);
        const last = chunk.lastIndexOf(10);
        if (last < 0) {
          carry = chunk;
          continue;
        }
        this.foldText(day, chunk.toString("utf8", 0, last + 1));
        off += last + 1;
        carry = last + 1 < chunk.length ? chunk.subarray(last + 1) : null;
      }
      if (off !== st.off || !day.files.has(file)) {
        this.stats.bytes += off - st.off;
        day.files.set(file, { off, gz: st.gz });
        day.dirty = true;
      }
    } finally {
      if (fd >= 0) fs.closeSync(fd);
    }
  }

  private foldText(day: DayState, text: string): void {
    let start = 0;
    for (;;) {
      const nl = text.indexOf("\n", start);
      if (nl < 0) break;
      const line = text.slice(start, nl);
      start = nl + 1;
      const rec = parseLine(line);
      if (!rec) {
        if (line) this.stats.skipped++;
        continue;
      }
      this.fold(day, rec);
    }
  }

  private fold(day: DayState, rec: UsageRec): void {
    const h = hashKey(rec.key);
    const keys = (day.keys ??= new Set());
    if (keys.has(h)) {
      this.stats.duplicates++;
      return;
    }
    keys.add(h);
    this.stats.records++;
    const r = rec.record;
    const priced = this.prices.priceUsage({ provider: r.provider, model: r.model, ...(r.responseModel ? { responseModel: r.responseModel } : {}) }, rec.usage, rec.ts);
    const pk = priced.status === "priced" ? priced.key : priced.status === "free" ? `free:${priced.why}` : null;
    const pf = priced.status === "priced" ? priced.period : null;
    const tier = priced.status === "priced" ? priced.tier : null;
    const b = rec.ts - (rec.ts % BUCKET_MS);
    const d = [r.owner, r.parent, r.worker ?? null, r.kind, r.purpose ?? null, r.cwd ?? null, r.project ?? null, r.src, r.provider, r.model, r.responseModel ?? null, r.starter ?? null].map(intern);
    const id = `${b}\u001f${d.join("\u001f")}\u001f${pk}\u001f${pf}\u001f${tier}`;
    let row = day.rows.get(id);
    if (!row) {
      row = { b, d, pk, pf, tier, t: [0, 0, 0, 0, 0], n: 0, a0: rec.ts, a1: rec.ts };
      day.rows.set(id, row);
      this.note(row, day.name);
    }
    const u = rec.usage;
    row.t[0] += u.input;
    row.t[1] += u.output;
    row.t[2] += u.cacheRead;
    row.t[3] += u.cacheWrite5m;
    row.t[4] += u.cacheWrite1h;
    row.n++;
    if (rec.ts < row.a0) row.a0 = rec.ts;
    if (rec.ts > row.a1) row.a1 = rec.ts;
    day.dirty = true;
    this.bump(day);
  }

  // ---- rebuild (price history changed, a closed day grew, a file shrank) -----------------------

  /** Fold a day again from every record it has (sealed `.gz` and plain files), from scratch. */
  rebuild(day: DayState): void {
    const dir = path.join(this.usageRoot, day.name);
    let names: string[] = [];
    try {
      names = fs.readdirSync(dir);
    } catch {
      this.log(`${day.name}: no records left to fold again; keeping its rows`);
      return;
    }
    // Every file the snapshot knows must still be there, or the fold would lose spend.
    for (const [f, st] of day.files) {
      const has = (st.gz && names.includes(`${f}.gz`)) || names.includes(f) || (!st.gz && st.off === 0);
      if (!has) {
        this.log(`${day.name}: ${f} is gone; keeping the day's rows as they are`);
        return;
      }
    }
    this.stats.rebuilds++;
    day.rows = new Map();
    day.keys = new Set();
    const files = new Map<string, FileState>();
    const producers = new Set(names.filter((n) => FILE_RE.test(n) || (n.endsWith(".gz") && FILE_RE.test(n.slice(0, -3)))).map((n) => n.replace(/\.gz$/, "")));
    for (const f of [...producers].sort()) {
      let gz = false;
      if (names.includes(`${f}.gz`)) {
        try {
          const text = zlib.gunzipSync(fs.readFileSync(path.join(dir, `${f}.gz`))).toString("utf8");
          this.foldText(day, text.endsWith("\n") ? text : text.slice(0, text.lastIndexOf("\n") + 1));
          gz = true;
        } catch (err) {
          this.log(`${day.name}/${f}.gz unreadable: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      files.set(f, { off: 0, gz });
      day.files = files;
      if (names.includes(f)) this.tail(day, f);
    }
    day.files = files;
    day.closed = false;
    day.dirty = true;
    this.bump(day);
  }

  /**
   * The price history changed (a download, a hand edit): every day with a row whose calls may no
   * longer sit in the key, period or tier band they were folded with is folded again. Rates alone
   * changing within a period needs nothing (pricing happens at read time).
   */
  repriced(prev: PriceTable, next: PriceTable): string[] {
    const changed: string[] = [];
    for (const name of this.dayNames()) {
      const day = this.day(name, false);
      if (!day) continue;
      if (this.stale(day, prev, next)) {
        this.rebuild(day);
        changed.push(name);
      } else if (day.closed) this.evict(name);
    }
    return changed;
  }

  private stale(day: DayState, prev: PriceTable, next: PriceTable): boolean {
    for (const row of day.rows.values()) {
      const ref = { provider: row.d[8]!, model: row.d[9]!, ...(row.d[10] ? { responseModel: row.d[10] } : {}) };
      const zero = { input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 };
      for (const at of [row.a0, row.a1]) {
        const p = this.prices.priceUsage(ref, zero, at);
        const pk = p.status === "priced" ? p.key : p.status === "free" ? `free:${p.why}` : null;
        if (pk !== row.pk) return true;
        const was = bandOf(prev, row.pk, at);
        const now = bandOf(next, row.pk, at);
        if ((now?.pf ?? null) !== row.pf) return true;
        if ((was?.tiers ?? "") !== (now?.tiers ?? "")) return true;
      }
    }
    return false;
  }

  // ---- close, compress ----------------------------------------------------------------------

  /** Close every open day that ended a grace period ago, whose files are all read to their end. */
  closeDays(): string[] {
    const closed: string[] = [];
    const now = this.now();
    for (const day of this.days.values()) {
      if (day.closed || now < dayEnd(day.name) + CLOSE_GRACE_MS) continue;
      this.close(day);
      closed.push(day.name);
    }
    return closed;
  }

  private close(day: DayState): void {
    const dir = path.join(this.usageRoot, day.name);
    for (const f of [...day.files.keys()]) this.tail(day, f);
    for (const [f, st] of day.files) {
      const plain = path.join(dir, f);
      if (!fs.existsSync(plain)) continue;
      // Sealed by rename first: an append racing the close lands in the sealed file (read in full
      // here) or starts a new file (which reopens the day), never in a file being deleted.
      const sealing = `${plain}.sealing`;
      fs.renameSync(plain, sealing);
      const buf = fs.readFileSync(sealing);
      const extra = buf.subarray(st.off);
      const last = extra.lastIndexOf(10);
      if (last >= 0) this.foldText(day, extra.subarray(0, last + 1).toString("utf8"));
      if (last + 1 < extra.length) day.torn++;
      const whole = buf.subarray(0, st.off + last + 1);
      const gzPath = `${plain}.gz`;
      const before = st.gz && fs.existsSync(gzPath) ? zlib.gunzipSync(fs.readFileSync(gzPath)) : Buffer.alloc(0);
      const tmp = `${gzPath}.tmp`;
      fs.writeFileSync(tmp, zlib.gzipSync(Buffer.concat([before, whole])));
      fs.renameSync(tmp, gzPath);
      fs.unlinkSync(sealing);
      day.files.set(f, { off: 0, gz: true });
    }
    day.closed = true;
    day.keys = null;
    day.dirty = true;
    this.bump(day);
    this.stats.closes++;
    this.save(day);
  }

  // ---- snapshots ----------------------------------------------------------------------------

  /** Save every changed day. */
  flush(): void {
    for (const day of this.days.values()) if (day.dirty) this.save(day);
  }

  private snapPath(name: string): string {
    return path.join(this.stateDir, "days", `${name}.snap`);
  }

  private save(day: DayState): void {
    const head = {
      v: 1,
      day: day.name,
      closed: day.closed,
      torn: day.torn,
      files: Object.fromEntries(day.files),
      rows: [...day.rows.values()].map((r) => [r.b, r.d, r.pk, r.pf, r.tier, r.t, r.n, r.a0, r.a1]),
    };
    const keys = day.keys ? Float64Array.from(day.keys) : new Float64Array(0);
    const text = Buffer.from(`${JSON.stringify(head)}\n`);
    // Keys start 8-byte aligned so they read back as one Float64Array.
    const pad = (8 - (text.length % 8)) % 8;
    const out = Buffer.concat([text, Buffer.alloc(pad, 32), Buffer.from(keys.buffer, keys.byteOffset, keys.byteLength)]);
    const file = this.snapPath(day.name);
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, out);
    fs.renameSync(tmp, file);
    day.dirty = false;
    this.onDisk.add(day.name);
  }

  private load(name: string): DayState | null {
    let buf: Buffer;
    try {
      buf = fs.readFileSync(this.snapPath(name));
    } catch {
      return null;
    }
    const nl = buf.indexOf(10);
    try {
      const head = JSON.parse(buf.subarray(0, nl).toString("utf8")) as {
        closed: boolean;
        torn?: number;
        files: Record<string, FileState>;
        rows: [number, (string | null)[], string | null, string | null, number | null, Row["t"], number, number, number][];
      };
      const rows = new Map<string, Row>();
      for (const [b, raw, pk, pf, tier, t, n, a0, a1] of head.rows) {
        const d = DIMS.map((_, i) => intern(raw[i] ?? null));
        rows.set(`${b}\u001f${d.join("\u001f")}\u001f${pk}\u001f${pf}\u001f${tier}`, { b, d, pk, pf, tier, t, n, a0, a1 });
      }
      let keys: Set<number> | null = null;
      if (!head.closed) {
        let start = nl + 1;
        start += (8 - (start % 8)) % 8;
        const bytes = buf.subarray(start);
        const copy = new Float64Array(bytes.length / 8);
        Buffer.from(copy.buffer).set(bytes);
        keys = new Set(copy);
      }
      return { name, files: new Map(Object.entries(head.files)), rows, keys, closed: head.closed, torn: head.torn ?? 0, dirty: false, version: this.gens.get(name) ?? 0 };
    } catch (err) {
      this.log(`${name}: snapshot unreadable (${err instanceof Error ? err.message : String(err)}); folding the day from its records`);
      return null;
    }
  }

  private day(name: string, create: true): DayState;
  private day(name: string, create: false): DayState | null;
  private day(name: string, create: boolean): DayState | null {
    let d = this.days.get(name);
    if (d) return d;
    d = this.onDisk.has(name) ? (this.load(name) ?? undefined) : undefined;
    if (!d && this.onDisk.has(name)) {
      // An unreadable snapshot: start the day over from its records.
      d = { name, files: new Map(), rows: new Map(), keys: new Set(), closed: false, torn: 0, dirty: true, version: 0 };
      this.days.set(name, d);
      this.rebuild(d);
      return d;
    }
    if (!d) {
      if (!create) return null;
      d = { name, files: new Map(), rows: new Map(), keys: new Set(), closed: false, torn: 0, dirty: true, version: 0 };
    }
    this.days.set(name, d);
    return d;
  }
}

function sizeOf(p: string): number {
  try {
    return fs.statSync(p).size;
  } catch {
    return 0;
  }
}
