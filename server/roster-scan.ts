import { open } from "node:fs/promises";
import type { SessionSummary } from "../shared/protocol";
import { LEGACY_REGISTRY_ENTRY_TYPE, readWorkerManifests, WORKER_MANIFEST_ENTRY_TYPE } from "../pi-config/extensions/subagents/worker-transcript.ts";
import { TEAM_ENTRY, teamChipOf } from "./insights";
import { TEAM_EVENT_TYPE } from "./reports";
import { activeBranch, type Entry } from "./transcript";

/**
 * The session list's side of a session's subagents, from its file: its first team
 * (SessionSummary.team), what the head's "Team · N" chip says before the view's insight loads, and
 * how many workers its records restore (SessionSummary.restoredWorkers), what the composer's
 * settled-workers trigger counts before the runtime's first "workers" message. Both are there from
 * the view's first frame instead of moving the head or the status row when they land (§app/insights,
 * opening a session). Read like the align scan (server/align-state.ts): a file without a team entry
 * or a worker record is only searched for their markers; once one is seen, its entries are kept
 * compact and each later read parses only the lines appended since. The folds are the insight's
 * own (teamChipOf, and readWorkerManifests as worker-restore.ts calls it), on the active branch.
 */

/** The bytes each kind of entry carries (JSON.stringify writes no space after the colon). */
const customMark = (type: string) => `"customType":"${type}"`;
const MARKERS = [TEAM_ENTRY, WORKER_MANIFEST_ENTRY_TYPE, LEGACY_REGISTRY_ENTRY_TYPE].map((t) => Buffer.from(customMark(t)));
const MARKER_MAX = Math.max(...MARKERS.map((m) => m.length));
/** The custom entries whose data the folds read. */
const KEPT = new Set([TEAM_ENTRY, TEAM_EVENT_TYPE, WORKER_MANIFEST_ENTRY_TYPE, LEGACY_REGISTRY_ENTRY_TYPE]);
const KEPT_MARKS = [...KEPT].map(customMark);
/** A live record lists at most this many workers (MAX_WORKERS in pi-config's sessions schema), and
    the composer counts the ones it lists: a restored count past it would drop when the record says. */
const RECORD_WORKERS_MAX = 40;
const CHUNK = 256 * 1024;

/** One entry, kept only as far as the fold needs it: its tree position, and a team entry's data. */
interface ScanEntry {
  type: string;
  id?: string;
  parentId?: string | null;
  customType?: string;
  data?: unknown;
}

/** How far a file's roster read got, kept with its cached summary (like AlignScan). */
export interface RosterScan {
  /** Bytes read: the marker search's reach, or (once found) the end of the last complete line. */
  size: number;
  /** A team entry or a worker record was seen somewhere before `size`. */
  found: boolean;
  /** The folds' answers at `size`. */
  team: SessionSummary["team"];
  restoredWorkers: number;
  /** Once found: the file's entries so far, compact. */
  entries?: ScanEntry[];
}

/** Whether [from, size) of the file contains a marker, reading raw bytes (no JSON parse). */
async function hasMarker(path: string, from: number, size: number): Promise<boolean> {
  const fh = await open(path, "r");
  try {
    // Overlap each chunk by a marker's length so a marker split across two reads is still seen.
    let pos = Math.max(0, from - MARKER_MAX);
    const buf = Buffer.alloc(CHUNK + MARKER_MAX);
    while (pos < size) {
      const { bytesRead } = await fh.read(buf, 0, Math.min(buf.length, size - pos), pos);
      if (bytesRead <= 0) return false;
      const read = buf.subarray(0, bytesRead);
      if (MARKERS.some((m) => read.includes(m))) return true;
      if (pos + bytesRead >= size) return false;
      pos += bytesRead - MARKER_MAX;
    }
    return false;
  } finally {
    await fh.close();
  }
}

