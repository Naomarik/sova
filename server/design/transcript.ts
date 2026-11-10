// A design session that writes its page in its reply: the page belongs to the card, so a reader of
// the session's transcript sees a short line in its place.
import { DESIGN_PAGE_END, DESIGN_PAGE_START } from "../../pi-config/extensions/mode/design-guide.ts";
import type { TranscriptItem } from "../../shared/protocol";
import { withoutPages } from "./stream-decode";

/** The note a page between markers leaves behind. */
export const PAGE_NOTE = "\n(The page is on its card.)\n";

export function withoutDesignPages(rows: TranscriptItem[]): TranscriptItem[] {
  return rows.map((r) => {
    const text = (r as { text?: unknown }).text;
    if (typeof text !== "string" || !text.includes(DESIGN_PAGE_START)) return r;
    return { ...r, text: withoutPages(text, DESIGN_PAGE_START, DESIGN_PAGE_END, PAGE_NOTE) } as TranscriptItem;
  });
}
