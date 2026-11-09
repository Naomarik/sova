// The Time Spent tab's own state (§app.subagents-pane/time-spent): the last read of each session's
// record, so a tab switch or a reopen shows its figures at once instead of the placeholder.
import type { TimeSpentRecord } from "../../shared/time-spent";

/** How often the showing tab reads the record again; the page reports about this often. */
export const TIME_SPENT_READ_MS = 15_000;

/** The last read per session path, in memory. */
const lastRead = new Map<string, { record: TimeSpentRecord; at: number }>();
const LAST_READS = 50;

export const lastTimeSpentRead = (path: string) => lastRead.get(path) ?? null;

export function keepTimeSpentRead(path: string, record: TimeSpentRecord, at: number): void {
  lastRead.delete(path);
  lastRead.set(path, { record, at });
  if (lastRead.size > LAST_READS) lastRead.delete(lastRead.keys().next().value!);
}
