// Snapshots and the redo journal of one org (design §5.3).
//
// Snapshots: one EDN file per session, portable `<workspace>/statecharts/<statechart>/<sid>.edn`, host-local
// `<stateRoot>/statecharts/<org>/<statechart>/<sid>.edn` (the session id URI-encoded).
// A call's snapshots span both places, so each commit is a redo journal
// `<stateRoot>/statecharts/<org>/journal/<id>.json` ({snapshots, rows}): written and fsynced first,
// then every snapshot is written in place (tmp + fsync + rename), the log rows and history events
// appended (fsynced), the history files written or removed, and the journal deleted. At open, every
// journal left is applied again (idempotent: a snapshot or a history file is a whole file; a log row
// is appended only when its segment lacks that row's key, a history event only when its segment lacks
// its id), and then checked: a row or event still missing makes the journal a problem, never a success.
// An append first checks the segment's last byte: a torn last line is cut only when the journal holds
// it whole, else kept, closed with a newline, and reported (`onTorn`).
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import { appendLines, appendRows, type LogRow, type TornTail } from "./log";

export interface HostPaths {
  /** Portable snapshots and the portable log live under here (in the workspace repo). */
  portable: string;
  portableLog: string;
  /** Host-local snapshots, the host-local log and the journal. */
  local: string;
  localLog: string;
  journal: string;
}

export function hostPaths(orgId: string, workspaceDir: string, stateDir: string): HostPaths {
  const local = join(stateDir, "statecharts", orgId);
  return {
    portable: join(workspaceDir, "statecharts"),
    portableLog: join(workspaceDir, "statecharts", "log"),
    local,
    localLog: join(local, "log"),
    journal: join(local, "journal"),
  };
}

const NOT_STATECHARTS = new Set(["log", "journal"]);

export function snapshotFile(root: string, statechart: string, sid: string): string {
  return join(root, statechart, `${encodeURIComponent(sid)}.edn`);
}

/** Every snapshot file under `root`: `{sid, statechart, file}`. */
export function scanSnapshots(root: string): { sid: string; statechart: string; file: string }[] {
  if (!existsSync(root)) return [];
  const out: { sid: string; statechart: string; file: string }[] = [];
  for (const statechart of readdirSync(root, { withFileTypes: true })) {
    if (!statechart.isDirectory() || NOT_STATECHARTS.has(statechart.name)) continue;
    for (const f of readdirSync(join(root, statechart.name))) {
      if (!f.endsWith(".edn")) continue;
      out.push({ sid: decodeURIComponent(f.slice(0, -4)), statechart: statechart.name, file: join(root, statechart.name, f) });
    }
  }
  return out.sort((a, b) => a.sid.localeCompare(b.sid));
}

function fsyncDir(dir: string): void {
  try {
    const fd = openSync(dir, "r");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  } catch {
    // some filesystems refuse a directory fsync; the file's own fsync still holds
  }
}

/** Write `text` to `file` atomically (tmp + fsync + rename). */
export function writeAtomic(file: string, text: string, durable: boolean): void {
  mkdirSync(dirname(file), { recursive: true });
  // ends in .tmp: the workspace's .gitignore keeps a crashed one out of a commit
  const tmp = `${file}.${process.pid}.tmp`;
  const fd = openSync(tmp, "w");
  try {
    writeSync(fd, text);
    if (durable) fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, file);
  if (durable) fsyncDir(dirname(file));
}

export interface Journal {
  id: string;
  at: number;
  snapshots: { sessionId: string; file: string; text: string }[];
  rows: { file: string; row: LogRow }[];
  /** The step's history (server/org-history/): event lines by id, rationale files written, files removed (a purge). */
  history?: JournalHistory;
}

export interface JournalHistory {
  lines: { file: string; id: string; line: string }[];
  files: { file: string; text: string }[];
  removes: string[];
}

/** A commit that failed: before its journal was written (nothing happened) or after (the journal holds it). */
export class JournalWriteError extends Error {
  constructor(readonly phase: "journal" | "apply", readonly cause: unknown, readonly file: string) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = "JournalWriteError";
  }
}

let seq = 0;

export function journalId(at: number): string {
  seq = (seq + 1) % 1_000_000;
  return `${String(at).padStart(15, "0")}-${process.pid}-${String(seq).padStart(6, "0")}`;
}

/** A segment's text, read once per replay. */
function textOf(cache: Map<string, string>, file: string): string {
  let t = cache.get(file);
  if (t == null) {
    t = existsSync(file) ? readFileSync(file, "utf8") : "";
    cache.set(file, t);
  }
  return t;
}