/** pi writes type, id and parentId first; most lines need nothing more, so most are never JSON-parsed. */
const HEAD = /^\{"type":"([^"]+)","id":"([^"]+)","parentId":(?:null|"([^"]*)")/;

/** A line as a ScanEntry, or null for a blank or malformed one. */
function compactLine(line: string): ScanEntry | null {
  const head = HEAD.exec(line);
  const wanted = KEPT_MARKS.some((m) => line.includes(m));
  if (head && !wanted) return { type: head[1]!, id: head[2]!, parentId: head[3] ?? null };
  let v: unknown;
  try {
    v = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof v !== "object" || v === null || Array.isArray(v)) return null;
  const r = v as Record<string, unknown>;
  if (typeof r.type !== "string") return null;
  const e: ScanEntry = { type: r.type };
  if (typeof r.id === "string") e.id = r.id;
  if (typeof r.parentId === "string" || r.parentId === null) e.parentId = r.parentId as string | null;
  if (r.type === "custom" && typeof r.customType === "string" && KEPT.has(r.customType)) {
    e.customType = r.customType;
    e.data = r.data;
  }
  return e;
}

/** Reads [from, size) of the file and appends its complete lines to `into`; returns where they end. */
async function appendLines(path: string, from: number, size: number, into: ScanEntry[]): Promise<number> {
  const fh = await open(path, "r");
  try {
    const buf = Buffer.alloc(CHUNK);
    let pos = from;
    let carry = Buffer.alloc(0);
    let consumed = from;
    while (pos < size) {
      const { bytesRead } = await fh.read(buf, 0, Math.min(buf.length, size - pos), pos);
      if (bytesRead <= 0) break;
      pos += bytesRead;
      const data = carry.length > 0 ? Buffer.concat([carry, buf.subarray(0, bytesRead)]) : buf.subarray(0, bytesRead);
      let start = 0;
      for (let nl = data.indexOf(10, start); nl !== -1; nl = data.indexOf(10, start)) {
        const line = data.toString("utf8", start, nl);
        if (line.trim() !== "") {
          const e = compactLine(line);
          if (e) into.push(e);
        }
        start = nl + 1;
      }
      consumed += start;
      carry = Buffer.from(data.subarray(start));
    }
    // A trailing partial line is left for the next read, which starts at its first byte.
    return consumed;
  } finally {
    await fh.close();
  }
}

/** Whether `offset` is still a line start in the file (the byte before it is a newline). */
async function atLineStart(path: string, offset: number): Promise<boolean> {
  if (offset === 0) return true;
  const fh = await open(path, "r");
  try {
    const b = Buffer.alloc(1);
    const { bytesRead } = await fh.read(b, 0, 1, offset - 1);
    return bytesRead === 1 && b[0] === 10;
  } finally {
    await fh.close();
  }
}

/** The workers the branch's records restore: the manifests on it, as worker-restore.ts folds them. */
function restoredOf(entries: readonly ScanEntry[], branch: readonly Entry[]): number {
  try {
    const activeEntryIds = new Set(branch.map((e) => e.id).filter((id): id is string => typeof id === "string"));
    let n = 0;
    for (const m of readWorkerManifests(entries, { activeEntryIds }).manifests.values()) if (m.onActiveBranch) n++;
    return Math.min(n, RECORD_WORKERS_MAX);
  } catch {
    return 0; // unreadable records restore nothing (workerCwds in insights.ts reads them the same way)
  }
}

const NONE = (size: number): RosterScan => ({ size, found: false, team: undefined, restoredWorkers: 0 });

/**
 * A session file's first team and restorable workers for the list, read incrementally (see the
 * module comment). A file that shrank, or was rewritten so the last read no longer ends at a line
 * start, is read again from the beginning. Never throws: an unreadable file has none.
 */
export async function readRosterScan(path: string, size: number, prev: RosterScan | null): Promise<RosterScan> {
  try {
    const grown = prev !== null && size >= prev.size;
    if (!(grown && prev.found)) {
      const found = await hasMarker(path, grown ? prev.size : 0, size);
      if (!found) return NONE(size);
    }
    let entries: ScanEntry[];
    let from: number;
    if (grown && prev.found && prev.entries && (await atLineStart(path, prev.size))) {
      entries = prev.entries;
      from = prev.size;
    } else {
      entries = [];
      from = 0;
    }
    const end = from === size ? size : await appendLines(path, from, size, entries);
    const branch = activeBranch(entries as Entry[]);
    return { size: end, found: true, team: teamChipOf(branch), restoredWorkers: restoredOf(entries, branch), entries };
  } catch {
    return NONE(size);
  }
}
