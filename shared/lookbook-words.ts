// How a message in a Lookbook helper's chat reads (the Creative Director's, or a design's): the
// person's own words as theirs, with where they wrote them, and whatever Sova added around them
// folded under one "Sova's note". What the models receive is never changed: this only reads it.
// The server sets it on the row (TranscriptItem.lookbook); the page draws it and parses nothing.
// Pure, no DOM: the server imports it.
import type { DesignHistoryItem } from "./design";

/** How the Creative Director is told where a person's words came from (server/design/coordinator.ts
    userWords). The pairing is pinned by a round-trip test there. */
export const LOOKBOOK_USER_LABEL = {
  box: "The user wrote in your box",
  main: "The main chat passed this on from the user, word for word",
  card: "The user wrote on the Design Brief",
  setup: "The user wrote on the Setup card",
} as const;

export type LookbookWhere = keyof typeof LOOKBOOK_USER_LABEL | "chat" | "refine";

/** One message in a Lookbook helper's chat, as it reads. */
export interface LookbookRow {
  /** you: a person's words; coordinator: the Creative Director's message to a design; sova: Sova's
      message alone; brief: a designer's first message (the brief it works from). */
  from: "you" | "coordinator" | "sova" | "brief";
  /** you: where the words were written. */
  where?: LookbookWhere;
  /** The words exactly as written (you, coordinator). */
  words?: string;
  /** What Sova added around the words, or Sova's whole message, or the brief: drawn folded. */
  note?: string;
  /** sova: the note is Sova sending a page back to be fixed. */
  fix?: true;
}

/** The line a person's words carry, saying where they wrote them. */
export const LOOKBOOK_WHERE_LINE: Record<LookbookWhere, string> = {
  box: "In the Creative Director's box",
  card: "On the brief",
  setup: "On the Setup card",
  main: "Passed on by the main chat",
  chat: "In its chat",
  refine: "Refine",
};

const LABEL_OF = new Map<string, keyof typeof LOOKBOOK_USER_LABEL>(Object.entries(LOOKBOOK_USER_LABEL).map(([k, v]) => [v, k as keyof typeof LOOKBOOK_USER_LABEL]));
const OPEN = /(^|\n)(The user wrote in your box|The main chat passed this on from the user, word for word|The user wrote on the Design Brief|The user wrote on the Setup card):\n<<<(u-[0-9a-f]{12})\n/g;
const PLACEHOLDER = "(Your words, shown above.)";

/** A message to the Creative Director: every fenced run of a person's words (only the exact labels
    Sova writes, with a matching open and close mark), and the rest as Sova's note. With no words in
    it, the whole message is Sova's. */
export function coordinatorMessageRow(text: string): LookbookRow {
  const spans: { start: number; end: number; where: keyof typeof LOOKBOOK_USER_LABEL; words: string }[] = [];
  OPEN.lastIndex = 0;
  for (let m = OPEN.exec(text); m; m = OPEN.exec(text)) {
    const start = m.index + m[1]!.length;
    const body = OPEN.lastIndex;
    const close = text.indexOf(`\n${m[3]}>>>`, body - 1);
    if (close < 0) continue;
    spans.push({ start, end: close + m[3]!.length + 4, where: LABEL_OF.get(m[2]!)!, words: text.slice(body, close) });
    OPEN.lastIndex = close + m[3]!.length + 4;
  }
  if (!spans.length) return { from: "sova", note: text.trim() };
  let note = "";
  let at = 0;
  spans.forEach((s, i) => {
    note += text.slice(at, s.start);
    // Sova's text on both sides of the words: say where they were.
    if (note.trim() && (i < spans.length - 1 || text.slice(s.end).trim())) note += PLACEHOLDER;
    at = s.end;
  });
  note = (note + text.slice(at)).trim();
  return { from: "you", where: spans[0]!.where, words: spans.map((s) => s.words).join("\n\n"), ...(note ? { note } : {}) };
}

/** A message a design was sent, as the history recorded it (shared/design.ts DesignHistoryItem). */
export interface LookbookSend {
  by: "user" | "coordinator" | "main" | "server";
  via?: string;
  text?: string;
}

const REFINE = /^Refine your page\.\n\n([\s\S]*?)\n\n(Open it with design_look at desktop and at phone width[\s\S]*)$/;
const FIX = /^Your page didn't land, so nobody can see it yet \(fix /;
const FRESH = "This is your page so far, as you last delivered it:\n\n";
const PARENT = /(^|\n\n)Design ([A-Z]+), a page to draw from:\n\n/g;
const OUTLINE = "\n\nOutline of the existing screen (";

/** A designer's first message without the pages it draws from: their code is never shown, only which. */
export function briefWithoutPages(text: string): string {
  const firstPage = text.search(/(^|\n\n)Design [A-Z]+, a page to draw from:\n\n/);
  if (firstPage < 0) return text;
  const head = text.slice(0, firstPage);
  const tail = text.indexOf(OUTLINE, firstPage);
  const labels: string[] = [];
  PARENT.lastIndex = 0;
  for (let m = PARENT.exec(text); m && (tail < 0 || m.index < tail); m = PARENT.exec(text)) labels.push(m[2]!);
  return `${head}${head ? "\n\n" : ""}Made from ${labels.join(" and ")}: ${labels.length === 1 ? "its page" : "their pages"} went with this message.${tail >= 0 ? text.slice(tail) : ""}`;
}

/**
 * A message in a design's own chat. Its first message is the brief. Refine's and Sova's fix requests
 * have Sova's own shapes; any other message is told apart by who sent it (`sends`, the history's
 * messages to this design, matched on their exact words and used once each). One that can't be told
 * reads as it always did (null).
 */
export function designMessageRow(text: string, ctx: { first: boolean; sends: LookbookSend[] }): LookbookRow | null {
  if (text.startsWith(FRESH)) {
    // A fresh session from the stored page: the page, then the message that started it.
    const end = text.toLowerCase().lastIndexOf("</html>");
    const rest = end < 0 ? "" : text.slice(end + "</html>".length).trim();
    const note = "Its page so far went with this message, so the fresh session carries on from it.";
    const inner = rest ? designMessageRow(rest, { first: false, sends: ctx.sends }) : null;
    if (!inner) return rest ? { from: "sova", note: `${note}\n\n${rest}` } : { from: "sova", note };
    return { ...inner, note: inner.note ? `${note}\n\n${inner.note}` : note };
  }
  if (ctx.first) return { from: "brief", note: briefWithoutPages(text) };
  const refine = REFINE.exec(text);
  if (refine) return { from: "you", where: "refine", words: refine[1]!, note: `Refine your page.\n\n${refine[2]!}` };
  if (FIX.test(text)) return { from: "sova", fix: true, note: text };
  const i = ctx.sends.findIndex((s) => s.text === text);
  if (i < 0) return null;
  const [s] = ctx.sends.splice(i, 1);
  if (s!.by === "coordinator") return { from: "coordinator", words: text };
  if (s!.by === "server") return { from: "sova", ...(s!.via === "fix" ? { fix: true as const } : {}), note: text };
  return { from: "you", where: s!.by === "main" ? "main" : "chat", words: text };
}

/** One item of a Lookbook's history drawn among the Creative Director's messages (src/lib/lookbook-history.ts). The
    page makes these rows itself from GET /api/design/history; they never come over a session's socket. */
export interface LookbookHistoryRow {
  item: DesignHistoryItem;
  /** prompt: the revision before it in the same run, for what changed. */
  prev?: string;
}
