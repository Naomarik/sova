// The org history's files: where they live, how an event id is
// minted, how a line is read back by its offset, and the host-local problem notes. Writing goes
// through the org host's redo journal (server/org-host/store.ts), never through here.
//
// Portable, in the workspace repo: history/events/<yyyy-mm>.jsonl (structural lines, only appended
// to) and history/rationale/<event id>.json (the private recorded reason). Host-local, under
// <stateRoot>/org-history/<org>/: index.json (rebuildable), writer.json (this host's writer epoch),
// problems.jsonl (torn fragments kept aside), gap.json (an open capture gap).
import { randomBytes } from "node:crypto";
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { HISTORY_SCHEMA, type EventId, type HistoryRationale } from "../../shared/org-history";
import { writeAtomic } from "../org-host/store";

export interface HistoryPaths {
  /** <workspace>/history */
  root: string;
  events: string;
  rationale: string;
  /** <stateRoot>/org-history/<org> */
  local: string;
}

export function historyPaths(orgId: string, workspaceDir: string, stateDir: string): HistoryPaths {
  const root = join(workspaceDir, "history");
  return { root, events: join(root, "events"), rationale: join(root, "rationale"), local: join(stateDir, "org-history", orgId) };
}

const ID = /^he_[0-9a-f]{32}$/;

/** A fresh event id: `he_` and 32 random hex characters, never derived from anything. */
export function newEventId(): EventId {
  return `he_${randomBytes(16).toString("hex")}`;
}

export const isEventId = (v: unknown): v is EventId => typeof v === "string" && ID.test(v);

/** The UTC month's segment name of a recorded time. */
export function segmentName(recordedAt: number): string {
  const d = new Date(recordedAt);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}.jsonl`;
}

/** Every segment, oldest month first. */
export function segments(paths: HistoryPaths): string[] {
  if (!existsSync(paths.events)) return [];
  return readdirSync(paths.events)
    .filter((n) => /^\d{4}-\d{2}\.jsonl$/.test(n))
    .sort();
}

export const segmentPath = (paths: HistoryPaths, name: string): string => join(paths.events, name);

export function segmentSize(paths: HistoryPaths, name: string): number {
  try {
    return statSync(segmentPath(paths, name)).size;
  } catch {
    return 0;
  }
}

export function rationaleFile(paths: HistoryPaths, id: EventId): string {
  if (!isEventId(id)) throw new Error(`Not an event id: ${id}`);
  return join(paths.rationale, `${id}.json`);
}

/** One line's bytes, by offset and length (no whole-file read). */
export function readLineAt(paths: HistoryPaths, seg: string, off: number, len: number): string | null {
  let fd: number;
  try {
    fd = openSync(segmentPath(paths, seg), "r");
  } catch {
    return null;
  }
  try {
    const buf = Buffer.alloc(len);
    const n = readSync(fd, buf, 0, len, off);
    return buf.subarray(0, n).toString("utf8");
  } finally {
    closeSync(fd);
  }
}

/** Bytes of a segment from `from` to its end, split into complete lines with their offsets. A last line
    with no newline yet is left for later (`end` stops before it). */
export function linesFrom(paths: HistoryPaths, seg: string, from: number): { lines: { off: number; len: number; text: string }[]; end: number } {
  const file = segmentPath(paths, seg);
  const size = segmentSize(paths, seg);
  if (size <= from) return { lines: [], end: from };
  const fd = openSync(file, "r");
  let buf: Buffer;
  try {
    buf = Buffer.alloc(size - from);
    readSync(fd, buf, 0, buf.length, from);
  } finally {
    closeSync(fd);
  }
  const lines: { off: number; len: number; text: string }[] = [];
  let start = 0;
  for (;;) {
    const nl = buf.indexOf(0x0a, start);
    if (nl < 0) break;
    const len = nl - start;
    if (len > 0) lines.push({ off: from + start, len, text: buf.subarray(start, nl).toString("utf8") });
    start = nl + 1;
  }
  return { lines, end: from + start };
}

export type RationaleRead = { state: "present"; rationale: HistoryRationale } | { state: "absent" | "unreadable" };

export function readRationale(paths: HistoryPaths, id: EventId): RationaleRead {
  let text: string;
  try {
    text = readFileSync(rationaleFile(paths, id), "utf8");
  } catch {
    return { state: "absent" };
  }
  try {
    const r = JSON.parse(text) as HistoryRationale;
    if (!r || r.v !== HISTORY_SCHEMA || r.event !== id) return { state: "unreadable" };
    return { state: "present", rationale: r };
  } catch {
    return { state: "unreadable" };
  }
}

/** A torn fragment or another problem, kept aside host-local (never in the repo). */
export function noteProblem(paths: HistoryPaths, note: Record<string, unknown>): void {
  try {
    mkdirSync(paths.local, { recursive: true });
    appendFileSync(join(paths.local, "problems.jsonl"), JSON.stringify(note) + "\n");
  } catch {
    // a problem note that can't be written is still reported in memory by the caller
  }
}

/** Crashed temp files under history/ (a rename that never happened): removed at open so no commit
    carries one (current ones end in `.tmp`, older ones in `.tmp-<pid>`). */
export function sweepTemps(paths: HistoryPaths): number {
  let n = 0;
  const walk = (dir: string): void => {
    if (!existsSync(dir)) return;
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(".tmp") || /\.tmp-\d+$/.test(e.name)) {
        rmSync(p, { force: true });
        n++;
      }
    }
  };
  walk(paths.root);
  return n;
}

/** This host's writer epoch (host-local, made once): orders this host's events without naming it. */
export function writerEpoch(paths: HistoryPaths): string {
  const file = join(paths.local, "writer.json");
  try {
    const w = JSON.parse(readFileSync(file, "utf8")) as { epoch?: unknown };
    if (typeof w.epoch === "string" && /^w_[0-9a-f]{16}$/.test(w.epoch)) return w.epoch;
  } catch {
    // none yet, or unreadable: a new epoch (sequences restart under it; order within each epoch holds)
  }
  const epoch = `w_${randomBytes(8).toString("hex")}`;
  writeAtomic(file, JSON.stringify({ epoch }), true);
  return epoch;
}

/** An open capture gap: host-local, so it survives when the repo can't be written. */
export interface OpenGap {
  from: number;
  to: number;
  acts: number;
}

export function readGap(paths: HistoryPaths): OpenGap | null {
  try {
    const g = JSON.parse(readFileSync(join(paths.local, "gap.json"), "utf8")) as OpenGap;
    return typeof g.from === "number" && typeof g.to === "number" ? g : null;
  } catch {
    return null;
  }
}

export function writeGap(paths: HistoryPaths, gap: OpenGap | null): void {
  const file = join(paths.local, "gap.json");
  if (!gap) rmSync(file, { force: true });
  else writeAtomic(file, JSON.stringify(gap), true);
}
