/**
 * Files people sent a project (§app/file-intake), as the operator's main listener answers them.
 * Imported by the server and the operator app, so it imports nothing at runtime.
 *
 * GET    /api/projects/:pid/files      -> ProjectFilesAnswer
 * GET    /api/projects/:pid/files/:id  -> the bytes (attachment, application/octet-stream)
 * DELETE /api/projects/:pid/files/:id  -> { ok: true }
 */

export type ProjectFileStatus = "received" | "confirmed";

export interface ProjectFileRow {
  id: string;
  name: string;
  size: number;
  /** The sniffed label ("zip archive", "JSON", …). */
  kind: string;
  /** The sender's name (their roster name, else "Someone"). */
  sender: string;
  /** The gathering session it came in, with its public title; null when it is no longer known. */
  gathering: { sessionId: string; title: string; path?: string } | null;
  /** When it was received (ISO). */
  at: string;
  status: ProjectFileStatus;
  /** Its bytes are on this host (a restored org keeps the ledger without them). */
  here: boolean;
}

export interface ProjectFilesAnswer {
  files: ProjectFileRow[];
}
