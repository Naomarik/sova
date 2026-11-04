// Run: pnpm test -- scripts/mac-app-store.test.ts. The offline writer of the installed app's
// "hide title bar" setting (scripts/mac-app-store.ts, §app.installer/app-entry): LevelDB's formats
// as Chromium writes them, built here byte by byte (log framing across block edges, a MANIFEST,
// tables with plain and snappy blocks), and the WebAppProto field surgery. fs only.
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { scratchRoot } from "../server/test-scratch";
import {
  appIdOf,
  appRecord,
  crc32c,
  findAppId,
  manifestIdOf,
  frameLogRecord,
  loadStore,
  LOG_BLOCK,
  maskCrc,
  parseBatch,
  presetWco,
  protoFields,
  putBatch,
  putVarint,
  readLogRecords,
  recordKey,
  snappyDecompress,
  wcoOf,
  withWco,
  WCO_FIELD,
} from "./mac-app-store";

const root = scratchRoot("sova-mac-app-store-");
after(() => rmSync(root, { recursive: true, force: true }));
let n = 0;
const freshDir = () => {
  const d = join(root, `db${++n}`);
  mkdirSync(d, { recursive: true });
  return d;
};

const enc = (s: string) => new TextEncoder().encode(s);
const cat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((a, p) => a + p.length, 0));
  let o = 0;
  for (const p of parts) (out.set(p, o), (o += p.length));
  return out;
};
const le32 = (v: number) => Uint8Array.of(v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff);
const le64 = (v: bigint) => Uint8Array.from({ length: 8 }, (_, k) => Number((v >> BigInt(8 * k)) & 0xffn));
const lenPrefixed = (b: Uint8Array) => cat(putVarint(b.length), b);

/** A WebAppProto-shaped record: sync data naming the start URL and the relative manifest id, a
    few other fields, and maybe field 34. */
function appProto(manifestId: string, wco?: boolean): Uint8Array {
  const origin = new URL(manifestId).origin;
  const sync = cat(putVarint((1 << 3) | 2), lenPrefixed(enc(`${origin}/`)), putVarint((2 << 3) | 2), lenPrefixed(enc("sova")), putVarint((9 << 3) | 2), lenPrefixed(enc(manifestId.slice(origin.length + 1))));
  const parts = [
    cat(putVarint((1 << 3) | 2), lenPrefixed(sync)),
    cat(putVarint((2 << 3) | 2), lenPrefixed(enc(manifestId))),
    cat(putVarint((7 << 3) | 0), putVarint(300)),
    cat(putVarint((40 << 3) | 2), lenPrefixed(enc("sova"))),
  ];
  if (wco !== undefined) parts.push(cat(putVarint(WCO_FIELD << 3), putVarint(wco ? 1 : 0)));
  return cat(...parts);
}

/** A MANIFEST holding one version edit: comparator, log number, next file, last sequence, tables. */
function manifest(logNumber: number, lastSeq: number, tables: number[] = []): Uint8Array {
  const edit = [cat(putVarint(1), lenPrefixed(enc("leveldb.BytewiseComparator"))), cat(putVarint(2), putVarint(logNumber)), cat(putVarint(3), putVarint(logNumber + 1)), cat(putVarint(4), putVarint(lastSeq))];
  for (const t of tables) edit.push(cat(putVarint(7), putVarint(0), putVarint(t), putVarint(100), lenPrefixed(enc("a\0\0\0\0\0\0\0\0")), lenPrefixed(enc("z\0\0\0\0\0\0\0\0"))));
  return frameLogRecord(cat(...edit), 0);
}

/** A block with one restart per entry (shared = 0 throughout). */
function block(entries: Array<[Uint8Array, Uint8Array]>): Uint8Array {
  const body: Uint8Array[] = [];
  const restarts: number[] = [];
  let off = 0;
  for (const [k, v] of entries) {
    restarts.push(off);
    const e = cat(putVarint(0), putVarint(k.length), putVarint(v.length), k, v);
    body.push(e);
    off += e.length;
  }
  return cat(...body, ...restarts.map(le32), le32(restarts.length));
}

