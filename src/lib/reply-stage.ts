// Staging a reply (§chat.transcript/reply, §chat.composer/replying): what a message's Reply puts in
// the composer, and what comes back staged when a sent reply returns to the box (a Rewind, Stop's
// hand-back, a refused send). The decisions are pure; readSelection is the one DOM read, kept to
// facts so passageOf can be tested without a browser.

import { capQuote, type ReplyRole, type StagedReply } from "../../shared/reply-quote";
import { entryIdOf } from "./jump";

/** The staged strip's line for a quote over the cap (§chat.composer/reply-text). */
export const REPLY_TRIMMED_NOTE = "Long message: the model gets its start and end. Select a passage to quote just that.";
/** Said when Remove Reply takes the staged reply off. */
export const REPLY_REMOVED = "Reply removed.";
/** A quote whose original left the conversation (rewound away): its note, and what is announced. */
export const REPLY_GONE = "That message is no longer in this conversation.";

/** Where a selection's two ends sit: the entry each end's row belongs to, and whether that end is in
    a message's own text (not its head, its quote, its actions, a tool card or thinking). */
export interface SelectionFacts {
  text: string;
  ends: readonly { entryId: string | null; inText: boolean }[];
}

/** The selected passage when both ends are in this entry's text, else null (the whole message is quoted). */
export function passageOf(sel: SelectionFacts | null, entryId: string): string | null {
  if (!sel || !sel.text.trim() || sel.ends.length === 0) return null;
  return sel.ends.every((e) => e.entryId === entryId && e.inText) ? sel.text : null;
}

/** The reply a strip's Reply stages: the passage when there is one, else the whole message (the
    strip's text is a reply's markdown source, or your message's words without a quote of its own).
    Null when there is nothing to quote. */
export function replyFrom(strip: { entryId: string; role: ReplyRole; text: string }, passage: string | null): StagedReply | null {
  const { quote, trimmed } = capQuote(passage ?? strip.text);
  if (!quote.trim()) return null;
  return { entryId: strip.entryId, role: strip.role, part: passage !== null, quote, trimmed };
}

/** The document's selection as facts, or null when nothing is selected. */
export function readSelection(): SelectionFacts | null {
  const s = typeof window === "undefined" ? null : window.getSelection();
  if (!s || s.isCollapsed || s.rangeCount === 0) return null;
  const end = (n: Node | null) => {
    const el = n instanceof Element ? n : (n?.parentElement ?? null);
    const row = el?.closest<HTMLElement>(".entry[data-entry]");
    const inText = !!el?.closest("article.message") && !el.closest(".message-head, .message-reply-quote, .message-actions");
    return { entryId: row?.dataset.entry ? entryIdOf(row.dataset.entry) : null, inText };
  };
  return { text: s.toString(), ends: [end(s.anchorNode), end(s.focusNode)] };
}
