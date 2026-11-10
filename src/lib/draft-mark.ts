// The pencil before a session row's title: this session holds an unsent composer draft.

import type { SessionSummary } from "../../shared/protocol";

/** Whether a draft is one: non-blank text, at least one image, or a staged reply. The server's
    `draftCounts` (server/drafts.ts) is the same rule, so a row reads the same before and after a refresh. */
export function draftCounts(text: string, attachments: readonly unknown[], reply: unknown = null): boolean {
  return text.trim() !== "" || attachments.length > 0 || !!reply;
}

/**
 * Whether a row puts the draft pencil on line 1. `local` is this tab's own answer (undefined until
 * the tab has loaded or written that session's draft) and wins whenever it exists: the list is
 * refetched only now and then, and a send or a cleared composer must drop the pencil at once.
 * A never-sent session (`draftPreview`) never gets it — its line 2 already says it's a draft.
 */
export function showsDraftMark(
  summary: Pick<SessionSummary, "hasDraft" | "draftPreview">,
  local: boolean | undefined,
): boolean {
  if (summary.draftPreview !== undefined) return false;
  return local ?? summary.hasDraft === true;
}
