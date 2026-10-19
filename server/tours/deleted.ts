import { lstatSync } from "node:fs";
import { dirname, join } from "node:path";
import { containedPath, digest, tourDirectory, writePrivate } from "./assets";
import { isTourSession } from "./store";

function marker(root: string, sessionId: string): string {
  if (!isTourSession(sessionId)) throw new Error("Invalid deleted tour scope.");
  return join(root, "tour-deleted", `${digest(sessionId)}.json`);
}

export type TourSessionDeletionStatus = "deleted" | "not-deleted" | "unknown";

/** Destructive cleanup needs concrete authority; an access failure is not a deletion receipt. */
export function tourSessionDeletionStatus(root: string, sessionId: string): TourSessionDeletionStatus {
  try {
    const path = marker(root, sessionId);
    containedPath(root, path, true);
    try { return lstatSync(path).isFile() ? "deleted" : "unknown"; }
    catch (error) { return (error as NodeJS.ErrnoException).code === "ENOENT" ? "not-deleted" : "unknown"; }
  } catch { return "unknown"; }
}

/** Auth fails closed on uncertainty. Regular marker presence revokes even with malformed bytes. */
export function isTourSessionDeleted(root: string, sessionId: string): boolean {
  return tourSessionDeletionStatus(root, sessionId) !== "not-deleted";
}

/** Written synchronously before yielding; contains no source, account or raw session identity. */
export function markTourSessionDeleted(root: string, sessionId: string): void {
  const path = marker(root, sessionId);
  tourDirectory(root, dirname(path));
  try { writePrivate(root, path, "{\"v\":1}\n"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    containedPath(root, path);
    if (!lstatSync(path).isFile()) throw new Error("The tour deletion barrier is unavailable.");
    // Existing bytes remain a tombstone even if malformed; deletion never force-repairs stores.
  }
}