/** All-literal snappy: valid, and enough to drive the decompressor's path in a table. */
function snappyLiteral(raw: Uint8Array): Uint8Array {
  const out = [putVarint(raw.length)];
  for (let i = 0; i < raw.length; i += 60) {
    const chunk = raw.subarray(i, i + 60);
    out.push(Uint8Array.of((chunk.length - 1) << 2), chunk);
  }
  return cat(...out);
}

/** A table of internal keys (key + seq<<8|type), data block then index block, footer and magic. */
function table(ops: Array<{ key: string; seq: number; value: Uint8Array | null }>, snappy = false): Uint8Array {
  const ikey = (k: string, seq: number, put: boolean) => cat(enc(k), le64((BigInt(seq) << 8n) | (put ? 1n : 0n)));
  const data = block(ops.map((o) => [ikey(o.key, o.seq, o.value !== null), o.value ?? new Uint8Array(0)]));
  const stored = snappy ? snappyLiteral(data) : data;
  const dataBlock = cat(stored, Uint8Array.of(snappy ? 1 : 0), le32(0));
  const handle = cat(putVarint(0), putVarint(stored.length));
  const last = ops[ops.length - 1]!;
  const index = block([[ikey(last.key, last.seq, true), handle]]);
  const indexOff = dataBlock.length;
  const indexBlock = cat(index, Uint8Array.of(0), le32(0));
  const meta = block([]);
  const metaOff = indexOff + indexBlock.length;
  const metaBlock = cat(meta, Uint8Array.of(0), le32(0));
  const handles = cat(putVarint(metaOff), putVarint(meta.length), putVarint(indexOff), putVarint(index.length));
  const footer = cat(handles, new Uint8Array(40 - handles.length), le64(0xdb4775248b80fb57n));
  return cat(dataBlock, indexBlock, metaBlock, footer);
}

function writeStore(dir: string, opts: { logNumber?: number; lastSeq?: number; tables?: Record<number, Uint8Array>; log?: Uint8Array[] }) {
  const logNumber = opts.logNumber ?? 3;
  writeFileSync(join(dir, "CURRENT"), "MANIFEST-000001\n");
  writeFileSync(join(dir, "MANIFEST-000001"), manifest(logNumber, opts.lastSeq ?? 0, Object.keys(opts.tables ?? {}).map(Number)));
  for (const [num, bytes] of Object.entries(opts.tables ?? {})) writeFileSync(join(dir, `${String(num).padStart(6, "0")}.ldb`), bytes);
  let log = new Uint8Array(0);
  for (const batch of opts.log ?? []) log = cat(log, frameLogRecord(batch, log.length));
  writeFileSync(join(dir, `${String(logNumber).padStart(6, "0")}.log`), log);
}

const MID = "http://127.0.0.1:4800/";

test("crc32c and LevelDB's mask: the Castagnoli check value, and the mask's rotate-and-add", () => {
  assert.equal(crc32c(enc("123456789")), 0xe3069283);
  assert.equal(maskCrc(0), 0xa282ead8);
  const c = crc32c(enc("sova"));
  assert.equal(maskCrc(c), ((((c >>> 15) | (c << 17)) >>> 0) + 0xa282ead8) >>> 0);
});

test("snappy: literals, a 1-byte-offset copy overlapping its own output, and a 2-byte-offset copy", () => {
  // "abc", then copy-1 of 9 bytes at offset 3, then copy-2 of 4 bytes at offset 12.
  const src = Uint8Array.of(16, (3 - 1) << 2, 97, 98, 99, ((9 - 4) << 2) | 1, 3, ((4 - 1) << 2) | 2, 12, 0);
  assert.equal(new TextDecoder().decode(snappyDecompress(src)), "abcabcabcabcabca");
  assert.throws(() => snappyDecompress(Uint8Array.of(5, 0, 97)), /length mismatch/);
  assert.throws(() => snappyDecompress(Uint8Array.of(4, ((4 - 4) << 2) | 1, 1)), /out of range/);
});

