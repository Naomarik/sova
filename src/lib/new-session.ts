// Bare "/new" in the composer (spec/04d-slash-commands.md §4d): a fresh session in the chat's folder, and the
// chat it was typed in goes to the Archive. Kept free of the api module so it's testable.

/** The folder "/new" starts in: the chat's own, else the most recently active session's. */
export function newSessionCwd(current: string | null | undefined, sessions: readonly { cwd: string; lastActiveAt: string }[]): string | null {
  if (current) return current;
  const latest = [...sessions].sort((a, b) => b.lastActiveAt.localeCompare(a.lastActiveAt))[0];
  return latest?.cwd || null;
}

export type NewSessionOutcome<S> =
  | { ok: true; session: S; archiveError: string | null }
  | { ok: false; error: string };

/**
 * Creates first, archives the source only once that worked: a failed create leaves the chat the
 * user is in exactly as it was. A failed archive doesn't undo the new session. A null source is
 * one the caller keeps open: nothing is archived.
 */
export async function createThenArchive<S>(
  cwd: string,
  source: string | null,
  api: { create(cwd: string): Promise<S>; archive(path: string): Promise<unknown> },
): Promise<NewSessionOutcome<S>> {
  let session: S;
  try {
    session = await api.create(cwd);
  } catch (err) {
    return { ok: false, error: (err as Error).message || "The session couldn't be created." };
  }
  if (source === null) return { ok: true, session, archiveError: null };
  try {
    await api.archive(source);
    return { ok: true, session, archiveError: null };
  } catch (err) {
    return { ok: true, session, archiveError: (err as Error).message || "Unknown error." };
  }
}

/**
 * Prunes a just-archived session from the rows this tab created (App's `created`): archiving takes
 * the session off the server's list — a message-less one is deleted outright — so the row frozen at
 * creation would outlive it in the sidebar. Unarchiving leaves the set alone. True when one went.
 */
export function dropArchived(created: { delete(path: string): boolean }, path: string, archived: boolean): boolean {
  return archived ? created.delete(path) : false;
}
