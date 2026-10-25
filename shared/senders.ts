// Who sent a user message, when it wasn't the person at this keyboard: another session
// (§chat.profiles/delivery), the Overseer (§app.overseer/sent-marker, and its briefs) or a teammate
// in a shared session (§app.baton/attribution). Read only off the invisible sender markers, never
// off the message's text, so the transcript (src/components/Thread.tsx), the Timeline
// (src/lib/timeline.ts) and the counts of what the user typed (shared/row-counts.ts, server and
// client alike) can't drift apart. A marker may arrive before or after the row it names, so every
// reader resolves by id over the whole list. Pure; imports only the protocol and the profile header.

import { OVERSEER_BRIEF_PREFIX, type TranscriptItem } from "./protocol";
import { stripSessionHeader } from "./profiles";

/** A user message's sender, by its marker. `baton` with `by: "operator"` is the user's own. */
export type Sender =
  | { kind: "session"; sessionId: string; title: string; hop: number }
  | { kind: "overseer" }
  | { kind: "baton"; by: string };

/** A proactive "Brief me" prompt (the Overseer's), by its prefix: never the user's own words. */
export const isBriefText = (text: string | undefined): boolean => !!text && text.trimStart().startsWith(OVERSEER_BRIEF_PREFIX);
/** The brief's own words, without the prefix. */
export const briefBody = (text: string): string => text.trimStart().slice(OVERSEER_BRIEF_PREFIX.length).trim();

/** The entry a row id belongs to (`<entryId>:<i>` for a reply's later blocks). */
const entryOf = (rowId: string): string => {
  const i = rowId.indexOf(":");
  return i < 0 ? rowId : rowId.slice(0, i);
};

/** Target entry id → sender, from every sender marker in `items`, in either arrival order. When two
    markers name one row, another session wins over the Overseer, and the Overseer over a baton
    participant (the transcript's own precedence). */
export function sendersOf(items: readonly TranscriptItem[]): Map<string, Sender> {
  const rank = { session: 3, overseer: 2, baton: 1 } as const;
  const out = new Map<string, Sender>();
  const put = (id: string, s: Sender) => {
    const was = out.get(id);
    if (!was || rank[s.kind] > rank[was.kind]) out.set(id, s);
  };
  for (const it of items) {
    if (it.sessionMark?.kind === "sent") put(it.sessionMark.targetId, { kind: "session", ...it.sessionMark.from, hop: it.sessionMark.hop });
    if (it.overseerMark?.kind === "sent") put(it.overseerMark.targetId, { kind: "overseer" });
    if (it.batonMark?.kind === "sent") put(it.batonMark.targetId, { kind: "baton", by: it.batonMark.by });
  }
  return out;
}

/** The sender of the row `rowId`, when someone other than the user sent it; the user's own baton
    messages (`operator`) have none. */
export function otherSender(senders: ReadonlyMap<string, Sender>, rowId: string): Sender | undefined {
  const s = senders.get(entryOf(rowId));
  return s && !(s.kind === "baton" && s.by === "operator") ? s : undefined;
}

/** The row's sender for the views: a marker's, else the Overseer's for a brief. */
export function rowSender(row: Pick<TranscriptItem, "id" | "kind" | "text">, senders: ReadonlyMap<string, Sender>): Sender | undefined {
  return otherSender(senders, row.id) ?? (row.kind === "user" && isBriefText(row.text) ? { kind: "overseer" } : undefined);
}

/** What the user typed: a user row no marker names as someone else's, and never a brief. A wake
    nudge (kind "wake") and a link message aren't user rows, so they never are. */
export const isOwnInput = (row: Pick<TranscriptItem, "id" | "kind" | "text">, senders: ReadonlyMap<string, Sender>): boolean =>
  row.kind === "user" && !rowSender(row, senders);

/** The ids of the rows the user typed among `rows`, oldest first, judged by the markers in `rows`. */
export function ownInputIds(rows: readonly TranscriptItem[]): string[] {
  const senders = sendersOf(rows);
  return rows.filter((r) => isOwnInput(r, senders)).map((r) => r.id);
}

/** A message's body as the views show it: without another session's header line, or the brief tag. */
export function messageBody(text: string, sender: Sender | undefined, brief = false): string {
  if (sender?.kind === "session") return stripSessionHeader(text);
  if (brief) return briefBody(text);
  return text;
}
