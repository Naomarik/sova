// One-session writes that more than one surface offers (the session pane, the Agents board): the
// request, and the one sentence it ends with.

import type { SessionSummary } from "../../shared/protocol";
import { setSessionArchived, setSessionTitle } from "./api";
import { archivedDropToast, unarchivedToast } from "./drag-archive";
import { quoted } from "./session-groups";
import { announce, toast } from "./ui-state";

/**
 * Rename a session in Sova, or clear its title with `null` so the derived one comes back.
 * Resolves `undefined` when there is nothing to write (the same title back, or clearing a session
 * that has no title of its own — no `originalTitle` means nothing is overriding anything), else
 * whether the write landed. Says what happened either way.
 */
export async function renameSession(
  s: Pick<SessionSummary, "path" | "title" | "originalTitle">,
  title: string | null,
  /** The write: a menu row's command (src/lib/menu-place.ts), else the page's own call. */
  send: () => Promise<unknown> = () => setSessionTitle(s.path, title),
): Promise<boolean | undefined> {
  if (title === s.title || (title === null && s.originalTitle === undefined)) return undefined;
  try {
    await send();
    const done = title ? `Renamed to ${quoted(title)}.` : `Title cleared. Back to ${quoted(s.originalTitle ?? s.title)}.`;
    toast(done);
    announce(done);
    return true;
  } catch (err) {
    toast(`Couldn't rename this session. ${(err as Error).message}`);
    return false;
  }
}

/** Archive or unarchive one session; says what happened, and resolves whether it landed. */
export async function archiveSession(
  path: string,
  archived: boolean,
  project?: string | null,
  send: () => Promise<unknown> = () => setSessionArchived(path, archived),
): Promise<boolean> {
  try {
    const res = (await send()) as { deleted?: true };
    // `project`: an organization's session, which goes to its group's Done list in that project, not the Archive.
    // `deleted`: an empty husk was deleted instead, and the toast says so.
    const done = archived ? archivedDropToast(!!res.deleted, project).text : unarchivedToast(project);
    toast(done);
    announce(done);
    return true;
  } catch (err) {
    toast(`Couldn't ${archived ? "archive" : "unarchive"} this session. ${(err as Error).message}`);
    return false;
  }
}
