// The server's side of the project mode approval store (§chat.mode-menu/project-modes). The store itself is
// pi-config/extensions/mode/project-tools-approval.ts (one file in Sova's state root, outside every
// repository, keyed by the checkout's real path and the mode id, holding approved toolsHashes); the mode
// extension checks it when a mode with tools is turned on, and this module reads and writes the same file
// at the server's agent root, so both always agree on where it is.
//
// The menu asks `isApproved` to mark a mode needsApproval; the user's approve, and an Overseer turn-on (q7),
// call `recordApproval` BEFORE the chat's `/mode project:<id> on`, which checks the store itself.
import {
  approvalsFile as storeFile,
  isApproved as storeIsApproved,
  projectKey,
  recordApproval as storeRecord,
  readApprovals,
  type ApprovalBy,
  type ApprovalRecord,
} from "../pi-config/extensions/mode/project-tools-approval.ts";
import { agentRoot } from "./state-root";

export type { ApprovalBy, ApprovalRecord };

/** The store's file for this server: the same path the chats' mode extension reads. Read per call. */
export const approvalsFile = (): string => storeFile(process.env, agentRoot());

/** Whether this exact tool set of a checkout's mode is approved; always for a mode with no tools (""). */
export function isApproved(checkoutRoot: string, modeId: string, toolsHash: string): boolean {
  return storeIsApproved(checkoutRoot, modeId, toolsHash, approvalsFile());
}

/** Record an approval (the user's, or an Overseer turn-on's). Throws when it can't be stored. */
export function recordApproval(checkoutRoot: string, modeId: string, toolsHash: string, by: ApprovalBy): void {
  storeRecord(checkoutRoot, modeId, toolsHash, by, approvalsFile());
}

/** The approvals recorded for one checkout's mode, newest first (empty when none). */
export function approvalsOf(checkoutRoot: string, modeId: string): ApprovalRecord[] {
  return readApprovals(approvalsFile()).approvals[projectKey(checkoutRoot)]?.[modeId] ?? [];
}
