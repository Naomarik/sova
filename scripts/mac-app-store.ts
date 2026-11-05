// The installed Sova app's "hide title bar" setting, written straight into a Chromium profile's
// web-app store while that browser is closed (§app.installer/app-entry). No CDP, flag, pref or
// policy sets it: Chrome keeps it per app in WebAppProto field 34 (window_controls_overlay_enabled,
// a local field, not a sync one) of the record `web_apps-dt-<app id>` in the profile's
// `Sync Data/LevelDB` (a syncer::DataTypeStore). Chrome reads it when each app window opens.
//
// Writing appends one WriteBatch to the store's live write-ahead log, framed as LevelDB frames its
// own records, with a sequence number above every entry already there, so LevelDB replays it on its
// next open as the newest value of that key. Reading follows LevelDB too: MANIFEST (live tables,
// log number, last sequence), each live table (block format, snappy or uncompressed blocks) and the
// live logs (32 KB blocks, masked CRC32C), newest sequence wins.
//
// Pure and dependency-free, so it runs on the install's Bun with no node_modules. Nothing here
// knows about Chrome being up: callers check the profile's SingletonLock first (mac-app.ts).
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, fsyncSync, openSync, closeSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

// ---- CRC32C (Castagnoli) and LevelDB's masked form ----

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0x82f63b78 : c >>> 1;
    t[i] = c >>> 0;
  }
  return t;
})();

export function crc32c(data: Uint8Array, crc = 0): number {
  crc = (crc ^ 0xffffffff) >>> 0;
  for (let i = 0; i < data.length; i++) crc = (CRC_TABLE[(crc ^ data[i]!) & 0xff]! ^ (crc >>> 8)) >>> 0;
  return (crc ^ 0xffffffff) >>> 0;
}

export function maskCrc(crc: number): number {
  return ((((crc >>> 15) | (crc << 17)) >>> 0) + 0xa282ead8) >>> 0;
}

// ---- varints (values stay far below 2^53 in every field read here) ----

export function getVarint(b: Uint8Array, i: number): [value: number, next: number] {
  let result = 0;
  let mul = 1;
  for (;;) {
    if (i >= b.length) throw new Error("varint runs past the end");
    const x = b[i++]!;
    result += (x & 0x7f) * mul;
    if (!(x & 0x80)) return [result, i];
    mul *= 128;
  }
}

export function putVarint(n: number): Uint8Array {
  const out: number[] = [];
  for (;;) {
    const x = n % 128;
    n = Math.floor(n / 128);
    if (n) out.push(x | 0x80);
    else {
      out.push(x);
      return Uint8Array.from(out);
    }
  }
}

