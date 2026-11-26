/**
 * The homes' change log and index (§app.chat-homes/change-log): what lets a reader of many homes learn which ones
 * changed without looking at every one of them.
 *
 * The log is numbered segment files in the homes root, `.changes.<n>.log`, each line one change: `{"h": home id,
 * "d": what changed, "g": the writer's own sequence number, "p": its pid}`. Every writer appends with O_APPEND, one
 * `write` of one line, so two writers never cut into each other's lines; a file is never rewritten or truncated. When a
 * segment reaches its size the next writer starts the next number. A reader keeps a cursor, `{seg, off}`, and reads
 * from it: complete lines only (a torn last line waits for its end).
 *
 * The log is a hint, never the truth: a change that came without its line (a home copied in by hand, a write by a
 * program that doesn't know the log) is seen by the backstop sweep every reader keeps (SWEEP_MS), late, never lost. A
 * reader whose cursor's segment was removed (CompactGraceMs) is told it has a gap and sweeps at once.
 *
 * The index, `.index.json`, is one file written whole (tmp + rename) by the server: each home's conversation file
 * names with the stamp of its `sessions/` folder they were listed at, and the cursor it covers. A missing, torn or
 * unknown index is no error: its reader lists every home once and writes a new one.
 *
 * Both files belong to this device: they never travel with a chat (a Transport packs one home's folder, never the
 * root's own files) and a move of the homes folder leaves them behind (isDeviceLocalHomesFile); a homes root without
 * them is rebuilt by one walk. Nothing here knows how the root is found: every call names it.
 */
