// The Time Spent section's own state (§app.subagents-pane/time-spent): open or closed, one choice for
// this browser across all sessions, and the last read of each session's record, so a tab switch or a
// reopen shows its figures at once instead of the placeholder.
import { createSignal } from "solid-js";
import { readKey, writeKey } from "./storage-keys";
import type { TimeSpentRecord } from "../../shared/time-spent";

/** How often an open section reads the record again; the page reports about this often. */
export const TIME_SPENT_READ_MS = 15_000;

export const TIME_SPENT_OPEN_KEY = "sova:time-spent-open";

/** Closed until this browser opens it. Only an explicit "true" is open. */
export const parseOpen = (stored: string | null): boolean => stored === "true";

function storedOpen(): boolean {
  try {
    return parseOpen(readKey(localStorage, TIME_SPENT_OPEN_KEY));
  } catch {
    return false; // no storage at all: it starts closed, and the signal holds the choice for the page
  }
}

const [timeSpentOpen, setOpenSignal] = createSignal(storedOpen());
export { timeSpentOpen };

export function setTimeSpentOpen(open: boolean): void {
  setOpenSignal(open);
  try {
    writeKey(localStorage, TIME_SPENT_OPEN_KEY, open ? "true" : "false");
  } catch {
    // Persistence is a convenience; the choice still holds for this page.
  }
}

/** The last read per session path, in memory. */
const lastRead = new Map<string, { record: TimeSpentRecord; at: number }>();
const LAST_READS = 50;

export const lastTimeSpentRead = (path: string) => lastRead.get(path) ?? null;

export function keepTimeSpentRead(path: string, record: TimeSpentRecord, at: number): void {
  lastRead.delete(path);
  lastRead.set(path, { record, at });
  if (lastRead.size > LAST_READS) lastRead.delete(lastRead.keys().next().value!);
}