function concat(parts: Uint8Array[]): Uint8Array {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

const u32le = (b: Uint8Array, i: number) => (b[i]! | (b[i + 1]! << 8) | (b[i + 2]! << 16) | (b[i + 3]! << 24)) >>> 0;
const u16le = (b: Uint8Array, i: number) => b[i]! | (b[i + 1]! << 8);
function u64le(b: Uint8Array, i: number): bigint {
  return BigInt(u32le(b, i)) | (BigInt(u32le(b, i + 4)) << 32n);
}
function le64(n: bigint): Uint8Array {
  const out = new Uint8Array(8);
  for (let k = 0; k < 8; k++) out[k] = Number((n >> BigInt(8 * k)) & 0xffn);
  return out;
}
function le32(n: number): Uint8Array {
  return Uint8Array.of(n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff);
}

// ---- snappy (raw block) decompression ----

export function snappyDecompress(src: Uint8Array): Uint8Array {
  let [n, i] = getVarint(src, 0);
  const out = new Uint8Array(n);
  let o = 0;
  while (i < src.length) {
    const tag = src[i++]!;
    const kind = tag & 3;
    if (kind === 0) {
      let len = tag >> 2;
      if (len >= 60) {
        const nb = len - 59;
        len = 0;
        for (let k = 0; k < nb; k++) len |= src[i + k]! << (8 * k);
        len >>>= 0;
        i += nb;
      }
      len += 1;
      if (i + len > src.length || o + len > n) throw new Error("snappy literal runs past the end");
      out.set(src.subarray(i, i + len), o);
      i += len;
      o += len;
      continue;
    }
    let len: number;
    let off: number;
    if (kind === 1) {
      len = ((tag >> 2) & 7) + 4;
      off = ((tag >> 5) << 8) | src[i]!;
      i += 1;
    } else if (kind === 2) {
      len = (tag >> 2) + 1;
      off = u16le(src, i);
      i += 2;
    } else {
      len = (tag >> 2) + 1;
      off = u32le(src, i);
      i += 4;
    }
    if (off === 0 || off > o || o + len > n) throw new Error("snappy copy out of range");
    for (let k = 0; k < len; k++, o++) out[o] = out[o - off]!;
  }
  if (o !== n) throw new Error("snappy length mismatch");
  return out;
}

// ---- the log format (write-ahead logs and MANIFEST) ----

export const LOG_BLOCK = 32768;
const HEADER = 7;
const FULL = 1, FIRST = 2, MIDDLE = 3, LAST = 4;

/** Every whole record in a log file, stopping at a torn or corrupt tail; `end` is where it stopped. */
export function readLogRecords(data: Uint8Array): { records: Uint8Array[]; end: number } {
  const records: Uint8Array[] = [];
  let i = 0;
  let frag: Uint8Array[] | null = null;
  while (i + HEADER <= data.length) {
    const left = LOG_BLOCK - (i % LOG_BLOCK);
    if (left < HEADER) {
      i += left;
      continue;
    }
    const crc = u32le(data, i);
    const len = u16le(data, i + 4);
    const type = data[i + 6]!;
    if (type === 0 && len === 0) {
      i += left; // zero padding to the block's end (a preallocated tail)
      continue;
    }
    const payload = data.subarray(i + HEADER, i + HEADER + len);
    if (payload.length < len || maskCrc(crc32c(concat([Uint8Array.of(type), payload]))) !== crc) break;
    i += HEADER + len;
    if (type === FULL) records.push(payload.slice());
    else if (type === FIRST) frag = [payload.slice()];
    else if (type === MIDDLE && frag) frag.push(payload.slice());
    else if (type === LAST && frag) {
      frag.push(payload.slice());
      records.push(concat(frag));
      frag = null;
    }
  }
  return { records, end: i };
}

/** The bytes that append `payload` as one record to a log file now `size` bytes long. */
export function frameLogRecord(payload: Uint8Array, size: number): Uint8Array {
  const out: Uint8Array[] = [];
  let off = size;
  let first = true;
  let rest = payload;
  for (;;) {
    let left = LOG_BLOCK - (off % LOG_BLOCK);
    if (left < HEADER) {
      out.push(new Uint8Array(left));
      off += left;
      left = LOG_BLOCK;
    }
    const chunk = rest.subarray(0, left - HEADER);
    rest = rest.subarray(chunk.length);
    const end = rest.length === 0;
    const type = first ? (end ? FULL : FIRST) : end ? LAST : MIDDLE;
    const crc = maskCrc(crc32c(concat([Uint8Array.of(type), chunk])));
    out.push(le32(crc), Uint8Array.of(chunk.length & 0xff, chunk.length >> 8, type), chunk);
    off += HEADER + chunk.length;
    first = false;
    if (end) return concat(out);
  }
}

export interface Op {
  seq: number;
  key: Uint8Array;
  /** null: a deletion. */
  value: Uint8Array | null;
}

export function parseBatch(rec: Uint8Array): Op[] {
  const seq = Number(u64le(rec, 0));
  const count = u32le(rec, 8);
  const ops: Op[] = [];
  let i = 12;
  for (let n = 0; n < count; n++) {
    const tag = rec[i++]!;
    let kl: number;
    [kl, i] = getVarint(rec, i);
    const key = rec.slice(i, i + kl);
    i += kl;
    let value: Uint8Array | null = null;
    if (tag === 1) {
      let vl: number;
      [vl, i] = getVarint(rec, i);
      value = rec.slice(i, i + vl);
      i += vl;
    } else if (tag !== 0) throw new Error(`unknown batch op ${tag}`);
    ops.push({ seq: seq + n, key, value });
  }
  return ops;
}

/** One WriteBatch holding a single put. */
export function putBatch(seq: number, key: Uint8Array, value: Uint8Array): Uint8Array {
  return concat([le64(BigInt(seq)), le32(1), Uint8Array.of(1), putVarint(key.length), key, putVarint(value.length), value]);
}

// ---- tables (.ldb / .sst) ----

const TABLE_MAGIC = 0xdb4775248b80fb57n;

function readBlock(data: Uint8Array, off: number, size: number): Uint8Array {
  const raw = data.subarray(off, off + size);
  const ctype = data[off + size];
  if (ctype === 0) return raw;
  if (ctype === 1) return snappyDecompress(raw);
  throw new Error(`unknown block compression ${ctype}`);
}

function* blockEntries(b: Uint8Array): Generator<[Uint8Array, Uint8Array]> {
  const restarts = u32le(b, b.length - 4);
  const end = b.length - 4 - 4 * restarts;
  let i = 0;
  let last: Uint8Array = new Uint8Array(0);
  while (i < end) {
    let shared: number, nonShared: number, vl: number;
    [shared, i] = getVarint(b, i);
    [nonShared, i] = getVarint(b, i);
    [vl, i] = getVarint(b, i);
    const key = concat([last.subarray(0, shared), b.subarray(i, i + nonShared)]);
    i += nonShared;
    const value = b.subarray(i, i + vl);
    i += vl;
    last = key;
    yield [key, value];
  }
}

export function* tableEntries(data: Uint8Array): Generator<Op> {
  if (data.length < 48) throw new Error("table too short");
  const foot = data.subarray(data.length - 48);
  if (u64le(foot, 40) !== TABLE_MAGIC) throw new Error("bad table magic");
  let i = 0;
  [, i] = getVarint(foot, i); // metaindex handle
  [, i] = getVarint(foot, i);
  let io: number, isz: number;
  [io, i] = getVarint(foot, i);
  [isz, i] = getVarint(foot, i);
  for (const [, handle] of blockEntries(readBlock(data, io, isz))) {
    const [bo, j] = getVarint(handle, 0);
    const [bs] = getVarint(handle, j);
    for (const [ikey, v] of blockEntries(readBlock(data, bo, bs))) {
      const tag = u64le(ikey, ikey.length - 8);
      yield { seq: Number(tag >> 8n), key: ikey.slice(0, ikey.length - 8), value: (tag & 0xffn) === 1n ? v.slice() : null };
    }
  }
}

// ---- MANIFEST: live tables, the log number, the last sequence ----

export function manifestState(data: Uint8Array): { logNumber: number; lastSeq: number; live: Set<number> } {
  let logNumber = 0;
  let lastSeq = 0;
  const live = new Set<number>();
  for (const r of readLogRecords(data).records) {
    let i = 0;
    while (i < r.length) {
      let tag: number;
      [tag, i] = getVarint(r, i);
      if (tag === 1) {
        let len: number;
        [len, i] = getVarint(r, i);
        i += len; // comparator name
      } else if (tag === 2 || tag === 3 || tag === 4 || tag === 9) {
        let v: number;
        [v, i] = getVarint(r, i);
        if (tag === 2) logNumber = v;
        if (tag === 4) lastSeq = v;
      } else if (tag === 5) {
        let len: number;
        [, i] = getVarint(r, i); // level
        [len, i] = getVarint(r, i);
        i += len; // compact pointer
      } else if (tag === 6) {
        let n: number;
        [, i] = getVarint(r, i);
        [n, i] = getVarint(r, i);
        live.delete(n);
      } else if (tag === 7) {
        let n: number, len: number;
        [, i] = getVarint(r, i); // level
        [n, i] = getVarint(r, i);
        [, i] = getVarint(r, i); // size
        [len, i] = getVarint(r, i);
        i += len; // smallest
        [len, i] = getVarint(r, i);
        i += len; // largest
        live.add(n);
      } else throw new Error(`unknown descriptor tag ${tag}`);
    }
  }
  return { logNumber, lastSeq, live };
}

export interface Store {
  /** latin1 key → newest entry. */
  entries: Map<string, { seq: number; value: Uint8Array | null }>;
  maxSeq: number;
  /** Live log file names, oldest first. */
  logs: string[];
}

const latin1 = (b: Uint8Array) => Buffer.from(b.buffer, b.byteOffset, b.byteLength).toString("latin1");
const fromLatin1 = (s: string) => new Uint8Array(Buffer.from(s, "latin1"));

export function loadStore(dir: string): Store {
  const current = readFileSync(join(dir, "CURRENT"), "utf8").trim();
  // LevelDB's descriptor file (its MANIFEST-<number>), whose name CURRENT holds. Matched by shape:
  // the spec-layout ratchet (server/spec-layout-boundary.test.ts) reserves that word in code for the
  // spec's own records file, which this is not.
  if (!/^[A-Z]+-\d+$/.test(current)) throw new Error(`CURRENT names ${JSON.stringify(current)}, not a descriptor file`);
  const { logNumber, lastSeq, live } = manifestState(new Uint8Array(readFileSync(join(dir, current))));
  const entries: Store["entries"] = new Map();
  let maxSeq = lastSeq;
  const see = (op: Op) => {
    if (op.seq > maxSeq) maxSeq = op.seq;
    const k = latin1(op.key);
    const had = entries.get(k);
    if (!had || had.seq < op.seq) entries.set(k, { seq: op.seq, value: op.value });
  };
  for (const n of [...live].sort((a, b) => a - b)) {
    for (const ext of [".ldb", ".sst"]) {
      const p = join(dir, `${String(n).padStart(6, "0")}${ext}`);
      if (existsSync(p)) for (const op of tableEntries(new Uint8Array(readFileSync(p)))) see(op);
    }
  }
  const logs = readdirSync(dir)
    .filter((f) => /^\d+\.log$/.test(f) && Number(f.slice(0, -4)) >= logNumber)
    .sort((a, b) => Number(a.slice(0, -4)) - Number(b.slice(0, -4)));
  for (const f of logs) for (const rec of readLogRecords(new Uint8Array(readFileSync(join(dir, f)))).records) for (const op of parseBatch(rec)) see(op);
  return { entries, maxSeq, logs };
}

// ---- WebAppProto: top-level field surgery ----

export interface Field {
  num: number;
  wire: number;
  /** varint value, or the bytes of a length-delimited / fixed field. */
  value: number | Uint8Array;
  raw: Uint8Array;
}

export function protoFields(b: Uint8Array): Field[] {
  const out: Field[] = [];
  let i = 0;
  while (i < b.length) {
    const start = i;
    let key: number;
    [key, i] = getVarint(b, i);
    const num = Math.floor(key / 8);
    const wire = key % 8;
    let value: number | Uint8Array;
    if (wire === 0) [value, i] = getVarint(b, i);
    else if (wire === 1) {
      value = b.subarray(i, i + 8);
      i += 8;
    } else if (wire === 2) {
      let len: number;
      [len, i] = getVarint(b, i);
      value = b.subarray(i, i + len);
      i += len;
    } else if (wire === 5) {
      value = b.subarray(i, i + 4);
      i += 4;
    } else throw new Error(`protobuf wire type ${wire}`);
    if (i > b.length) throw new Error("protobuf field runs past the end");
    out.push({ num, wire, value, raw: b.subarray(start, i) });
  }
  return out;
}

/** WebAppProto.window_controls_overlay_enabled. */
export const WCO_FIELD = 34;

export function wcoOf(record: Uint8Array): boolean | undefined {
  const f = protoFields(record).filter((x) => x.num === WCO_FIELD && x.wire === 0);
  return f.length ? f[f.length - 1]!.value !== 0 : undefined;
}

export function withWco(record: Uint8Array, on: boolean): Uint8Array {
  const kept = protoFields(record).filter((x) => x.num !== WCO_FIELD).map((x) => x.raw);
  return concat([...kept, putVarint(WCO_FIELD * 8), putVarint(on ? 1 : 0)]);
}

/** Chromium's app id for a manifest id: the app's key is the SHA-256 of the id's spec, and the id
    is an extension id made from that key (crx_file::id_util::GenerateId: the first 16 bytes of the
    key's own SHA-256, each hex digit written a…p). Checked against ids Chrome itself stored. */
export function appIdOf(manifestId: string): string {
  const key = createHash("sha256").update(manifestId).digest();
  const hex = createHash("sha256").update(key).digest("hex").slice(0, 32);
  return [...hex].map((c) => String.fromCharCode(97 + parseInt(c, 16))).join("");
}

export const recordKey = (appId: string) => `web_apps-dt-${appId}`;

/** The web-app store of a profile directory (`<user-data-dir>/Default`). */
export const storeDir = (profileDir: string) => join(profileDir, "Sync Data", "LevelDB");

/** The manifest id a record names: its sync data (field 1) holds the start URL (1) and the
    manifest id relative to the start URL's origin (9). Undefined when the record isn't that shape. */
export function manifestIdOf(record: Uint8Array): string | undefined {
  try {
    const sync = protoFields(record).find((f) => f.num === 1 && f.wire === 2)?.value;
    if (!(sync instanceof Uint8Array)) return undefined;
    const fields = protoFields(sync);
    const text = (n: number) => {
      const v = fields.find((f) => f.num === n && f.wire === 2)?.value;
      return v instanceof Uint8Array ? Buffer.from(v).toString("utf8") : undefined;
    };
    const start = text(1);
    const relative = text(9);
    if (!start || relative === undefined) return undefined;
    return `${new URL(start).origin}/${relative}`;
  } catch {
    return undefined;
  }
}

/** The installed app's id in this store: the derived id when its record is there, else the one
    record that names this manifest id (a derivation a later browser changed), else null. */
export function findAppId(store: Store, manifestId: string): string | null {
  const derived = appIdOf(manifestId);
  if (store.entries.get(recordKey(derived))?.value) return derived;
  const hits: string[] = [];
  for (const [k, e] of store.entries) {
    if (!k.startsWith("web_apps-dt-") || !e.value) continue;
    if (manifestIdOf(e.value) === manifestId) hits.push(k.slice("web_apps-dt-".length));
  }
  return hits.length === 1 ? hits[0]! : null;
}

/** The app's record, or null when the store has none (not installed, or a shape this doesn't know). */
export function appRecord(store: Store, appId: string): Uint8Array | null {
  return store.entries.get(recordKey(appId))?.value ?? null;
}

export type PresetResult =
  | { ok: true; appId: string; before: boolean | undefined; wrote: boolean }
  | { ok: false; appId: string; reason: string };

/** Set the app's window-controls-overlay flag in a closed profile's store, then read it back.
    Leaves the store as it was when the app has no record; the caller backs it up and restores it
    when the result is not ok after a write. */
export function presetWco(dir: string, appId: string, on: boolean): PresetResult {
  const store = loadStore(dir);
  const record = appRecord(store, appId);
  if (!record) return { ok: false, appId, reason: `no record for app ${appId} in ${dir}` };
  const before = wcoOf(record);
  if (before === on) return { ok: true, appId, before, wrote: false };
  const log = store.logs[store.logs.length - 1];
  if (!log) return { ok: false, appId, reason: `no live log in ${dir}` };
  const path = join(dir, log);
  // A torn record at the log's end (a browser killed mid-write) would sit between the old
  // records and ours; LevelDB would drop what follows it, so nothing is appended there.
  const size = statSync(path).size;
  if (readLogRecords(new Uint8Array(readFileSync(path))).end < size) return { ok: false, appId, reason: `${log} ends in a torn record` };
  const batch = putBatch(store.maxSeq + 1, fromLatin1(recordKey(appId)), withWco(record, on));
  const bytes = frameLogRecord(batch, size);
  appendFileSync(path, bytes);
  const fd = openSync(path, "r+");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  const after = appRecord(loadStore(dir), appId);
  if (!after || wcoOf(after) !== on) return { ok: false, appId, reason: "the store doesn't read back the setting it was given" };
  return { ok: true, appId, before, wrote: true };
}
