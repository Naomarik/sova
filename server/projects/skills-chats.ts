import { acquireChatHandle, chatHandles, closeChat } from "../chat-handle";
import { inLoadoutOrder } from "../session-setup";

/**
 * After a folder's context file and skill decisions change (server/approvals.ts's one write), or the Sova-wide
 * "New context files and skills start on" setting (every folder): each chat of the folder this server holds that
 * is still before its first message, idle and switchable (its setup card's window), is rebuilt so it starts with
 * them; a started chat is never rebuilt (its list was fixed at its first message). Every pane of the folder's
 * chats is told to re-read its setup (`setup_changed`). Runs in the setup card's own order, so a card's switch
 * and this never interleave.
 *
 * Coalesced: a request made while a refresh runs (or waits to start) joins the next one, which starts after it
 * and reads the decisions as they are then, so a burst of saves rebuilds a waiting chat once, after the last.
 * A request that changes no item's on/off (`rebuild: false`: a New item left off, a change accepted) only tells
 * the panes. Each caller's promise settles once the refresh that covers its change is done.
 */
export function refreshFolderChats(folderKey: string | null, opts: { rebuild?: boolean } = {}): Promise<number> {
  const rebuild = opts.rebuild ?? true;
  if (!next) {
    const ask: Pending = { folders: new Map(), run: Promise.resolve(0) };
    next = ask;
    ask.run = inLoadoutOrder(async () => {
      if (GATHER.ms > 0) await new Promise((r) => setTimeout(r, GATHER.ms));
      // From here on a new request waits for the refresh after this one: this one may have read its folders already.
      if (next === ask) next = null;
      return refreshNow(ask.folders);
    });
  }
  const key = folderKey ?? ALL;
  next.folders.set(key, (next.folders.get(key) ?? false) || rebuild);
  return next.run;
}

/** How long a refresh waits before it reads the decisions, so the saves of one burst share it (tests set 0). */
export const GATHER = { ms: 120 };

const ALL = "\0all";
interface Pending {
  /** By folder key (ALL: every folder): whether any request for it changed an item's on/off. */
  folders: Map<string, boolean>;
  run: Promise<number>;
}
/** The refresh that hasn't started reading yet: the one a new request joins. */
let next: Pending | null = null;

async function refreshNow(folders: Map<string, boolean>): Promise<number> {
  const { folderForCwd } = await import("../approvals");
  const keyOf = (cwd: string): string | null => {
    try {
      return folderForCwd(cwd).key;
    } catch {
      return null;
    }
  };
  /** Whether the folder of `cwd` was asked for, and whether its chats are rebuilt; null: not asked for. */
  const asked = (cwd: string): boolean | null => {
    const all = folders.get(ALL);
    const k = folders.size > (all === undefined ? 0 : 1) ? keyOf(cwd) : null;
    const own = k !== null ? folders.get(k) : undefined;
    if (all === undefined && own === undefined) return null;
    return !!all || !!own;
  };
  let n = 0;
  for (const h of chatHandles()) {
    const m = h.mirror;
    if (m.special || asked(m.cwd) !== true) continue;
    if (m.pristine && !m.running && m.loadout?.toggleable) {
      await closeChat(h.path, "Applying the context files and skills.");
      await acquireChatHandle(h.path).catch((err) => console.warn(`[approvals] reopen after a change failed: ${err instanceof Error ? err.message : String(err)}`));
      n++;
    }
  }
  // Told after the rebuilds, to whichever panes are attached by then (a rebuilt chat's panes also re-read at hello).
  for (const h of chatHandles()) if (!h.mirror.special && asked(h.mirror.cwd) !== null) (h as { pushSetupChanged?: () => void }).pushSetupChanged?.();
  return n;
}

/** A project's chats (by its id): refreshFolderChats for its folder. */
export const refreshNewChats = (pid: string): Promise<number> => refreshFolderChats(`p:${pid}`);

/** After a folder's list changes, or the Sova-wide setting (null: every folder): its chats not yet started start with
    it (`rebuild: false`: nothing's on/off changed, so they are only told to read again). */
export async function notifySetupChanged(folderKey: string | null, opts: { rebuild?: boolean } = {}): Promise<void> {
  await refreshFolderChats(folderKey, opts);
}
