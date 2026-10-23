// A worker's report check (§app.decisions/worker-report): the Untested chip a worker row gets from
// the server's check of its newest done report, and the key that says when to ask again. Pure: the
// Agents pane reads these, the tests pin them.

import type { WorkerChecks, WorkerInfo } from "../../shared/protocol";
import { providerName } from "./signals";

/** The row's chip, only for a report that reads finished but doesn't say it ran tests or checks. */
export function untestedChip(c: WorkerChecks, workerId: string): { text: string; title: string } | null {
  const w = c.workers[workerId];
  if (!w?.unverified) return null;
  return { text: "Untested", title: `Says it's done, but the report doesn't say it ran tests or checks. Guessed by ${providerName(w.provider, w.model)}.` };
}

/** The settled workers and when each ended, "ag_01@1700 ag_02@1800": a newly ended worker (a new
    report) is a new read; a working one adds nothing. Empty: nothing to ask about. */
export const checksKey = (workers: readonly Pick<WorkerInfo, "id" | "working" | "endedAt" | "lastActivity">[]): string =>
  workers
    .filter((w) => !w.working)
    .map((w) => `${w.id}@${w.endedAt ?? w.lastActivity ?? 0}`)
    .sort()
    .join(" ");
