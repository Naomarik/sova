/**
 * Where a new conversation goes (§app.chat-homes/new-chats): a new chat into a home of its own while the Chat homes
 * switch is on, and every helper of a homed chat into its parent's home, at any depth. The parent's place decides, so a
 * chat is never split across layouts: a helper of a chat from before homes writes where that chat's helpers always have.
 */
import { dirname } from "node:path";
import type { WorkerSession } from "../../shared/chat-runtime";
import { createSessionFile, mintSessionId, type NewSessionFile } from "../harness/pi/state";
import { emitChatNews } from "../chat-home-events";
import { sessionsChanged } from "../list-generation";
import { chatHomesOn } from "../web-settings";
import { abandonNewHome, chatHome, ensureChatHome, hasHome, homeIdOfPath, homeSessionsDir, homesRoot, homesRootAvailable, isHomeSessionFile, noteHomeArrived } from "./root";
import { appendChange } from "./changes";

export interface NewChatPlace {
  id: string;
  sessionsDir: string;
}

/**
 * A new chat's id and conversations folder: its home, made now, while the switch is on; null (pi's folder for its cwd,
 * as before homes) while it is off. `id`: a caller that minted the chat's id already.
 */
export function newChatPlace(cwd: string, id?: string, on: boolean = chatHomesOn()): NewChatPlace | null {
  if (!on || !homesRootAvailable()) return null;
  const sid = id ?? mintSessionId(cwd);
  ensureChatHome(sid);
  return { id: sid, sessionsDir: homeSessionsDir(sid) };
}

/**
 * A new chat's session file (createSessionFile), in its own home while the switch is on. A home made for a file that
 * then fails is undone (abandonNewHome), so a refused or failed create leaves no empty home behind.
 */
export function createNewChatFile(opts: Omit<NewSessionFile, "sessionsDir">, on: boolean = chatHomesOn()): { path: string; id: string } {
  const place = newChatPlace(opts.cwd, opts.id, on);
  let made: { path: string; id: string };
  try {
    made = createSessionFile({ ...opts, ...(place ? { id: place.id, sessionsDir: place.sessionsDir } : {}) });
  } catch (err) {
    if (place) abandonNewHome(place.id);
    throw err;
  }
  if (place) homeBorn(place.id);
  return made;
}

/** A new chat's home now holds its conversation: `chat.created` on the event stream (§app.events/names). Once per home,
    never for a helper placed in its parent's home. */
function homeBorn(id: string): void {
  // Its conversation is new in the home: every reader of the homes is told (the change log).
  appendChange(homesRoot(), id, "sessions");
  emitChatNews({ name: "chat.created", chat: id, home: chatHome(id) });
}

/** A fork's file was written into its own home (newChatPlacer): announced like any new chat's. */
export function forkBorn(forkPath: string): void {
  const id = homeIdOfPath(forkPath);
  if (id && isHomeSessionFile(forkPath)) homeBorn(id);
}

/**
 * A home that arrived from outside (a Transport's publishing rename into the homes root): read now (its manifest must
 * already name this state root), listed at once, and announced. False when it isn't a home of this state root.
 */
export function registerArrivedHome(id: string): boolean {
  noteHomeArrived(id);
  if (!hasHome(id)) return false;
  sessionsChanged();
  homeBorn(id);
  return true;
}

/** For a fork: the folder for the fork's freshly minted id (its own home), or undefined while the switch is off. */
export function newChatPlacer(on: boolean = chatHomesOn()): ((id: string) => string) | undefined {
  if (!on || !homesRootAvailable()) return undefined;
  return (id) => {
    ensureChatHome(id);
    return homeSessionsDir(id);
  };
}

/**
 * A helper's session placed by its parent: a new, forked or seeded helper of a chat whose conversation is in a home
 * writes into that home's `sessions/`; a resume keeps its own file; anything else is left as asked. No syscall.
 */
export function placedByParent(session: WorkerSession, parentPath: string): WorkerSession {
  if (!isHomeSessionFile(parentPath)) return session;
  const dir = dirname(parentPath);
  if ("new" in session) return { new: { dir } };
  if ("fork" in session) return { fork: { from: session.fork.from, dir } };
  if ("seed" in session) return { seed: { dir, messages: session.seed.messages } };
  return session;
}
