// What Commit Now did, in the toast's words (§app.organizations/org-page, Workspace).

import type { CommitNowOutcome } from "../../shared/orgs";

export function commitNowWords(c: CommitNowOutcome | undefined): string {
  if (!c) return "Committed.";
  if (c.committed) return `Committed ${c.sha ?? ""}${c.pushed ? " and pushed" : ""}.`.replace(" .", ".");
  return c.pushed ? "Nothing new to commit. Pushed the commits the remote lacked." : "Nothing new to commit.";
}

/** What Reload says (the Workspace problem banner's action): cleared, or how much is still wrong. */
export const reloadWords = (remaining: number): string =>
  remaining === 0 ? "Reloaded. Everything in the workspace loads now." : `Reloaded. ${remaining === 1 ? "1 problem remains" : `${remaining} problems remain`}: fix or restore it, then reload again.`;
