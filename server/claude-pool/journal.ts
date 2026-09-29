import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { writeFileAtomic } from "../sync/logins-stores";

/**
 * The pool agent's journal (`<state root>/claude-pool-journal.json`): every move step this device
 * has started, written (atomically, fsynced) BEFORE the step's effect, so a crash at any point is
 * finished or undone at the next start (§app.claude-logins/borrow-return). One op per login.
 * No secret: ids, devices, counters and times.
 *
 * - lend   (keeper):   offered → committing → (cleared)
 * - borrow (borrower): staged → activating → (cleared)
 * - return (holder):   draining → sending → deleting → (cleared); `drop` skips sending (removed,
 *                      or superseded by a newer holder): draining → deleting.
 */

export type LeaveKind = "return" | "drop";
export type JournalOp =
  | { op: "lend"; state: "offered" | "committing"; peer: string; seq: number; requestId: string; at: number; credentialsHash: string }
  | { op: "borrow"; state: "staged" | "activating"; peer: string; seq: number; requestId: string; at: number }
  | { op: "leave"; kind: LeaveKind; state: "draining" | "sending" | "deleting"; reason: string; at: number; cutAt: number; peer?: string; seq?: number; killedAt?: number };

export interface Journal {
  version: 1;
  ops: Record<string, JournalOp>;
}

export const journalPath = (stateDir: string): string => join(stateDir, "claude-pool-journal.json");

export function readJournal(stateDir: string): Journal {
  try {
    const json = JSON.parse(readFileSync(journalPath(stateDir), "utf8")) as Journal;
    if (json?.version !== 1 || !json.ops || typeof json.ops !== "object") return { version: 1, ops: {} };
    return json;
  } catch {
    return { version: 1, ops: {} };
  }
}

export function writeJournal(stateDir: string, journal: Journal): void {
  mkdirSync(stateDir, { recursive: true });
  writeFileAtomic(journalPath(stateDir), `${JSON.stringify(journal, null, 2)}\n`);
}

/** Read, change one login's op (undefined clears it), write. */
export function setOp(stateDir: string, id: string, op: JournalOp | undefined): void {
  const journal = readJournal(stateDir);
  if (op) journal.ops[id] = op;
  else delete journal.ops[id];
  writeJournal(stateDir, journal);
}
