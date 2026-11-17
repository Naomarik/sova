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

const sameSet = (a: readonly string[], b: readonly string[]) => a.length === b.length && [...a].sort().join("\0") === [...b].sort().join("\0");

/** Whether two rules build a new chat the same: the same mode, and asking first the same approved items (only they
    load), else the same disallowed ones (only they stay off). What the first-message re-check compares. */
export function sameRuleEffect(a: FolderRule, b: FolderRule): boolean {
  if (a.asking !== b.asking) return false;
  const kind = a.asking ? "approved" : "disallowed";
  return sameSet(a.context[kind], b.context[kind]) && sameSet(a.skills[kind], b.skills[kind]);
}
