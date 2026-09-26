// Delivery of a link message into a member session this host runs (§mesh.links/delivery, the
// receiving side). server/mesh/links.ts records the message in the member's link inbox, frames it
// with shared/link-message.ts `formatLinkMessage`, and calls `deliverLinkMessage`; everything from
// there to the agent is here and in `ChatSession.deliverToAgent`. It never throws: every refusal
// goes back to the sender as a result.
//
// Also the few in-process hooks the links runtime needs from the chat side, re-exported so
// server/mesh/ imports one module: the `links` chat frame (setLinksSource / notifyLinksChanged),
// the origin the `link` extension's flag carries (setLinkOrigin), and the local sender check
// (heldSessionPath).
import { existsSync } from "node:fs";
import type { LinkRefusal, PeerLinkMessageResult } from "../shared/mesh-links";
import { acquireChat, BusyError, heldChats } from "./chat-manager";
import { projectOverseerOfPath } from "./project-overseer-store";
import { getSessionSummary } from "./sessions-index";

export { notifyLinksChanged, setLinkOrigin, setLinksSource } from "./chat-manager";

const refused = (reason: LinkRefusal, message: string): PeerLinkMessageResult => ({ state: "refused", reason, message });

/** The runtime this server holds for a session id, as its path; null when none is held. */
export function heldSessionPath(sessionId: string): string | null {
  return heldChats().find((c) => c.session.sessionId === sessionId)?.path ?? null;
}

/**
 * Hand `framed` (the whole tagged message) to the member session at `path` (§mesh.links/delivery):
 * a session whose runtime isn't loaded is reopened first; idle → "started", busy or compacting →
 * "delivered". Refused, with the reason, for a session gone from disk, archived, open in a TUI,
 * written by another process recently (the busy rule), on a model the policy turned off, or an
 * Overseer, project-overseer or baton session — the same refusals as a prompt from the page.
 */
export async function deliverLinkMessage(path: string, framed: string): Promise<PeerLinkMessageResult> {
  try {
    if (!existsSync(path)) return refused("no-session", "That session's file is not on its host any more.");
    const s = await getSessionSummary(path);
    if (!s) return refused("no-session", "That session's file is not on its host any more.");
    if (s.overseer) return refused("special", "That is the Overseer's own conversation.");
    if (projectOverseerOfPath(path)) return refused("special", "That is a project overseer's own conversation.");
    if (s.baton) return refused("special", "That is a baton session: only its participants write in it.");
    if (s.workerSession) return refused("special", "That is a worker's session.");
    if (s.archived) return refused("archived", "That session is archived.");
    if (s.live) return refused("tui-live", `It is open in a terminal (pid ${s.live.pid}), so its host must not write to it.`);
    let chat;
    try {
      chat = await acquireChat(path);
    } catch (err) {
      return fromError(err);
    }
    // The file's own marker, for a special session the summary could not tell (a baton file whose
    // workspace moved, say): the runtime knows what it is.
    if (chat.special) return refused("special", "That is an Overseer, project-overseer or baton session.");
    // The model policy first, by itself: its `input` handler would swallow the message silently,
    // and it is the one refusal that says which switch to move.
    try {
      chat.assertModelAllowed();
    } catch (err) {
      return refused("model-off", err instanceof Error ? err.message : String(err));
    }
    try {
      return { state: chat.deliverToAgent(framed) };
    } catch (err) {
      return fromError(err);
    }
  } catch (err) {
    return refused("internal", err instanceof Error ? err.message : String(err));
  }
}

/** A refusal thrown by acquireChat or the chat's write guards: a TUI (busy) or another writer
    (recent, or a runtime reloaded under it). */
function fromError(err: unknown): PeerLinkMessageResult {
  const message = err instanceof Error ? err.message : String(err);
  if (err instanceof BusyError) return refused(err.code === "busy" ? "tui-live" : "busy", message);
  return refused("internal", message);
}