test("the log framing: one record across block edges reads back whole, from any starting offset", () => {
  const payload = Uint8Array.from({ length: LOG_BLOCK * 2 + 123 }, (_, i) => i % 251);
  for (const start of [0, 10, LOG_BLOCK - 7, LOG_BLOCK - 6, LOG_BLOCK - 3]) {
    // A filler record that ends exactly at `start`, so the record under test begins there.
    const prefix = start ? frameLogRecord(new Uint8Array(start - 7).fill(7), 0) : new Uint8Array(0);
    assert.equal(prefix.length, start);
    const framed = frameLogRecord(payload, start);
    const { records, end } = readLogRecords(cat(prefix, framed));
    assert.equal(records.length, start ? 2 : 1, `start ${start}`);
    assert.deepEqual(records[records.length - 1], payload);
    assert.equal(end, start + framed.length);
  }
});

test("the log reader stops at a torn tail and keeps every whole record before it", () => {
  const a = frameLogRecord(enc("first"), 0);
  const b = frameLogRecord(enc("second"), a.length);
  const torn = cat(a, b.subarray(0, b.length - 2));
  const { records, end } = readLogRecords(torn);
  assert.deepEqual(records.map((r) => new TextDecoder().decode(r)), ["first"]);
  assert.equal(end, a.length);
  const flipped = cat(a, b);
  flipped[a.length + 9] = flipped[a.length + 9]! ^ 0xff;
  assert.equal(readLogRecords(flipped).records.length, 1);
});

test("a write batch round-trips its sequence, key and value", () => {
  const ops = parseBatch(putBatch(41, enc("k"), enc("v")));
  assert.deepEqual(ops, [{ seq: 41, key: enc("k"), value: enc("v") }]);
});

test("app ids: Chromium's hash of the manifest id, as 32 letters a..p, one per port", () => {
  // Ids Chrome itself gave preinstalled apps (read from a real profile's store): the derivation,
  // not just its shape.
  assert.equal(appIdOf("https://chat.google.com/"), "pommaclcbfghclhalboakcipcmmndhcj");
  assert.equal(appIdOf("https://www.youtube.com/?feature=ytca"), "agimnkijcaahngcdmfeangaknmldooml");
  const id = appIdOf(MID);
  assert.match(id, /^[a-p]{32}$/);
  assert.notEqual(appIdOf("http://127.0.0.1:4810/"), id);
  assert.equal(appIdOf(MID), id);
});

test("findAppId: the derived id's record, else the one record naming the manifest id, else none", () => {
  const dir = freshDir();
  writeStore(dir, { log: [putBatch(1, enc(recordKey(appIdOf(MID))), appProto(MID))] });
  assert.equal(findAppId(loadStore(dir), MID), appIdOf(MID));
  assert.equal(manifestIdOf(appProto(MID)), MID);
  const moved = freshDir();
  writeStore(moved, { log: [putBatch(1, enc(recordKey("abcdefghijklmnopabcdefghijklmnop")), appProto(MID)), putBatch(2, enc(recordKey(appIdOf("http://127.0.0.1:4810/"))), appProto("http://127.0.0.1:4810/"))] });
  assert.equal(findAppId(loadStore(moved), MID), "abcdefghijklmnopabcdefghijklmnop");
  const twice = freshDir();
  writeStore(twice, { log: [putBatch(1, enc(recordKey("abcdefghijklmnopabcdefghijklmnop")), appProto(MID)), putBatch(2, enc(recordKey("bbcdefghijklmnopabcdefghijklmnop")), appProto(MID))] });
  assert.equal(findAppId(loadStore(twice), MID), null);
  assert.equal(findAppId(loadStore(freshDirWithNothing()), MID), null);
});

function freshDirWithNothing(): string {
  const d = freshDir();
  writeStore(d, {});
  return d;
}