import { closeSync, existsSync, fstatSync, openSync, readFileSync, readSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import { join } from "node:path";

/** A segment's name: `.changes.<n>.log`, n from 1. */
export const LOG_RE = /^\.changes\.(\d+)\.log$/;
export const INDEX_NAME = ".index.json";
export const INDEX_VERSION = 1;

/** A top-level name of the homes root that belongs to this device alone: never copied, carried or moved. */
export const isDeviceLocalHomesFile = (name: string): boolean => LOG_RE.test(name) || name === INDEX_NAME || name.startsWith(`${INDEX_NAME}.`);

/** What a line says changed: one of a home's records docs, its cards, offers, helpers or conversations, or the home
    itself (`home`: made or arrived; `gone`: deleted or compressed). */
export type ChangeDoc = "home" | "gone" | "meta" | "seen" | "signals" | "offers" | "cards" | "workers" | "sessions";
const DOCS = new Set<string>(["home", "gone", "meta", "seen", "signals", "offers", "cards", "workers", "sessions"]);

export interface ChangeLine {
  h: string;
  d: ChangeDoc;
  g: number;
  p: number;
}

export interface Cursor {
  seg: number;
  off: number;
}

/** A segment's size at which writers start the next one, and how long a segment the index has passed stays before the
    compactor removes it (a reader in another process that is behind gets this long before it must sweep instead). */
const limits = { segmentBytes: 1 << 20, graceMs: 10 * 60_000 };
const segmentBytes = (): number => limits.segmentBytes;
const compactGraceMs = (): number => limits.graceMs;
/** Tests: small segments and no grace, so rolls and removals happen within a test. */
export function setChangeLogLimitsForTest(o: Partial<typeof limits>): void {
  Object.assign(limits, o);
}

export const segmentFile = (root: string, n: number): string => join(root, `.changes.${n}.log`);

/** I/O this module did (the bench and tests count it). */
export const changeIo = { appends: 0, polls: 0, reads: 0, indexWrites: 0, indexReads: 0 };

/** Every segment number in the root, ascending. */
export function segments(root: string): number[] {
  let names: string[];
  try {
    names = readdirSync(root);
  } catch {
    return [];
  }
  const out: number[] = [];
  for (const n of names) {
    const m = LOG_RE.exec(n);
    if (m) out.push(Number(m[1]));
  }
  return out.sort((a, b) => a - b);
}

/** Per root: the segment this process writes to now (found once, then followed). */
const writers = new Map<string, number>();
let seq = 0;

/**
 * Append one change. Never makes the homes root (a root that isn't there has nothing to tell of) and never throws: a
 * line that can't be written is a change the sweep finds.
 */
export function appendChange(root: string, h: string, d: ChangeDoc): void {
  if (!existsSync(root)) return;
  const line = `${JSON.stringify({ h, d, g: ++seq, p: process.pid })}\n`;
  try {
    let n = writers.get(root) ?? (segments(root).at(-1) || 1);
    // The segment it wrote to last was removed meanwhile (the compactor, after others rolled on): never made again,
    // where readers already past it would never read the line; the newest one is where the line goes.
    if (writers.has(root) && !existsSync(segmentFile(root, n))) n = segments(root).at(-1) || n;
    for (let tries = 0; tries < 8; tries++) {
      // Another writer started a newer segment: write there, so readers that moved on see this line.
      while (existsSync(segmentFile(root, n + 1))) n++;
      const fd = openSync(segmentFile(root, n), "a", 0o600);
      let wrote = false;
      try {
        if (fstatSync(fd).size >= segmentBytes()) n++;
        else {
          writeSync(fd, line);
          wrote = true;
        }
      } finally {
        closeSync(fd);
      }
      writers.set(root, n);
      // A compactor that removed the segment between the open and the write: the line went nowhere, so again.
      if (wrote && existsSync(segmentFile(root, n))) {
        changeIo.appends++;
        return;
      }
    }
  } catch (err) {
    console.warn(`[chat-homes] change log append failed in ${root}:`, err instanceof Error ? err.message : String(err));
  }
}

/** The end of the log now: where a reader that has just read everything starts. */
export function logEnd(root: string): Cursor {
  const n = segments(root).at(-1);
  if (n === undefined) return { seg: 1, off: 0 };
  try {
    return { seg: n, off: statSync(segmentFile(root, n)).size };
  } catch {
    return { seg: n, off: 0 };
  }
}

function parse(text: string, out: ChangeLine[]): void {
  for (const raw of text.split("\n")) {
    if (!raw) continue;
    try {
      const v = JSON.parse(raw) as Partial<ChangeLine>;
      if (typeof v.h === "string" && typeof v.d === "string" && DOCS.has(v.d) && typeof v.g === "number" && typeof v.p === "number") out.push(v as ChangeLine);
    } catch {
      // not a line of ours: skipped
    }
  }
}

/** Read `file` from `off` to its last complete line. Returns the new offset, or null when the file is missing. */
function readFrom(file: string, off: number, out: ChangeLine[]): number | null {
  let fd: number;
  try {
    fd = openSync(file, "r");
  } catch {
    return null;
  }
  try {
    const size = fstatSync(fd).size;
    if (size <= off) return size < off ? 0 : off; // shorter than the cursor: not the file it read (made again)
    const buf = Buffer.alloc(size - off);
    let got = 0;
    while (got < buf.length) {
      const n = readSync(fd, buf, got, buf.length - got, off + got);
      if (n <= 0) break;
      got += n;
    }
    changeIo.reads++;
    const end = buf.subarray(0, got).lastIndexOf(0x0a);
    if (end < 0) return off;
    parse(buf.subarray(0, end + 1).toString("utf8"), out);
    return off + end + 1;
  } finally {
    closeSync(fd);
  }
}

/** How often a reader whose segment isn't there (none written yet) lists the root for a newer one. */
const LIST_MS = 5000;

/**
 * One reader's place in the log. `read` returns the lines since its cursor, and `gap` when lines may have gone by
 * unread (its segment was removed before it got to the end): the caller sweeps.
 */
export class ChangeTail {
  cursor: Cursor;
  /** The segment it left last, and how far it had read it: a writer that hadn't seen the newer one yet may still add a
      line there. */
  private prev: Cursor | null = null;
  /** When its missing segment last made it list the root. */
  private listedAt = 0;
  constructor(
    readonly root: string,
    from: Cursor = logEnd(root),
  ) {
    this.cursor = isCursor(from) ? { ...from } : logEnd(root);
  }

  /** Read again from `from` (an earlier cursor). */
  rewind(from: Cursor): void {
    this.cursor = { ...from };
    this.prev = null;
  }

  read(): { lines: ChangeLine[]; gap: boolean } {
    changeIo.polls++;
    const lines: ChangeLine[] = [];
    let gap = false;
    if (this.prev) {
      const off = readFrom(segmentFile(this.root, this.prev.seg), this.prev.off, lines);
      if (off === null) this.prev = null;
      else this.prev.off = off;
    }
    for (;;) {
      const off = readFrom(segmentFile(this.root, this.cursor.seg), this.cursor.off, lines);
      const nextThere = existsSync(segmentFile(this.root, this.cursor.seg + 1));
      if (off === null) {
        // Its segment is gone, or not written yet: the next one there is the common case, a look at the whole root
        // (every home's name) only now and then.
        if (!nextThere) {
          const now = Date.now();
          if (now - this.listedAt < LIST_MS) break;
          this.listedAt = now;
        }
        // Before any segment was written that is no gap; after, lines it never read may be.
        const all = segments(this.root);
        const newer = all.find((n) => n > this.cursor.seg);
        if (newer === undefined) break;
        if (this.cursor.off > 0 || newer > this.cursor.seg + 1 || all.some((n) => n < this.cursor.seg)) gap = true;
        this.prev = null;
        this.cursor = { seg: newer, off: 0 };
        continue;
      }
      this.cursor.off = off;
      if (!nextThere) break;
      this.prev = { ...this.cursor };
      this.cursor = { seg: this.cursor.seg + 1, off: 0 };
    }
    return { lines, gap };
  }
}

// ---- this process's one reader ---------------------------------------------------------------------

/** What a reader of the homes does with the lines (each must be quick and never throw); `gap`: sweep now. */
export type ChangeListener = (root: string, lines: readonly ChangeLine[], gap: boolean) => void;
const listeners = new Set<ChangeListener>();
const tails = new Map<string, ChangeTail>();

/** A cursor as it may be written: a whole segment number from 1 and a whole offset from 0. */
export const isCursor = (c: unknown): c is Cursor => {
  const v = c as Partial<Cursor> | null;
  return !!v && Number.isInteger(v.seg) && v.seg! >= 1 && Number.isInteger(v.off) && v.off! >= 0;
};

/** Hear every line this process reads from now on (any root). Returns the stop. */
export function onChanges(fn: ChangeListener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/**
 * Start this process's reader of `root` at `from` (the index's cursor) unless one runs: lines before it were seen by
 * whoever read the homes whole. Readers of the homes call it before their first full read, so nothing written while
 * they read is missed.
 */
export function startTail(root: string, from?: Cursor): void {
  const t = tails.get(root);
  if (!t) return void tails.set(root, new ChangeTail(root, from));
  // Asked to start earlier than the running reader is: it goes back there (every listener takes a line twice safely).
  if (from && (from.seg < t.cursor.seg || (from.seg === t.cursor.seg && from.off < t.cursor.off))) t.rewind(from);
}

/** Read what was appended since this process last read the root's log, and tell every listener. */
export function pollChanges(root: string): void {
  let t = tails.get(root);
  if (!t) tails.set(root, (t = new ChangeTail(root)));
  const { lines, gap } = t.read();
  if (!lines.length && !gap) return;
  for (const fn of listeners) {
    try {
      fn(root, lines, gap);
    } catch (err) {
      console.warn("[chat-homes] a change listener failed:", err instanceof Error ? err.message : String(err));
    }
  }
}

/** Where this process's reader of `root` is (what an index written now covers). */
export const tailCursor = (root: string): Cursor => ({ ...(tails.get(root)?.cursor ?? logEnd(root)) });

/** The homes root moved (or tests): every reader starts again. */
export function resetChangeTails(): void {
  tails.clear();
  writers.clear();
}

// ---- the index --------------------------------------------------------------------------------------

/** A home as the index keeps it: its conversation file names, as listed when its `sessions/` folder had stamp `st`. */
export interface IndexedHome {
  files: string[];
  st: string;
}

export interface HomesIndex {
  v: typeof INDEX_VERSION;
  /** The log position the index covers: a reader replays from here. */
  cursor: Cursor;
  homes: Record<string, IndexedHome>;
}

/** The root's index, or null when it is missing, torn or of a version this code doesn't know. */
export function readIndex(root: string): HomesIndex | null {
  try {
    changeIo.indexReads++;
    const v = JSON.parse(readFileSync(join(root, INDEX_NAME), "utf8")) as HomesIndex;
    if (v?.v !== INDEX_VERSION || !isCursor(v.cursor) || !v.homes || typeof v.homes !== "object" || Array.isArray(v.homes)) return null;
    for (const h of Object.values(v.homes))
      if (!h || !Array.isArray(h.files) || typeof h.st !== "string" || !h.files.every((f) => typeof f === "string" && f.endsWith(".jsonl") && !f.includes("/") && !f.startsWith("."))) return null;
    return v;
  } catch {
    return null;
  }
}

/**
 * Write the index whole (tmp + rename: a reader sees the old one or the new one), then remove each segment it has
 * passed by two that is older than the grace (the compactor). Never throws.
 */
export function writeIndex(root: string, idx: HomesIndex, now = Date.now()): void {
  if (!existsSync(root)) return;
  const file = join(root, INDEX_NAME);
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(idx), { mode: 0o600 });
    renameSync(tmp, file);
    changeIo.indexWrites++;
  } catch (err) {
    console.warn(`[chat-homes] ${file} write failed:`, err instanceof Error ? err.message : String(err));
    return;
  }
  compact(root, idx.cursor.seg, now);
}

/** Remove the segments below `covered - 1` older than the grace. A segment is never cut short, only removed whole. */
export function compact(root: string, covered: number, now = Date.now()): number {
  let removed = 0;
  const grace = compactGraceMs();
  for (const n of segments(root)) {
    if (n >= covered - 1) break;
    const f = segmentFile(root, n);
    try {
      if (grace > 0 && now - statSync(f).mtimeMs < grace) continue;
      unlinkSync(f);
      removed++;
    } catch {
      // gone already
    }
  }
  return removed;
}

