// What the transcript's complete-list readers count, as one rule for both sides: the frontend
// counts the rows it holds (src/lib/turn.ts `isInput`, src/lib/message-count.ts), and the server
// counts the rows it didn't send with a newest-rows-first hello (server/tail-hello.ts
// `olderSummary`), so the two add up to the count of the whole branch. Imports nothing at runtime.

import type { AlignDocInfo, OlderSummary, TranscriptItem } from "./protocol";

/** The user's inputs: a user row or a wake nudge (src/lib/turn.ts says why a link message isn't). */
export const isInput = (row: Pick<TranscriptItem, "kind">): boolean => row.kind === "user" || row.kind === "wake";

/** The entry behind a row id: an assistant reply's blocks are `<entryId>:<i>` (and `:stop`). */
export const entryOfRow = (rowId: string): string => {
  const i = rowId.indexOf(":");
  return i < 0 ? rowId : rowId.slice(0, i);
};

/** The kinds a rendered row can belong to that ARE messages (a user's, a nudge's, a reply's). */
const MESSAGE_KINDS: ReadonlySet<TranscriptItem["kind"]> = new Set(["user", "wake", "link", "assistant-text", "thinking", "tool-call"]);

/** Distinct entries behind message rows: one multi-block reply is one message (src/lib/message-count.ts). */
export const messageCount = (items: readonly TranscriptItem[]): number =>
  new Set(items.filter((it) => MESSAGE_KINDS.has(it.kind)).map((it) => entryOfRow(it.id))).size;

/** A row of a reply the model wrote. */
export const isReplyRow = (row: Pick<TranscriptItem, "kind">): boolean => row.kind === "assistant-text" || row.kind === "tool-call";

/** What the complete-list readers need to know of `rows`, the rows a client doesn't hold. */
export function summarize(rows: readonly TranscriptItem[]): OlderSummary {
  const aligns = openAligns(rows);
  return { inputs: rows.filter(isInput).map((r) => r.id), messages: messageCount(rows), replies: rows.some(isReplyRow), ...(aligns.length ? { aligns } : {}) };
}

/** The alignments still open in `rows`: the newest revision per document id, in the order they
    were last touched (the fold of src/lib/align.ts `foldAlignRows`), without the done and dropped. */
export function openAligns(rows: readonly TranscriptItem[]): NonNullable<OlderSummary["aligns"]> {
  const docs = new Map<string, { doc: AlignDocInfo; rowId: string }>();
  for (const it of rows) {
    const doc = it.kind === "align" ? it.align?.doc : undefined;
    if (!doc) continue;
    docs.delete(doc.id);
    docs.set(doc.id, { doc, rowId: it.id });
  }
  return [...docs.values()].filter((e) => e.doc.phase !== "done" && e.doc.phase !== "dropped");
}