test("field surgery: sets field 34 once, drops any earlier copy, keeps every other field byte for byte", () => {
  const plain = appProto(MID);
  assert.equal(wcoOf(plain), undefined);
  const on = withWco(plain, true);
  assert.equal(wcoOf(on), true);
  assert.deepEqual(on.subarray(0, plain.length), plain);
  const off = withWco(appProto(MID, true), false);
  assert.equal(wcoOf(off), false);
  assert.equal(protoFields(off).filter((f) => f.num === WCO_FIELD).length, 1);
  assert.deepEqual(protoFields(off).filter((f) => f.num !== WCO_FIELD).map((f) => f.raw), protoFields(plain).map((f) => f.raw));
});

test("presetWco on a log-only store: appends one batch above the last sequence, reads back on, then changes nothing", () => {
  const dir = freshDir();
  const id = appIdOf(MID);
  const other = appIdOf("https://example.test/");
  writeStore(dir, { lastSeq: 5, log: [putBatch(6, enc(recordKey(id)), appProto(MID, false)), putBatch(7, enc(recordKey(other)), appProto("https://example.test/", false))] });
  const log = join(dir, "000003.log");
  const before = readFileSync(log);
  const r = presetWco(dir, id, true);
  assert.deepEqual(r, { ok: true, appId: id, before: false, wrote: true });
  const afterBytes = readFileSync(log);
  assert.deepEqual(afterBytes.subarray(0, before.length), before, "nothing before the append changed");
  const store = loadStore(dir);
  assert.equal(store.maxSeq, 8);
  assert.equal(wcoOf(appRecord(store, id)!), true);
  assert.equal(wcoOf(appRecord(store, other)!), false, "another app is untouched");
  const size = statSync(log).size;
  assert.deepEqual(presetWco(dir, id, true), { ok: true, appId: id, before: true, wrote: false });
  assert.equal(statSync(log).size, size, "a second run appends nothing");
});

test("presetWco finds the record in tables, plain or snappy, under a newer log entry, and a deletion hides it", () => {
  const id = appIdOf(MID);
  const key = recordKey(id);
  for (const snappy of [false, true]) {
    const dir = freshDir();
    writeStore(dir, {
      logNumber: 9,
      lastSeq: 20,
      tables: { 5: table([{ key, seq: 4, value: appProto(MID) }], snappy), 7: table([{ key: "z-other", seq: 12, value: enc("x") }], snappy) },
      log: [putBatch(21, enc("unrelated"), enc("y"))],
    });
    assert.equal(wcoOf(appRecord(loadStore(dir), id)!), undefined);
    const r = presetWco(dir, id, true);
    assert.equal(r.ok, true);
    assert.equal(wcoOf(appRecord(loadStore(dir), id)!), true, `snappy ${snappy}`);
    assert.equal(loadStore(dir).maxSeq, 22);
  }
  const gone = freshDir();
  writeStore(gone, { lastSeq: 2, tables: { 4: table([{ key, seq: 1, value: appProto(MID) }]) }, log: [cat(le64(2n), le32(1), Uint8Array.of(0), putVarint(key.length), enc(key))] });
  const r = presetWco(gone, id, true);
  assert.equal(r.ok, false);
});

test("presetWco refuses: no record for the app, and a log that ends in a torn record (left as it was)", () => {
  const id = appIdOf(MID);
  const none = freshDir();
  writeStore(none, { log: [putBatch(1, enc(recordKey(appIdOf("http://127.0.0.1:4810/"))), appProto("http://127.0.0.1:4810/"))] });
  const r = presetWco(none, id, true);
  assert.equal(r.ok, false);
  assert.match((r as { reason: string }).reason, /no record/);

  const torn = freshDir();
  writeStore(torn, { log: [putBatch(1, enc(recordKey(id)), appProto(MID, false))] });
  const log = join(torn, "000003.log");
  const whole = readFileSync(log);
  const extra = frameLogRecord(putBatch(2, enc("x"), enc("y")), whole.length);
  writeFileSync(log, cat(whole, extra.subarray(0, extra.length - 3)));
  const sizeBefore = statSync(log).size;
  const t = presetWco(torn, id, true);
  assert.equal(t.ok, false);
  assert.match((t as { reason: string }).reason, /torn/);
  assert.equal(statSync(log).size, sizeBefore);
});
