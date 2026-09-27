// What Commit Now did, in the toast's words (§app.organizations/org-page, Workspace).

import type { CommitNowOutcome } from "../../shared/orgs";

export function commitNowWords(c: CommitNowOutcome | undefined): string {
  if (!c) return "Committed.";
  if (c.committed) return `Committed ${c.sha ?? ""}${c.pushed ? " and pushed" : ""}.`.replace(" .", ".");
  return c.pushed ? "Nothing new to commit. Pushed the commits the remote lacked." : "Nothing new to commit.";
}
