/**
 * The merge queue's run logs as the merge thread's chat shows them (its Run Logs chip): the size of the project's
 * run folders, how many runs are packed, and what Clean Logs would take. Pure: imported by the server and the client.
 *
 *   GET  /api/merge-queue/run-logs?project=<id> | ?session=<the merge thread's chat>  → RunLogsInfo
 *   POST /api/merge-queue/run-logs/clean {project, confirm: true}                       → RunLogsCleaned
 */

/** Clean Logs keeps the newest this many runs' logs, whatever their state. */
export const RUN_LOGS_KEEP_NEWEST = 10;

/** A finished run's logs are packed once it ended this long ago (server/merge-queue/run-logs.ts). */
export const RUN_LOGS_PACK_AFTER_MS = 24 * 60 * 60 * 1000;

/** What a step's log reads once Clean Logs took it. */
export const RUN_LOG_CLEANED_LINE = "(log cleaned)";

export interface RunLogsInfo {
  project: string;
  /** Bytes on disk the project's run folders take (their files' sizes). */
  bytes: number;
  /** Run folders on disk. */
  runs: number;
  /** Runs whose logs are packed (gzip) already. */
  packed: number;
  /** What Clean Logs would take now: finished runs past the newest RUN_LOGS_KEEP_NEWEST that no open entry names. */
  cleanable: { runs: number; bytes: number };
}

export interface RunLogsCleaned {
  /** Runs whose logs went. */
  runs: number;
  /** Bytes freed. */
  freed: number;
  info: RunLogsInfo;
}

/** "1.4 GB", "312 MB", "18 KB": the chip's and the panel's size. */
export function sizeLabel(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = bytes / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 10 ? Math.round(v) : Math.round(v * 10) / 10} ${units[i]}`;
}
