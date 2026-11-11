import { readStoredCwd } from "./git-summary";
import { OrgError } from "./org-error";
import type { SettingsBy } from "../shared/project-settings";

/**
 * POST /api/sessions/approval (§chat.context-approval/mid-chat): Approve or Disallow, from a chat's "wasn't
 * loaded" line or its setup card, one context file or skill of the chat's folder, by its file. The decision is
 * saved in the folder's list through its one write (server/approvals.ts writeFolderApprovals, which also
 * rebuilds the folder's chats not yet started); an approval also joins a started asking chat's fixed list,
 * so the agent gets it at its next touch of that folder. Approving is the operator's page alone (the route
 * checks it); disallowing is open to every caller.
 */

export interface ApprovalInChatBody {
  path: string;
  kind: "context" | "skill";
  item: string;
  state: "approved" | "disallowed";
}

export function parseApprovalInChat(body: unknown): Omit<ApprovalInChatBody, "path"> {
  const b = (body ?? {}) as Record<string, unknown>;
  // A missing field: the whole body's shape; one present but wrong: its own sentence.
  if (b.kind === undefined || b.item === undefined || b.state === undefined)
    throw new OrgError('Expected { path, kind: "context" | "skill", item: <absolute path>, state: "approved" | "disallowed" }');
  if (b.kind !== "context" && b.kind !== "skill") throw new OrgError('kind must be "context" or "skill"');
  if (b.state !== "approved" && b.state !== "disallowed") throw new OrgError('state must be "approved" or "disallowed"');
  if (typeof b.item !== "string") throw new OrgError("item must be a string: the file's absolute path");
  if (!b.item.startsWith("/") || b.item.length > 4096) throw new OrgError("item must be an absolute path");
  return { kind: b.kind, item: b.item, state: b.state };
}

/** The decision saved, and whether the chat's own list took the item now. */
export async function approveInChat(sessionPath: string, body: unknown, by: SettingsBy = { kind: "operator", via: "page" }): Promise<{ key: string; loadedHere: boolean }> {
  const { kind, item, state } = parseApprovalInChat(body);
  const cwd = await readStoredCwd(sessionPath).catch(() => null);
  if (!cwd) throw new OrgError("This session file has no header to read its folder from.", 409);
  const approvals = await import("./approvals");
  const lookup = await approvals.approvalLookupForCwd(cwd);
  // Keyed where it sits (a linked SKILL.md or CLAUDE.md by its own place, never its target), as the folder's list is.
  const key = approvals.itemKey(lookup, approvals.placePath(item));
  const changes = { context: kind === "context" ? { [key]: state } : {}, skills: kind === "skill" ? { [key]: state } : {} };
  // A project's goes through its settings' one save, so its history line is written too.
  if (lookup.folder.kind === "project" && lookup.folder.projectId) await (await import("./project-settings")).setProjectApprovalStates(lookup.folder.projectId, changes, by);
  else await approvals.writeFolderApprovals(lookup.folder, changes);
  let loadedHere = false;
  if (state === "approved") {
    const { chatHandle } = await import("./chat-handle");
    const chat = chatHandle(sessionPath);
    if (chat) loadedHere = await chat.allowInLoadout(kind, item).catch(() => false);
    else loadedHere = await allowInFile(sessionPath, kind, item);
  }
  return { key, loadedHere };
}

/** A chat this server doesn't hold: opened for the write, as a card's switch does. */
async function allowInFile(sessionPath: string, kind: "context" | "skill", item: string): Promise<boolean> {
  try {
    const { acquireChatHandle } = await import("./chat-handle");
    const chat = await acquireChatHandle(sessionPath);
    return await chat.allowInLoadout(kind, item);
  } catch {
    return false;
  }
}