/** A log row is there: its key (or, for a journal written before rows had keys, any row of its journal). */
function rowPresent(cache: Map<string, string>, file: string, row: LogRow, j: string): boolean {
  const text = textOf(cache, file);
  return row.k ? text.includes(`"k":"${row.k}"`) : text.includes(`"j":"${j}"`);
}

function eventPresent(cache: Map<string, string>, file: string, id: string): boolean {
  return textOf(cache, file).includes(`"id":"${id}"`);
}

/** Apply a journal: snapshots in place, rows and events appended once, history files written or removed. */
export function applyJournal(j: Journal, durable: boolean, replay: boolean, onTorn?: (t: TornTail) => void): void {
  for (const s of j.snapshots) writeAtomic(s.file, s.text, durable);
  const cache = new Map<string, string>();
  const rows = replay ? j.rows.filter((r) => !rowPresent(cache, r.file, r.row, j.id)) : j.rows;
  appendRows(rows, durable, onTorn, replay);
  const h = j.history;
  if (!h) return;
  const lines = replay ? h.lines.filter((l) => !eventPresent(cache, l.file, l.id)) : h.lines;
  const byFile = new Map<string, string[]>();
  for (const l of lines) byFile.set(l.file, [...(byFile.get(l.file) ?? []), l.line]);
  for (const [file, ls] of byFile) appendLines(file, ls, durable, onTorn, replay);
  for (const f of h.files) writeAtomic(f.file, f.text, durable);
  for (const f of h.removes) rmSync(f, { force: true });
}

/** What of a journal is not on disk after applying it (empty: all of it is). */
export function missingOf(j: Journal): string[] {
  const cache = new Map<string, string>();
  const out: string[] = [];
  j.rows.forEach((r, i) => {
    if (!rowPresent(cache, r.file, r.row, j.id)) out.push(`log row ${i + 1} in ${r.file}`);
  });
  for (const l of j.history?.lines ?? []) if (!eventPresent(cache, l.file, l.id)) out.push(`event ${l.id} in ${l.file}`);
  for (const f of j.history?.files ?? []) if (!existsSync(f.file)) out.push(f.file);
  for (const s of j.snapshots) if (!existsSync(s.file)) out.push(s.file);
  for (const f of j.history?.removes ?? []) if (existsSync(f)) out.push(`${f} (still there)`);
  return out;
}

/** Commit a batch: journal, apply, delete the journal. A failure throws JournalWriteError with its phase. */
export function commitJournal(
  dir: string,
  j: Journal,
  durable: boolean,
  hooks?: { beforeJournal?: () => void; afterJournal?: () => void; afterApply?: () => void },
  onTorn?: (t: TornTail) => void,
): void {
  const file = join(dir, `${j.id}.json`);
  try {
    hooks?.beforeJournal?.();
    writeAtomic(file, JSON.stringify(j), durable);
  } catch (err) {
    throw new JournalWriteError("journal", err, file);
  }
  try {
    hooks?.afterJournal?.();
    applyJournal(j, durable, false, onTorn);
    hooks?.afterApply?.();
  } catch (err) {
    throw new JournalWriteError("apply", err, file);
  }
  rmSync(file, { force: true });
  if (durable) fsyncDir(dir);
}

export interface JournalProblem {
  file: string;
  why: string;
}

/** Apply every journal left in `dir`, oldest first. A journal that doesn't parse stops here: it is
    returned as the problem and nothing after it is applied (a half-applied batch is never guessed). */
export function replayJournals(dir: string, durable: boolean, onTorn?: (t: TornTail) => void): { applied: number; problem: JournalProblem | null } {
  if (!existsSync(dir)) return { applied: 0, problem: null };
  let applied = 0;
  for (const name of readdirSync(dir).filter((n) => n.endsWith(".json")).sort()) {
    const file = join(dir, name);
    let j: Journal;
    try {
      j = JSON.parse(readFileSync(file, "utf8")) as Journal;
      if (!j || !Array.isArray(j.snapshots) || !Array.isArray(j.rows) || typeof j.id !== "string") throw new Error("it is not a journal");
    } catch (err) {
      return { applied, problem: { file, why: err instanceof Error ? err.message : String(err) } };
    }
    try {
      applyJournal(j, durable, true, onTorn);
    } catch (err) {
      return { applied, problem: { file, why: err instanceof Error ? err.message : String(err) } };
    }
    const missing = missingOf(j);
    if (missing.length) return { applied, problem: { file, why: `after replay, still missing: ${missing.slice(0, 3).join(", ")}` } };
    rmSync(file, { force: true });
    applied++;
  }
  // a torn tmp file of a journal is not a journal (its rename never happened)
  for (const name of readdirSync(dir).filter((n) => n.includes(".tmp-") || n.endsWith(".tmp"))) rmSync(join(dir, name), { force: true });
  return { applied, problem: null };
}
