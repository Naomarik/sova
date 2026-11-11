/**
 * A folder's context file and skill decisions as one chat reads them, by absolute path in that chat's
 * checkout: what the server reads for a chat before its first message (server/projects/folder-rule.ts)
 * and sends its chat process with each open. `asking`: the Sova-wide "Allow context files and skills
 * without asking" switch is off, so an item with no decision (Waiting) stays off. Without it, only
 * disallowed items are off.
 */
export interface FolderRule {
  asking: boolean;
  context: { approved: string[]; disallowed: string[] };
  skills: { approved: string[]; disallowed: string[] };
}

/** No decisions, the default mode: everything on. */
export const OPEN_RULE: FolderRule = { asking: false, context: { approved: [], disallowed: [] }, skills: { approved: [], disallowed: [] } };
