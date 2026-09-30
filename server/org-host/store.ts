// Snapshots and the redo journal of one org (design §5.3).
//
// Snapshots: one EDN file per session, portable `<workspace>/charts/<statechart>/<sid>.edn`, host-local
// `<stateRoot>/org-charts/<org>/<statechart>/<sid>.edn` (the session id URI-encoded).
// A call's snapshots span both places, so each commit is a redo journal
// `<stateRoot>/org-charts/<org>/journal/<id>.json` ({snapshots, rows}): written and fsynced first,
// then every snapshot is written in place (tmp + fsync + rename), the log rows appended, and the
// journal deleted. At open, every journal left is applied again (idempotent: a snapshot is a whole
// file; a row is appended only when its segment has no row of that journal yet).
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import { appendRows, type LogRow } from "./log";

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
  const local = join(stateDir, "org-charts", orgId);
  return {
    portable: join(workspaceDir, "charts"),
    portableLog: join(workspaceDir, "charts", "log"),
    local,
    localLog: join(local, "log"),
    journal: join(local, "journal"),
  };
}

const NOT_CHARTS = new Set(["log", "journal"]);

export function snapshotFile(root: string, chart: string, sid: string): string {
  return join(root, chart, `${encodeURIComponent(sid)}.edn`);
}

/** Every snapshot file under `root`: `{sid, statechart, file}`. */
export function scanSnapshots(root: string): { sid: string; chart: string; file: string }[] {
  if (!existsSync(root)) return [];
  const out: { sid: string; chart: string; file: string }[] = [];
  for (const chart of readdirSync(root, { withFileTypes: true })) {
    if (!chart.isDirectory() || NOT_CHARTS.has(chart.name)) continue;
    for (const f of readdirSync(join(root, chart.name))) {
      if (!f.endsWith(".edn")) continue;
      out.push({ sid: decodeURIComponent(f.slice(0, -4)), chart: chart.name, file: join(root, chart.name, f) });
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
  const tmp = `${file}.tmp-${process.pid}`;
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
}

let seq = 0;

export function journalId(at: number): string {
  seq = (seq + 1) % 1_000_000;
  return `${String(at).padStart(15, "0")}-${process.pid}-${String(seq).padStart(6, "0")}`;
}

function rowsOfJournalPresent(file: string, id: string): boolean {
  if (!existsSync(file)) return false;
  return readFileSync(file, "utf8").includes(`"j":"${id}"`);
}

/** Apply a journal: snapshots in place, rows appended once. */
export function applyJournal(j: Journal, durable: boolean, replay: boolean): void {
  for (const s of j.snapshots) writeAtomic(s.file, s.text, durable);
  const rows = replay ? j.rows.filter((r) => !rowsOfJournalPresent(r.file, j.id)) : j.rows;
  appendRows(rows);
}

/** Commit a batch: journal, apply, delete the journal. */
export function commitJournal(dir: string, j: Journal, durable: boolean, hooks?: { afterJournal?: () => void; afterApply?: () => void }): void {
  const file = join(dir, `${j.id}.json`);
  writeAtomic(file, JSON.stringify(j), durable);
  hooks?.afterJournal?.();
  applyJournal(j, durable, false);
  hooks?.afterApply?.();
  rmSync(file, { force: true });
  if (durable) fsyncDir(dir);
}

export interface JournalProblem {
  file: string;
  why: string;
}

/** Apply every journal left in `dir`, oldest first. A journal that doesn't parse stops here: it is
    returned as the problem and nothing after it is applied (a half-applied batch is never guessed). */
export function replayJournals(dir: string, durable: boolean): { applied: number; problem: JournalProblem | null } {
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
    applyJournal(j, durable, true);
    rmSync(file, { force: true });
    applied++;
  }
  // a torn tmp file of a journal is not a journal (its rename never happened)
  for (const name of readdirSync(dir).filter((n) => n.includes(".tmp-"))) rmSync(join(dir, name), { force: true });
  return { applied, problem: null };
}
