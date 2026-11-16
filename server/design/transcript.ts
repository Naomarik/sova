// A design session that writes its page in its reply: the page belongs to the card, so a reader of
// the session's transcript sees a short line in its place.
import { DESIGN_PAGE_END, DESIGN_PAGE_START } from "../../pi-config/extensions/mode/design-guide.ts";
import type { TranscriptItem } from "../../shared/protocol";
import { coordinatorMessageRow, designMessageRow, type LookbookSend } from "../../shared/lookbook-words";
import { readHistory } from "./history";
import { designChatDeleted, designSessions, readDesigns } from "./store";
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

// ---- a Lookbook helper's chat, as it reads ------------------------------------------------------

/** A session file the Lookbook keeps: its Creative Director's, or one design's. */
export type LookbookSession = { sessionId: string; kind: "coordinator" } | { sessionId: string; kind: "design"; label: string };

/** Which Lookbook helper a session file belongs to, by the chats' stores: only the files they name. */
export function lookbookSessionOf(path: string): LookbookSession | null {
  for (const sessionId of designSessions()) {
    if (designChatDeleted(sessionId)) continue;
    const s = readDesigns(sessionId);
    if (s.coordinator?.sessionFile === path) return { sessionId, kind: "coordinator" };
    const d = s.designs.find((x) => x.sessionFile === path);
    if (d) return { sessionId, kind: "design", label: d.label };
  }
  return null;
}

type Normalize = (text: string, part: "snapshot" | "append") => TranscriptItem[];

/**
 * A Lookbook helper's rows: each message it was given carries how it reads (`lookbook`, shared/lookbook-words.ts):
 * the person's words with where they wrote them, Sova's additions folded, a designer's first message as the brief.
 * One per tail: it counts the messages it has seen, and which of the history's sends they matched.
 */
export function lookbookNormalize(base: Normalize, s: LookbookSession, sends: (s: LookbookSession) => (LookbookSend & { id: string })[] = historySends): Normalize {
  let seen = 0;
  let used = new Set<string>();
  return (text, part) => {
    const rows = base(text, part);
    if (part === "snapshot") {
      seen = 0;
      used = new Set();
    }
    let left: (LookbookSend & { id: string })[] | null = null;
    return rows.map((r) => {
      if (r.kind !== "user" || typeof r.text !== "string") return r;
      const first = seen++ === 0;
      if (s.kind === "coordinator") return { ...r, lookbook: coordinatorMessageRow(r.text) };
      left ??= sends(s).filter((x) => !used.has(x.id));
      const before = new Set(left.map((x) => x.id));
      const row = designMessageRow(r.text, { first, sends: left });
      for (const id of before) if (!left.some((x) => x.id === id)) used.add(id);
      return row ? { ...r, lookbook: row } : r;
    });
  };
}

/** The messages the history says this design was given, oldest first. */
function historySends(s: LookbookSession): (LookbookSend & { id: string })[] {
  if (s.kind !== "design") return [];
  return readHistory(s.sessionId).items.flatMap((i) => (i.kind === "message" && i.label === s.label ? [{ id: i.id, by: i.by, ...(i.via ? { via: i.via } : {}), ...(i.text !== undefined ? { text: i.text } : {}) }] : []));
}
