import { acquireChatHandle, chatHandles, closeChat } from "../chat-handle";
import { inLoadoutOrder } from "../session-setup";
import { projectForCwd } from "./skills";

/**
 * After a project's skill defaults change: each chat of the project this server holds that is still
 * before its first message, idle and switchable (its setup card's window), is rebuilt so it starts
 * with the new defaults. A started chat is never touched: its skills were fixed at its first message.
 * Runs in the setup card's own order, so a card's switch and this never interleave.
 */
export function refreshNewChats(pid: string): Promise<number> {
  return inLoadoutOrder(async () => {
    let n = 0;
    for (const h of chatHandles()) {
      const m = h.mirror;
      if (!m.pristine || m.running || m.special || !m.loadout?.toggleable) continue;
      if (projectForCwd(m.cwd)?.id !== pid) continue;
      await closeChat(h.path, "Applying the project's skills.");
      await acquireChatHandle(h.path).catch((err) => console.warn(`[project-skills] reopen after a change failed: ${err instanceof Error ? err.message : String(err)}`));
      n++;
    }
    return n;
  });
}
