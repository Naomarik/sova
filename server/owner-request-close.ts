import type { OwnerRequest, OwnerRequestBy } from "../shared/project-assistant";
import { acquireChatHandle } from "./chat-handle";
import { ownerPageInfo } from "./owner";
import { OrgError } from "./orgs";
import { closeRequestLine, featureChats, findRequest, reopenRequestLine } from "./project-assistant-store";
import { noteRequestChatTurn, trackRequestChat, withChats } from "./owner-request-chat";

/**
 * The owner closes and reopens their own requests (§app.project-assistant/closing), from their page or through their
 * assistant on their yes. Closing never stops the work: it records who closed it and the prior status, then (best
 * effort, each on its own) cancels a fix's start still waiting in a hold, ends a feature request's open planning
 * chat, and puts a note in the request's team chat. Reopening restores where it really stands.
 */

/** The note type of "the owner closed this request" in its team chat (a note that starts no turn). */
export const OWNER_REQUEST_CLOSED_NOTE = "sova-owner-request-closed";

const firstOf = (name: string): string => name.trim().split(/\s+/)[0] ?? name;

/** The note's words (§design.copy-deck/owner-page). */
export function closedNoteText(ownerName: string, by: OwnerRequestBy["kind"]): string {
  const who = firstOf(ownerName) || "The owner";
  return by === "assistant" ? `${who} closed this request through their Project Assistant. The team can stop on it.` : `${who} closed this request on their page. The team can stop on it.`;
}

/** What closing sets off; tests stand each one in. */
export interface CloseDeps {
  /** Cancel the request's fix start still waiting in a hold; how many were cancelled. */
  cancelHeldStart(projectId: string, requestId: string): Promise<number>;
  /** End the feature request chat (a gathering) the request opened. */
  endFeatureChat(orgId: string, sessionId: string): Promise<void>;
  /** Write a note that starts no turn in a chat; false when not written. */
  note(path: string, noteType: string, text: string, details: unknown): Promise<boolean>;
}

const defaultDeps: CloseDeps = {
  async cancelHeldStart(projectId, requestId) {
    const { cancelHeldForRequest } = await import("./project-holds");
    return cancelHeldForRequest(projectId, requestId);
  },
  async endFeatureChat(orgId, sessionId) {
    const { closeFeatureChatForRequest } = await import("./feature-chats");
    await closeFeatureChatForRequest(orgId, sessionId);
  },
  note: async (path, noteType, text, details) => (await acquireChatHandle(path)).appendNote(noteType, text, details),
};

let depsForTest: Partial<CloseDeps> | null = null;
export function setCloseDepsForTest(d: Partial<CloseDeps> | null): void {
  depsForTest = d;
}
const deps = (): CloseDeps => ({ ...defaultDeps, ...(depsForTest ?? {}) });

const warn = (rid: string, what: string) => (err: unknown) => console.warn(`[owner-request] ${rid}: ${what}: ${err instanceof Error ? err.message : String(err)}`);

/** The request's team chat that exists and isn't archived (the chat Start Chat linked, else a fix's coding session);
    never a feature request's planning chat, which is the owner's own. */
async function teamChat(r: OwnerRequest): Promise<{ sessionId: string; path: string } | null> {
  if (r.kind === "feature" && !r.linked) return null;
  const [w] = await withChats([r]);
  return w?.chat ? { sessionId: w.chat.sessionId, path: w.chat.path } : null;
}

/**
 * Close the owner's open requests (several at once): each must be open; all are checked before any is closed, so a
 * refusal changes nothing. Returns them as they read after.
 */
export async function closeOwnerRequests(orgId: string, ids: readonly string[], by: OwnerRequestBy): Promise<OwnerRequest[]> {
  const rs = ids.map((id) => {
    const r = findRequest(orgId, id);
    if (!r) throw new OrgError("Unknown request", 404);
    if (r.status !== "with-team" && r.status !== "started") throw new OrgError(`"${r.title}" is already closed.`, 409, "closed");
    return r;
  });
  const d = deps();
  const out: OwnerRequest[] = [];
  for (const r of rs) {
    const closed = closeRequestLine(orgId, r.id, by);
    out.push(closed);
    // A fix whose start still waits (held, q8): its start is cancelled. A fix already started goes on.
    if (r.kind === "fix" && r.status === "with-team") await d.cancelHeldStart(r.projectId, r.id).catch(warn(r.id, "cancelling its held start"));
    // A feature request's open planning chat ends with it (q9); it stays readable.
    if (r.kind === "feature")
      for (const c of featureChats(orgId).filter((x) => x.requestId === r.id && !x.ended)) await d.endFeatureChat(orgId, c.sessionId).catch(warn(r.id, "ending its feature request chat"));
    // The team's chat on it hears, quietly (a note, no turn).
    const chat = await teamChat(r).catch(() => null);
    if (chat) {
      const name = ownerPageInfo(orgId).person?.name ?? "The owner";
      await d
        .note(chat.path, OWNER_REQUEST_CLOSED_NOTE, closedNoteText(name, by.kind), { orgId, requestId: r.id, by: by.kind })
        .then((ok) => (ok ? undefined : warn(r.id, "its chat's note")(new Error("not written"))))
        .catch(warn(r.id, "its chat's note"));
    }
  }
  return out;
}

/**
 * Reopen a request the owner closed (§app.project-assistant/closing): `started` when it was closed while started and
 * its team chat still exists and isn't archived, else `with-team`. A chat Start Chat linked is tracked again, and a
 * turn the operator already had there makes it `started` now.
 */
export async function reopenOwnerRequest(orgId: string, id: string, by: OwnerRequestBy): Promise<OwnerRequest> {
  const r = findRequest(orgId, id);
  if (!r) throw new OrgError("Unknown request", 404);
  if (r.status !== "closed") throw new OrgError("Only a request you closed can be reopened.", 409, "not-yours");
  const chat = await teamChat(r).catch(() => null);
  const status = r.closed?.prior === "started" && chat ? "started" : "with-team";
  let after = reopenRequestLine(orgId, id, by, status);
  if (chat && after.linked?.sessionId === chat.sessionId) {
    trackRequestChat(chat.sessionId, { orgId, rid: id });
    if (status === "with-team" && (await noteRequestChatTurn(chat.path, { orgId, rid: id }).catch(() => false))) after = findRequest(orgId, id)!;
  }
  return after;
}

/**
 * The owner page's Close and Reopen (`POST /api/i/<token>/requests/<r_handle> {action}`): only the link's person while
 * they are the owner, only a request of a project shown on their page, by its page handle; anything else is a 404,
 * as a handle that never existed.
 */
export async function ownerRequestAction(orgId: string, personId: string, handle: string, action: unknown): Promise<OwnerRequest> {
  if (action !== "close" && action !== "reopen") throw new OrgError('action is "close" or "reopen".', 400, "bad-request");
  const { ownerOf, readProjects } = await import("./orgs");
  if (ownerOf(orgId)?.id !== personId) throw new OrgError("Not found", 404, "missing");
  const { handleOf } = await import("./person-links");
  const { orgRequests } = await import("./project-assistant-store");
  const shown = new Set(readProjects(orgId).filter((p) => !p.ownerHidden).map((p) => p.id));
  const r = orgRequests(orgId).find((x) => shown.has(x.projectId) && handleOf("r", x.id) === handle);
  if (!r) throw new OrgError("Not found", 404, "missing");
  const by: OwnerRequestBy = { kind: "owner", personId };
  if (action === "close") return (await closeOwnerRequests(orgId, [r.id], by))[0]!;
  return reopenOwnerRequest(orgId, r.id, by);
}
