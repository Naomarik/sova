// One-session writes that more than one surface offers (the sidebar's selection toolbar, the
// session pane, the Agents board): the request, and the one sentence it ends with.

import type { SessionSummary } from "../../shared/protocol";
import { setSessionArchived, setSessionTitle } from "./api";
import { quoted } from "./session-groups";
import { announce, toast } from "./ui-state";

/**
 * Rename a session in Sova, or clear its title with `null` so the derived one comes back.
 * Resolves `undefined` when there is nothing to write (the same title back, or clearing a session
 * that has no title of its own — no `originalTitle` means nothing is overriding anything), else
 * whether the write landed. Says what happened either way.
 */
export async function renameSession(s: Pick<SessionSummary, "path" | "title" | "originalTitle">, title: string | null): Promise<boolean | undefined> {
  if (title === s.title || (title === null && s.originalTitle === undefined)) return undefined;
  try {
    await setSessionTitle(s.path, title);
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
export async function archiveSession(path: string, archived: boolean): Promise<boolean> {
  try {
    await setSessionArchived(path, archived);
    const done = archived ? "Archived. Find it under Archive." : "Moved back to Live & web.";
    toast(done);
    announce(done);
    return true;
  } catch (err) {
    toast(`Couldn't ${archived ? "archive" : "unarchive"} this session. ${(err as Error).message}`);
    return false;
  }
}
