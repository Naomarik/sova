import { acquireChatHandle, chatHandles, closeChat } from "../chat-handle";
import { inLoadoutOrder } from "../session-setup";

/**
 * After a folder's context file and skill decisions change (server/approvals.ts's one write), or the Sova-wide
 * "Allow context files and skills without asking" setting (every folder): each chat of the folder this
 * server holds that is still before its first message, idle and switchable (its setup card's window), is
 * rebuilt so it starts with them; a started chat is never rebuilt (its list was fixed at its first message).
 * Every pane of the folder's chats is told to re-read its setup (`setup_changed`), so a held Send clears
 * live. Runs in the setup card's own order, so a card's switch and this never interleave.
 */
export function refreshFolderChats(folderKey: string | null): Promise<number> {
  return inLoadoutOrder(async () => {
    const { folderForCwd } = await import("../approvals");
    const ofFolder = (cwd: string) => {
      if (folderKey === null) return true;
      try {
        return folderForCwd(cwd).key === folderKey;
      } catch {
        return false;
      }
    };
    let n = 0;
    for (const h of chatHandles()) {
      const m = h.mirror;
      if (m.special || !ofFolder(m.cwd)) continue;
      if (m.pristine && !m.running && m.loadout?.toggleable) {
        await closeChat(h.path, "Applying the context files and skills.");
        await acquireChatHandle(h.path).catch((err) => console.warn(`[approvals] reopen after a change failed: ${err instanceof Error ? err.message : String(err)}`));
        n++;
      }
    }
    // Told after the rebuilds, to whichever panes are attached by then (a rebuilt chat's panes also re-read at hello).
    for (const h of chatHandles()) if (!h.mirror.special && ofFolder(h.mirror.cwd)) (h as { pushSetupChanged?: () => void }).pushSetupChanged?.();
    return n;
  });
}

/** A project's chats (by its id): refreshFolderChats for its folder. */
export const refreshNewChats = (pid: string): Promise<number> => refreshFolderChats(`p:${pid}`);

/** After a folder's list changes, or the Sova-wide setting (null: every folder): its chats not yet started start with it. */
export async function notifySetupChanged(folderKey: string | null): Promise<void> {
  await refreshFolderChats(folderKey);
}
